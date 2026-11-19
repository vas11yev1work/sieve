/**
 * Inbox server: PRs waiting for your review, Sieve runs of them, and headless reviews
 * (`claude -p "/sieve:review <url>"`) started from the page.
 */
import { Hono } from 'hono';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { InboxData, InboxJob, InboxPr, InboxReviewer, RunUsage, Settings } from '../shared/types.ts';
import { loadSettings, SIEVE_HOME } from '../cli/lib/settings.ts';
import { allReviewers, loadReviewers } from '../cli/lib/reviewers.ts';
import {
  applyInboxState,
  checkoutOf,
  fetchInbox,
  inboxSettings,
  loadInboxState,
  localRuns,
  saveInboxState,
  turnOf,
} from '../cli/lib/inbox.ts';
import { paths, writeJson } from '../cli/lib/run.ts';
import { runClaude } from './claude.ts';
import { ensureUi, openBrowser, staticUi } from './index.ts';

const SIEVE_ROOT = resolve(dirname(import.meta.path), '..');

/** Extra tools that the reviewers to run ask for (`tools:` in their frontmatter) — granted to the headless run. */
function reviewerTools(checkout?: string, only?: string[]): string[] {
  if (!checkout) return [];
  try {
    return [...new Set(loadReviewers(SIEVE_ROOT, checkout, loadSettings(checkout), only).flatMap((r) => r.tools))];
  } catch {
    return [];
  }
}

type GitHubRows = Awaited<ReturnType<typeof fetchInbox>>;

/** GitHub rows + what is on disk + running jobs → what the page shows. */
export async function inboxData(
  s: Settings,
  jobs: Map<string, InboxJob>,
  gh?: GitHubRows,
  error?: string,
): Promise<InboxData> {
  if (!gh && !error) {
    try {
      gh = await fetchInbox(s.inbox);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const all: InboxPr[] = [];
  for (const p of gh?.prs || []) {
    const job = jobs.get(p.url);
    const runs = localRuns(p);
    const turn = turnOf({ ...p, job, runs });
    if (!turn) continue;
    all.push({ ...p, checkout: checkoutOf(s.inbox, p.owner, p.repo), runs, job, ...turn });
  }
  const state = loadInboxState();
  const { shown, snoozed, expired } = applyInboxState(all, state);
  // Snoozed PRs are a group of their own, at the end.
  const prs = [
    ...shown,
    ...all
      .filter((p) => snoozed.includes(p.url))
      .map((p) => ({ ...p, turn: 'snoozed' as const, why: 'snoozed' as const })),
  ];
  if (expired.length) {
    for (const url of expired) delete state.snoozed[url];
    saveInboxState(state);
  }
  return {
    enabled: s.inbox.enabled,
    viewer: gh?.viewer,
    query: gh?.query,
    fetchedAt: new Date().toISOString(),
    error: error || gh?.warning,
    reportLanguage: s.reportLanguage,
    commentLanguage: s.commentLanguage,
    prs,
  };
}

// Bash commands of the review skill → pipeline phase.
const PHASES: [RegExp, InboxJob['phase']][] = [
  [/sieve\.ts"?\s+prepare\b/, 'prepare'],
  [/sieve\.ts"?\s+candidates\b/, 'validate'],
  [/sieve\.ts"?\s+finalize\b/, 'finalize'],
];

/**
 * Follow the orchestrator's stream-json: its Bash calls give the phase, its Task calls the agents,
 * task notifications what each agent took. Events of subagents (parent_tool_use_id set) are ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped claude stream-json events
export function trackJob(job: InboxJob, ev: any, now = new Date().toISOString()) {
  if (ev.parent_tool_use_id) return;
  const was = job.phase;
  if (ev.type === 'system' && ev.subtype === 'task_notification') {
    const a = job.agents.find((x) => x.id === ev.tool_use_id);
    if (a) {
      a.done = true;
      const u = ev.usage || {};
      a.usage = { tokens: u.total_tokens || 0, toolUses: u.tool_uses || 0, durationMs: u.duration_ms || 0 };
    }
  }
  for (const c of ev.message?.content || []) {
    if (ev.type === 'assistant' && c.type === 'tool_use') {
      const name = String(c.name);
      if (name === 'Bash') {
        const cmd = String(c.input?.command || '');
        for (const [re, phase] of PHASES) if (re.test(cmd)) job.phase = phase;
      } else if (name === 'Task' || name === 'Agent') {
        const label = String(c.input?.description || 'agent').replace(/^Sieve:\s*/i, '');
        const phase = label === 'map' ? 'map' : /^validate\b/i.test(label) ? 'validate' : 'review';
        if (phase === 'review' && job.phase === 'prepare') job.phase = 'review';
        job.agents.push({ id: c.id, name: label.replace(/^validate\s+/i, ''), phase, done: false });
      }
    } else if (ev.type === 'user' && c.type === 'tool_result') {
      const a = job.agents.find((x) => x.id === c.tool_use_id);
      const r = ev.tool_use_result;
      // An agent started in the background only says it started; it reports in a task notification.
      if (a && r?.status !== 'async_launched') {
        a.done = true;
        if (r?.totalTokens != null)
          a.usage = { tokens: r.totalTokens, toolUses: r.totalToolUseCount || 0, durationMs: r.totalDurationMs || 0 };
      }
      const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
      const m = text.match(/"runDir":\s*"((?:[^"\\]|\\.)+)"/);
      if (m && !job.runDir) job.runDir = JSON.parse(`"${m[1]}"`);
    }
  }
  if (job.phase !== was) (job.phaseAt ??= {})[job.phase] ??= now;
}

/** A finished job + its last `result` event (totals over the whole session) → usage.json. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped claude stream-json events
export function runUsage(job: InboxJob, result: any, orchestrator: number): RunUsage {
  const end = job.finishedAt!;
  const marks = Object.entries(job.phaseAt || {})
    .filter(([p]) => p !== 'queued' && p !== 'done')
    .sort((a, b) => a[1].localeCompare(b[1]));
  const phases: RunUsage['phases'] = {};
  marks.forEach(([p, at], k) => {
    phases[p as keyof RunUsage['phases']] = Date.parse(marks[k + 1]?.[1] ?? end) - Date.parse(at);
  });
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped claude stream-json events
  for (const m of Object.values<any>(result?.modelUsage || {})) {
    total.input += m.inputTokens || 0;
    total.output += m.outputTokens || 0;
    total.cacheRead += m.cacheReadInputTokens || 0;
    total.cacheWrite += m.cacheCreationInputTokens || 0;
  }
  return {
    durationMs: Date.parse(end) - Date.parse(job.startedAt!),
    phases,
    orchestrator,
    agents: job.agents.flatMap((a) => (a.usage ? [{ name: a.name, phase: a.phase, ...a.usage }] : [])),
    total,
    costUsd: result?.total_cost_usd,
  };
}

export interface InboxServerOptions {
  sieveRoot: string;
  port: number;
  open?: boolean;
}

export function createInboxApp(o: InboxServerOptions) {
  const jobs = new Map<string, InboxJob>();
  const aborts = new Map<string, AbortController>();
  const force = new Set<string>();
  /** Reviewers picked on the page for a queued job (`--only`); none = the enabled ones. */
  const picks = new Map<string, string[]>();
  let gh: { at: number; rows?: GitHubRows; error?: string } | null = null;
  /** Languages picked on the page without "save as default": this page only. */
  let lang: { reportLanguage?: string; commentLanguage?: string } = {};
  const settings = () => ({ ...inboxSettings(), ...lang });

  async function data(refresh: boolean) {
    const s = settings();
    if (!s.inbox.enabled)
      return {
        enabled: false,
        reportLanguage: s.reportLanguage,
        commentLanguage: s.commentLanguage,
        prs: [],
      } as InboxData;
    // ponytail: GitHub is asked at most once a minute unless the user refreshes; polling reads the cache
    if (refresh || !gh || Date.now() - gh.at > 60_000) {
      try {
        gh = { at: Date.now(), rows: await fetchInbox(s.inbox) };
      } catch (e) {
        gh = { at: Date.now(), rows: gh?.rows, error: (e as Error).message };
      }
    }
    return inboxData(s, jobs, gh.rows, gh.error);
  }

  // ponytail: one review at a time — each one already runs 4+ agents in parallel; add a setting if a queue is too slow
  async function pump() {
    if ([...jobs.values()].some((j) => j.state === 'running')) return;
    const job = [...jobs.values()].find((j) => j.state === 'queued');
    if (!job) return;
    job.state = 'running';
    job.phase = 'prepare';
    job.startedAt = new Date().toISOString();
    job.phaseAt = { prepare: job.startedAt };
    const ac = new AbortController();
    aborts.set(job.url, ac);

    const pr = gh?.rows?.prs.find((p) => p.url === job.url);
    const checkout = pr && checkoutOf(settings().inbox, pr.owner, pr.repo);
    // Without a checkout the skill clones the repo into ~/.sieve/repos.
    const cwd = checkout || SIEVE_HOME;
    mkdirSync(join(SIEVE_HOME, 'logs'), { recursive: true });
    job.log = join(SIEVE_HOME, 'logs', `inbox-${pr ? `${pr.owner}-${pr.repo}-${pr.number}` : Date.now()}.jsonl`);
    const only = picks.get(job.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped claude stream-json events
    let result: any;
    let orchestrator = 0;
    try {
      const res = await runClaude({
        cwd,
        prompt: `/sieve:review ${job.url}${force.has(job.url) ? ' --force' : ''}${only ? ` --only ${only.join(',')}` : ''}`,
        tools: 'all',
        allowedTools: [
          'Bash(bun:*)',
          'Bash(realpath:*)',
          'Bash(gh:*)',
          'Bash(git:*)',
          'Read',
          'Grep',
          'Glob',
          'Task',
          'Agent',
          ...reviewerTools(checkout, only),
        ],
        addDirs: [SIEVE_HOME],
        env: { SIEVE_HEADLESS: '1' },
        onEvent: (ev) => {
          trackJob(job, ev);
          if (!ev.parent_tool_use_id) {
            if (ev.type === 'result') result = ev;
            const u = ev.type === 'stream_event' && ev.event?.type === 'message_delta' ? ev.event.usage : null;
            if (u)
              orchestrator =
                (u.input_tokens || 0) +
                (u.cache_read_input_tokens || 0) +
                (u.cache_creation_input_tokens || 0) +
                (u.output_tokens || 0);
          }
          appendFileSync(job.log!, JSON.stringify(ev) + '\n');
        },
        signal: ac.signal,
      });
      if (!job.runDir || !existsSync(paths(job.runDir).findings))
        throw new Error(res.text.slice(-600) || 'The review ended without results.');
      job.state = 'done';
      job.phase = 'done';
      job.finishedAt = new Date().toISOString();
      writeJson(paths(job.runDir).usage, runUsage(job, result, orchestrator));
    } catch (e) {
      job.state = ac.signal.aborted ? 'cancelled' : 'error';
      if (!ac.signal.aborted) job.error = (e as Error).message;
    } finally {
      job.finishedAt ??= new Date().toISOString();
      aborts.delete(job.url);
      force.delete(job.url);
      picks.delete(job.url);
      void pump();
    }
  }

  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message }, 500));

  app.get('/api/inbox/ping', (c) => c.json({ ok: true }));
  app.get('/api/inbox', async (c) => c.json(await data(c.req.query('refresh') === '1')));

  /** Reviewers available for a PR (its checkout's, or the clone's), with the ones enabled by default. */
  app.get('/api/inbox/reviewers', (c) => {
    const pr = gh?.rows?.prs.find((p) => p.url === c.req.query('url'));
    if (!pr) return c.json({ error: 'This PR is not in the inbox. Refresh the page.' }, 404);
    const root = checkoutOf(settings().inbox, pr.owner, pr.repo) || join(SIEVE_HOME, 'repos', pr.owner, pr.repo);
    const all = allReviewers(SIEVE_ROOT, root, loadSettings(root));
    return c.json(
      [...all.values()].map((r): InboxReviewer => ({
        name: r.name,
        description: r.description,
        enabled: r.enabled,
        model: r.model,
        effort: r.effort,
      })),
    );
  });

  app.post('/api/inbox/review', async (c) => {
    const { url, only } = await c.req.json<{ url: string; only?: string[] }>();
    const pr = gh?.rows?.prs.find((p) => p.url === url);
    if (!pr) return c.json({ error: 'This PR is not in the inbox. Refresh the page.' }, 404);
    // Names go into the prompt: only plain reviewer names.
    if (only && (!only.length || only.some((n) => !/^[\w.-]+$/.test(n))))
      return c.json({ error: 'Pick at least one reviewer.' }, 400);
    const cur = jobs.get(url);
    if (cur && (cur.state === 'queued' || cur.state === 'running')) return c.json(cur);
    if (only) picks.set(url, only);
    else picks.delete(url);
    // A run on the current head exists → the skill needs --force to review it again.
    if (localRuns(pr).some((r) => r.onHead)) force.add(url);
    const job: InboxJob = { url, state: 'queued', phase: 'queued', agents: [], queuedAt: new Date().toISOString() };
    jobs.set(url, job);
    void pump();
    return c.json(job);
  });

  app.post('/api/inbox/cancel', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    const job = jobs.get(url);
    if (!job) return c.json({ error: 'not found' }, 404);
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.finishedAt = new Date().toISOString();
    } else aborts.get(url)?.abort();
    return c.json(job);
  });

  app.post('/api/inbox/dismiss', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    const job = jobs.get(url);
    if (job && job.state !== 'queued' && job.state !== 'running') jobs.delete(url);
    return c.json({ ok: true });
  });

  /** Take a PR off the page until its next commit; unsnooze brings it back. */
  app.post('/api/inbox/snooze', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    const pr = gh?.rows?.prs.find((p) => p.url === url);
    if (!pr) return c.json({ error: 'This PR is not in the inbox. Refresh the page.' }, 404);
    const st = loadInboxState();
    st.snoozed[url] = pr.headSha;
    saveInboxState(st);
    return c.json({ ok: true });
  });

  /** Bring back one snoozed PR. */
  app.post('/api/inbox/unsnooze', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    const st = loadInboxState();
    delete st.snoozed[url];
    saveInboxState(st);
    return c.json({ ok: true });
  });

  /** Start (or reuse) the UI server of a run and return its URL. */
  app.post('/api/inbox/open', async (c) => {
    const { runDir } = await c.req.json<{ runDir: string }>();
    const dir = resolve(runDir || '');
    // Only runs the inbox itself lists can be opened.
    const known = gh?.rows?.prs.some((p) => localRuns(p).some((r) => r.runDir === dir));
    if (!known) return c.json({ error: 'Unknown run. Refresh the page.' }, 404);
    const proc = Bun.spawn(
      ['bun', join(o.sieveRoot, 'cli', 'sieve.ts'), 'serve', dir, '--detach', '--no-open', '--idle-exit', '120'],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SIEVE_HEADLESS: '' } },
    );
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) return c.json({ error: err.trim() || 'Could not start the run UI.' }, 500);
    return c.json({ url: JSON.parse(out).url as string });
  });

  app.put('/api/inbox/settings', async (c) => {
    const body = await c.req.json<{ reportLanguage?: string; commentLanguage?: string; persist?: boolean }>();
    const pick: Record<string, string> = {};
    if (body.reportLanguage?.trim()) pick.reportLanguage = body.reportLanguage.trim();
    if (body.commentLanguage?.trim()) pick.commentLanguage = body.commentLanguage.trim();
    lang = { ...lang, ...pick };
    if (body.persist) {
      // The inbox spans repos, so its default is the global one.
      const file = join(SIEVE_HOME, 'settings.json');
      const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      writeJson(file, { ...cur, ...pick });
    }
    const s = settings();
    return c.json({ reportLanguage: s.reportLanguage, commentLanguage: s.commentLanguage });
  });

  /** Stop the inbox: cancel running reviews, then exit. */
  app.post('/api/inbox/shutdown', (c) => {
    for (const j of jobs.values()) if (j.state === 'queued') j.state = 'cancelled';
    for (const ac of aborts.values()) ac.abort();
    rmSync(join(SIEVE_HOME, 'inbox.json'), { force: true });
    setTimeout(() => process.exit(0), 300); // let the response flush and claude get its signal
    return c.json({ ok: true });
  });

  app.get('/', (c) => c.redirect('/inbox'));
  app.get('*', staticUi(o.sieveRoot));
  return app;
}

export async function startInboxServer(o: InboxServerOptions) {
  ensureUi(o.sieveRoot);
  const app = createInboxApp(o);
  const server = Bun.serve({ port: o.port, hostname: '127.0.0.1', fetch: app.fetch, idleTimeout: 0 });
  const url = `http://127.0.0.1:${server.port}/`;
  writeJson(join(SIEVE_HOME, 'inbox.json'), { url, pid: process.pid, startedAt: new Date().toISOString() });
  process.stdout.write(JSON.stringify({ url }) + '\n');
  if (o.open ?? true) openBrowser(url + 'inbox');
  return server;
}
