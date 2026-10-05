import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname, dirname, resolve, sep } from 'node:path';
import type { ChatThread, Finding, FindingState, RunMeta, RunState, Settings } from '../shared/types.ts';
import { loadSettings, languageName } from '../cli/lib/settings.ts';
import { paths, readJson, writeJson, loadRun } from '../cli/lib/run.ts';
import { hunksAround } from '../cli/lib/diff.ts';
import { sh, has } from '../cli/lib/sh.ts';
import { runClaude, claudeAvailable } from './claude.ts';
import { buildReview, postReview, exportMarkdown, type ReviewEvent } from './publish.ts';
import { mapRoutes } from './map.ts';

export interface ServerOptions {
  runDir: string;
  sieveRoot: string;
  port?: number;
  open?: boolean;
  /** Exit after this many minutes without requests (servers opened from the inbox). */
  idleExitMin?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Build the UI on first run (plugins are installed without node_modules / dist). */
export function ensureUi(sieveRoot: string) {
  const dist = join(sieveRoot, 'ui', 'dist', 'index.html');
  if (existsSync(dist)) return;
  const log = (m: string) => process.stderr.write(`sieve: ${m}\n`);
  if (!existsSync(join(sieveRoot, 'node_modules', 'vite'))) {
    log('installing UI dependencies (first run only)…');
    const r = sh(['bun', 'install'], { cwd: sieveRoot });
    if (!r.ok) throw new Error(`bun install failed:\n${r.stderr}`);
  }
  log('building UI (first run only)…');
  const b = sh(['bun', 'run', 'build'], { cwd: sieveRoot });
  if (!b.ok) throw new Error(`UI build failed:\n${b.stderr || b.stdout}`);
}

/** Serves the built UI; unknown paths get index.html (the UI picks the page by path). */
export function staticUi(sieveRoot: string) {
  const dist = join(sieveRoot, 'ui', 'dist');
  return (c: Context) => {
    const p = decodeURIComponent(new URL(c.req.url).pathname);
    if (p.includes('..')) return c.text('bad path', 400);
    let file = join(dist, p);
    if (p === '/' || !existsSync(file) || !extname(file)) file = join(dist, 'index.html');
    if (!existsSync(file)) return c.text('UI is not built. Run `bun run build` in the sieve folder.', 500);
    return new Response(Bun.file(file), {
      headers: { 'content-type': MIME[extname(file)] || 'application/octet-stream' },
    });
  };
}

export function openBrowser(url: string) {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {}
}

export interface ThreadTurn {
  /** Only one answer at a time per key. */
  key: string;
  thread: ChatThread;
  /** Context sent with the first message of the thread. */
  context: () => string;
  /** What is sent to Claude. */
  text: string;
  /** Store `text` as the user's chat message. */
  record: boolean;
  langNote: string;
  /** Turns the answer into the stored assistant message (+ extra fields for the `done` event). */
  finish?: (answer: string) => { text: string; kind: 'chat' | 'comment'; extra?: Record<string, unknown> };
}

function stripFence(s: string): string {
  const m = s.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return m ? m[1]!.trim() : s.trim();
}

export function createApp(o: ServerOptions) {
  const { runDir } = o;
  const P = paths(runDir);
  const run = loadRun(runDir);
  const meta: RunMeta = run.meta;
  const files = run.files;
  const findings: Finding[] = run.findings;
  const state: RunState = run.state;
  for (const f of findings) state.findings[f.id] ??= { status: 'open', messages: [] };

  const busy = new Set<string>();

  const settings = (): Settings => {
    const s = loadSettings(meta.repoRoot, meta.overrides);
    if (state.settings?.reportLanguage) s.reportLanguage = state.settings.reportLanguage;
    if (state.settings?.commentLanguage) s.commentLanguage = state.settings.commentLanguage;
    return s;
  };
  const save = () => writeJson(P.state, state);
  const byId = (id: string) => findings.find((f) => f.id === id);
  const fstate = (id: string): FindingState => (state.findings[id] ??= { status: 'open', messages: [] });
  const rules = readJson<{ path: string; scope: string }[]>(P.rules, []);

  /** Lines around [line, endLine] of a worktree file; null when the path is outside the worktree or missing. */
  function snippet(file: string, line: number, endLine?: number, pad = 6) {
    const abs = resolve(meta.worktree, file);
    if (!abs.startsWith(meta.worktree + sep) || !existsSync(abs)) return null;
    const all = readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(1, line - pad);
    const end = Math.min(all.length, (endLine || line) + pad);
    return { start, lines: all.slice(start - 1, end) };
  }

  const code = (file: string, line: number, endLine?: number) => ({
    hunks: hunksAround(files, file, line, endLine),
    snippet: snippet(file, line, endLine),
  });

  function findingContext(f: Finding): string {
    const s = settings();
    const { id, file, line, endLine, severity, category, rule, title, explanation, suggestion, reviewers, validation } =
      f;
    return [
      'You are helping a developer triage ONE finding from an automated multi-agent code review (Sieve).',
      'Act as a sharp, honest senior colleague: verify claims against the actual code, say plainly when the finding is wrong,',
      'keep answers short (a few sentences; code only when it helps). Never modify files.',
      '',
      `Code at the reviewed revision (read-only): ${meta.worktree}`,
      `Full diff: ${P.patch}`,
      rules.length ? `Project rules: ${rules.map((r) => join(meta.repoRoot, r.path)).join(', ')}` : '',
      '',
      `Change: ${meta.title}${meta.url ? ` (${meta.url})` : ''}`,
      meta.body ? `Description:\n${meta.body.slice(0, 3000)}` : '',
      '',
      'The finding:',
      '```json',
      JSON.stringify(
        { id, file, line, endLine, severity, category, rule, title, explanation, suggestion, reviewers, validation },
        null,
        2,
      ),
      '```',
      '',
      `Chat with the developer in ${languageName(s.reportLanguage)}. PR comments you are asked to write use their own language.`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  /** One turn with Claude in the thread's own session, streamed as SSE (delta / tool / done / error). */
  function streamThread(c: Context, o: ThreadTurn) {
    if (busy.has(o.key)) return c.json({ error: 'Claude is already answering in this thread' }, 409);
    const st = o.thread;
    if (o.record) {
      st.messages.push({ role: 'user', text: o.text, at: new Date().toISOString() });
      save();
    }
    busy.add(o.key);
    const ac = new AbortController();

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ac.abort());
      try {
        const s = settings();
        const prompt = st.sessionId
          ? `${o.text}\n\n${o.langNote}`
          : `${o.context()}\n\n---\n\n${o.text}\n\n${o.langNote}`;
        const addDirs = [runDir];
        if (meta.repoRoot !== meta.worktree) addDirs.push(meta.repoRoot);
        const res = await runClaude({
          cwd: meta.worktree,
          prompt,
          model: s.chat.model,
          tools: s.chat.tools,
          addDirs,
          resume: st.sessionId,
          onText: (t) => void stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: t }) }),
          onTool: (t) => void stream.writeSSE({ event: 'tool', data: JSON.stringify({ label: t }) }),
          signal: ac.signal,
        });
        if (res.sessionId) st.sessionId = res.sessionId;
        const done = o.finish?.(res.text) ?? { text: res.text, kind: 'chat' as const };
        st.messages.push({ role: 'assistant', text: done.text, at: new Date().toISOString(), kind: done.kind });
        save();
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ state: st, ...done.extra }) });
      } catch (e) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: (e as Error).message }) });
      } finally {
        busy.delete(o.key);
      }
    });
  }

  function commentInstruction(f: Finding): string {
    const s = settings();
    let sugg = 'Do not use a ```suggestion block.';
    if (f.anchor) {
      const file = join(meta.worktree, f.file);
      const a = f.anchor.startLine || f.anchor.line;
      const b = f.anchor.line;
      if (existsSync(file)) {
        const cur = readFileSync(file, 'utf8')
          .split('\n')
          .slice(a - 1, b)
          .join('\n');
        sugg =
          `If a small change to lines ${a}-${b} fully fixes the problem on its own, include a GitHub \`\`\`suggestion block ` +
          `with the complete replacement for exactly those lines. Otherwise (bigger change, several places, follow-up needed) ` +
          `describe the fix in words and do NOT add a suggestion block.\nCurrent lines ${a}-${b}:\n\`\`\`\n${cur}\n\`\`\``;
      }
    }
    return [
      'Now write the comment that will be posted on the pull request for this finding.',
      `- Language: ${languageName(s.commentLanguage)}.`,
      `- Style: ${s.commentStyle}`,
      '- Take our discussion into account; it overrides the original finding.',
      '- If we concluded the finding is not a real problem, output exactly: NO_COMMENT',
      `- ${sugg}`,
      '- Do not mention AI, Sieve, severity, confidence or this conversation. No greetings. Never explain whether or why you added a suggestion block.',
      '- Output ONLY the comment in GitHub Markdown, nothing else.',
    ].join('\n');
  }

  const app = new Hono();

  app.onError((err, c) => c.json({ error: err.message }, 500));

  app.get('/api/run', (c) => {
    const s = settings();
    return c.json({
      meta: {
        id: meta.id,
        mode: meta.mode,
        title: meta.title,
        url: meta.url,
        author: meta.author,
        owner: meta.owner,
        repo: meta.repo,
        number: meta.number,
        baseRef: meta.baseRef,
        headRef: meta.headRef,
        headSha: meta.headSha,
        isDraft: meta.isDraft,
        state: meta.state,
        changedFiles: meta.changedFiles.length,
      },
      settings: { reportLanguage: s.reportLanguage, commentLanguage: s.commentLanguage, mapMode: s.map.mode },
      findings,
      state,
      capabilities: {
        publish: meta.mode === 'pr' && has('gh'),
        chat: claudeAvailable(),
      },
    });
  });

  app.put('/api/settings', async (c) => {
    const body = await c.req.json<{ reportLanguage?: string; commentLanguage?: string; persist?: boolean }>();
    state.settings = { ...state.settings };
    if (body.reportLanguage) state.settings.reportLanguage = body.reportLanguage;
    if (body.commentLanguage) state.settings.commentLanguage = body.commentLanguage;
    save();
    if (body.persist) {
      const file = join(meta.repoRoot, '.sieve', 'settings.local.json');
      const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      if (body.reportLanguage) cur.reportLanguage = body.reportLanguage;
      if (body.commentLanguage) cur.commentLanguage = body.commentLanguage;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
    }
    const s = settings();
    return c.json({ reportLanguage: s.reportLanguage, commentLanguage: s.commentLanguage });
  });

  app.patch('/api/findings/:id', async (c) => {
    const f = byId(c.req.param('id'));
    if (!f) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<Partial<FindingState> & { learn?: boolean }>();
    const st = fstate(f.id);
    if (body.status) st.status = body.status;
    if (body.comment !== undefined) st.comment = body.comment;
    if (body.rejectReason !== undefined) st.rejectReason = body.rejectReason;
    if (body.status === 'rejected' && body.learn && body.rejectReason?.trim()) {
      const file = join(meta.repoRoot, '.sieve', 'learned.md');
      mkdirSync(dirname(file), { recursive: true });
      const head = existsSync(file)
        ? ''
        : '# Sieve — rejected findings\n\nFindings the team rejected in past reviews. Reviewers must not raise these again.\n\n';
      appendFileSync(
        file,
        `${head}- [${f.category}] \`${f.file}\` — "${f.title}": ${body.rejectReason.trim().replace(/\n+/g, ' ')}\n`,
      );
    }
    save();
    return c.json(st);
  });

  app.get('/api/findings/:id/context', (c) => {
    const f = byId(c.req.param('id'));
    if (!f) return c.json({ error: 'not found' }, 404);
    return c.json(code(f.file, f.line, f.endLine));
  });

  app.get('/api/code', (c) => {
    const file = c.req.query('file') || '';
    const line = Math.max(1, Math.floor(Number(c.req.query('line')) || 1));
    const endLine = Math.floor(Number(c.req.query('endLine'))) || undefined;
    if (!file) return c.json({ error: 'file is required' }, 400);
    return c.json(code(file, line, endLine));
  });

  app.post('/api/findings/:id/reset', (c) => {
    const f = byId(c.req.param('id'));
    if (!f) return c.json({ error: 'not found' }, 404);
    const st = fstate(f.id);
    st.messages = [];
    st.sessionId = undefined;
    save();
    return c.json(st);
  });

  const findingTurn = (kind: 'chat' | 'comment') => async (c: Context) => {
    const f = byId(c.req.param('id') ?? '');
    if (!f) return c.json({ error: 'not found' }, 404);
    const text = kind === 'chat' ? String((await c.req.json()).message || '').trim() : commentInstruction(f);
    if (!text) return c.json({ error: 'empty message' }, 400);
    const s = settings();
    const st = fstate(f.id);
    return streamThread(c, {
      key: f.id,
      thread: st,
      context: () => findingContext(f),
      text,
      record: kind === 'chat',
      langNote:
        kind === 'chat'
          ? `(Reply in ${languageName(s.reportLanguage)}.)`
          : `(Write the comment in ${languageName(s.commentLanguage)}, regardless of the language of our chat.)`,
      finish:
        kind === 'comment'
          ? (answer) => {
              let out = stripFence(answer);
              if (out.trim() === 'NO_COMMENT') out = '';
              st.comment = out;
              return { text: out || '—', kind, extra: { noComment: !out } };
            }
          : undefined,
    });
  };

  app.post('/api/findings/:id/chat', findingTurn('chat'));
  app.post('/api/findings/:id/comment', findingTurn('comment'));

  app.route('/', mapRoutes({ ...o, meta, files, findings, state, settings, save, streamThread }));

  app.get('/api/publish/preview', (c) => {
    const plan = buildReview(meta, findings, state, {
      event: (c.req.query('event') as ReviewEvent) || 'COMMENT',
      allGeneral: c.req.query('allGeneral') === '1',
      summary: c.req.query('summary') || '',
    });
    return c.json(plan);
  });

  app.post('/api/publish', async (c) => {
    if (meta.mode !== 'pr') return c.json({ error: 'Local review — nothing to publish to. Use export instead.' }, 400);
    const body = await c.req.json<{ summary?: string; event?: ReviewEvent; allGeneral?: boolean }>();
    const plan = buildReview(meta, findings, state, body);
    const r = postReview(meta, plan);
    if (!r.ok) return c.json({ error: r.error, status: r.status }, 502);
    const at = new Date().toISOString();
    for (const id of plan.ids) fstate(id).published = { at, url: r.url };
    state.reviews = [...(state.reviews || []), { at, url: r.url, count: plan.ids.length }];
    save();
    return c.json({ url: r.url, count: plan.ids.length, state });
  });

  app.get('/api/export', (c) => c.text(exportMarkdown(meta, findings, state)));

  app.post('/api/shutdown', (c) => {
    setTimeout(() => process.exit(0), 100); // let the response flush first
    return c.json({ ok: true });
  });

  app.get('*', staticUi(o.sieveRoot));

  return app;
}

export async function startServer(o: ServerOptions) {
  ensureUi(o.sieveRoot);
  const app = createApp(o);
  const settings = loadSettings(readJson<RunMeta>(paths(o.runDir).meta).repoRoot);
  let lastHit = Date.now();
  const server = Bun.serve({
    port: o.port ?? settings.server.port ?? 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => {
      lastHit = Date.now();
      return app.fetch(req, srv);
    },
    idleTimeout: 0, // chat responses can take a while
  });
  const url = `http://127.0.0.1:${server.port}/`;
  const info = paths(o.runDir).server;
  writeJson(info, { url, pid: process.pid, startedAt: new Date().toISOString() });
  if (o.idleExitMin) {
    const ms = o.idleExitMin * 60_000;
    setInterval(() => {
      if (Date.now() - lastHit < ms) return;
      rmSync(info, { force: true });
      process.exit(0);
    }, 60_000).unref();
  }
  process.stdout.write(JSON.stringify({ url, runDir: o.runDir }) + '\n');
  if (o.open ?? settings.server.open) openBrowser(url);
  return server;
}
