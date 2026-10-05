/**
 * Inbox server: PRs waiting for your review, Sieve runs of them, and headless reviews
 * (`claude -p "/sieve:review <url>"`) started from the page.
 */
import { Hono } from 'hono';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { InboxData, InboxJob, InboxPr, Settings } from '../shared/types.ts';
import { SIEVE_HOME } from '../cli/lib/settings.ts';
import { bucketOf, checkoutOf, fetchInbox, inboxSettings, localRuns } from '../cli/lib/inbox.ts';
import { paths, writeJson } from '../cli/lib/run.ts';
import { runClaude } from './claude.ts';
import { ensureUi, openBrowser, staticUi } from './index.ts';

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
  const prs: InboxPr[] = [];
  for (const p of gh?.prs || []) {
    const job = jobs.get(p.url);
    const bucket = bucketOf({ ...p, job });
    if (!bucket) continue; // nothing needed from you
    const checkout = checkoutOf(s.inbox, p.owner, p.repo);
    prs.push({ ...p, checkout, runs: localRuns(p, checkout), job, bucket });
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
 * Follow the orchestrator's stream-json: its Bash calls give the phase, its Task calls the agents.
 * Events of subagents (parent_tool_use_id set) are ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped claude stream-json events
export function trackJob(job: InboxJob, ev: any) {
  if (ev.parent_tool_use_id) return;
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
      if (a) a.done = true;
      const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
      const m = text.match(/"runDir":\s*"((?:[^"\\]|\\.)+)"/);
      if (m && !job.runDir) job.runDir = JSON.parse(`"${m[1]}"`);
    }
  }
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
    const ac = new AbortController();
    aborts.set(job.url, ac);

    const pr = gh?.rows?.prs.find((p) => p.url === job.url);
    const checkout = pr && checkoutOf(settings().inbox, pr.owner, pr.repo);
    // Without a checkout the skill clones the repo into ~/.sieve/repos.
    const cwd = checkout || SIEVE_HOME;
    mkdirSync(join(SIEVE_HOME, 'logs'), { recursive: true });
    job.log = join(SIEVE_HOME, 'logs', `inbox-${pr ? `${pr.owner}-${pr.repo}-${pr.number}` : Date.now()}.jsonl`);
    try {
      const res = await runClaude({
        cwd,
        prompt: `/sieve:review ${job.url}${force.has(job.url) ? ' --force' : ''}`,
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
        ],
        addDirs: [SIEVE_HOME],
        env: { SIEVE_HEADLESS: '1' },
        onEvent: (ev) => {
          trackJob(job, ev);
          appendFileSync(job.log!, JSON.stringify(ev) + '\n');
        },
        signal: ac.signal,
      });
      if (!job.runDir || !existsSync(paths(job.runDir).findings))
        throw new Error(res.text.slice(-600) || 'The review ended without results.');
      job.state = 'done';
      job.phase = 'done';
    } catch (e) {
      job.state = ac.signal.aborted ? 'cancelled' : 'error';
      if (!ac.signal.aborted) job.error = (e as Error).message;
    } finally {
      job.finishedAt = new Date().toISOString();
      aborts.delete(job.url);
      force.delete(job.url);
      void pump();
    }
  }

  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message }, 500));

  app.get('/api/inbox/ping', (c) => c.json({ ok: true }));
  app.get('/api/inbox', async (c) => c.json(await data(c.req.query('refresh') === '1')));

  app.post('/api/inbox/review', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    const pr = gh?.rows?.prs.find((p) => p.url === url);
    if (!pr) return c.json({ error: 'This PR is not in the inbox. Refresh the page.' }, 404);
    const cur = jobs.get(url);
    if (cur && (cur.state === 'queued' || cur.state === 'running')) return c.json(cur);
    // A run on the current head exists → the skill needs --force to review it again.
    if (localRuns(pr, checkoutOf(settings().inbox, pr.owner, pr.repo)).some((r) => r.onHead)) force.add(url);
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

  /** Start (or reuse) the UI server of a run and return its URL. */
  app.post('/api/inbox/open', async (c) => {
    const { runDir } = await c.req.json<{ runDir: string }>();
    const dir = resolve(runDir || '');
    // Only runs the inbox itself lists can be opened.
    const known = gh?.rows?.prs.some((p) =>
      localRuns(p, checkoutOf(settings().inbox, p.owner, p.repo)).some((r) => r.runDir === dir),
    );
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
