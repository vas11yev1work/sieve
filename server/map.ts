/**
 * PR map routes: status, on-demand builds (SSE progress), per-node chat.
 * The build runs in the background — a closed tab does not cancel it, only POST /api/map/cancel does.
 */
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type {
  ChatThread,
  Finding,
  MapFlow,
  MapNode,
  MapStatus,
  ParsedFile,
  PrMap,
  RunMeta,
  RunState,
  Settings,
} from '../shared/types.ts';
import { paths, readJson, writeJson } from '../cli/lib/run.ts';
import { linkFindings, normalizeMap, parseMapOutput } from '../cli/lib/map.ts';
import { mapPrompt } from '../cli/lib/prompts.ts';
import { languageName } from '../cli/lib/settings.ts';
import { runClaude } from './claude.ts';
import type { ThreadTurn } from './index.ts';

export interface MapContext {
  runDir: string;
  sieveRoot: string;
  meta: RunMeta;
  files: ParsedFile[];
  findings: Finding[];
  state: RunState;
  settings: () => Settings;
  save: () => void;
  streamThread: (c: Context, o: ThreadTurn) => Response | Promise<Response>;
}

type BuildEvent = { event: 'progress' | 'done' | 'error'; data: unknown };

interface Build {
  startedAt: string;
  /** Tool labels, newest last. */
  events: string[];
  ac: AbortController;
  listeners: Set<(e: BuildEvent) => Promise<void>>;
}

export const nodeKey = (flowId: string, nodeId: string) => `map:${flowId}:${nodeId}`;

export function mapRoutes(x: MapContext) {
  const { meta, files, findings, state } = x;
  const P = paths(x.runDir);
  const app = new Hono();
  let build: Build | null = null;
  let lastError: string | undefined;

  const stored = (): PrMap | null => (existsSync(P.map) ? readJson<PrMap>(P.map) : null);

  function status(): MapStatus {
    if (build) return { state: 'building', startedAt: build.startedAt, progress: build.events.at(-1) };
    if (lastError) return { state: 'error', error: lastError };
    const m = stored();
    return m ? { state: 'ready', map: linkFindings(m, findings) } : { state: 'none' };
  }

  function startBuild() {
    const s = x.settings();
    const b: Build = {
      startedAt: new Date().toISOString(),
      events: [],
      ac: new AbortController(),
      listeners: new Set(),
    };
    build = b;
    lastError = undefined;
    const emit = (e: BuildEvent) => Promise.all([...b.listeners].map((l) => l(e)));

    const prompt = mapPrompt(x.sieveRoot, meta, s, files);
    mkdirSync(P.prompts, { recursive: true });
    writeFileSync(P.mapPrompt, prompt);

    runClaude({
      cwd: meta.worktree,
      prompt,
      model: s.map.model,
      tools: s.chat.tools,
      addDirs: [x.runDir],
      ephemeral: true,
      // Bare tool names arrive first; the labelled event ("Read src/…") follows right after.
      onTool: (label) => {
        if (!label.includes(' ') || label === b.events.at(-1)) return;
        b.events.push(label);
        if (b.events.length > 50) b.events.shift();
        void emit({ event: 'progress', data: { label } });
      },
      signal: b.ac.signal,
    })
      .then((res) => {
        if (build !== b) return; // cancelled
        writeJson(P.map, normalizeMap(parseMapOutput(res.text), meta, files, s));
        // Node chats talked about the old map.
        for (const k of Object.keys(state.threads || {})) if (k.startsWith('map:')) delete state.threads![k];
        x.save();
        build = null;
        void emit({ event: 'done', data: status() });
      })
      .catch((e: Error) => {
        if (build !== b) return;
        build = null;
        lastError = e.message || 'map build failed';
        void emit({ event: 'error', data: { message: lastError } });
      });
  }

  /** SSE: replay the last progress events of the running build, then follow it to the end. */
  const follow = (c: Context) =>
    streamSSE(c, async (stream) => {
      const b = build;
      if (!b) {
        const st = status();
        if (st.state === 'error')
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: st.error }) });
        else await stream.writeSSE({ event: 'done', data: JSON.stringify(st) });
        return;
      }
      for (const label of b.events.slice(-5))
        await stream.writeSSE({ event: 'progress', data: JSON.stringify({ label }) });
      await new Promise<void>((resolve) => {
        const l = async (e: BuildEvent) => {
          await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
          if (e.event !== 'progress') {
            b.listeners.delete(l);
            resolve();
          }
        };
        b.listeners.add(l);
        stream.onAbort(() => {
          b.listeners.delete(l);
          resolve();
        });
      });
    });

  function nodeContext(map: PrMap, flow: MapFlow, node: MapNode): string {
    const s = x.settings();
    const related = findings.filter((f) => node.findingIds?.includes(f.id));
    return [
      'You are helping a developer understand ONE step of a flow on the PR map built by Sieve (an automated code review tool).',
      'Explain how this step works and what in the change affects it. Verify claims against the actual code.',
      'Keep answers short (a few sentences; code only when it helps). Never modify files.',
      '',
      `Code at the reviewed revision (read-only): ${meta.worktree}`,
      `Full diff: ${P.patch}`,
      '',
      `Change: ${meta.title}${meta.url ? ` (${meta.url})` : ''}`,
      meta.body ? `Description:\n${meta.body.slice(0, 3000)}` : '',
      '',
      `Overview of the change: ${map.overview.summary}`,
      map.overview.areas.length ? `Areas: ${map.overview.areas.join(', ')}` : '',
      map.overview.risks.length ? `Risks:\n${map.overview.risks.map((r) => `- ${r}`).join('\n')}` : '',
      '',
      `Flow: ${flow.title} — ${flow.description}`,
      flow.trigger ? `Trigger: ${flow.trigger}` : '',
      `Chain: ${flow.nodes.map((n) => n.label).join(' → ')}`,
      '',
      'The step:',
      '```json',
      JSON.stringify(node, null, 2),
      '```',
      related.length
        ? 'Review findings on this step:\n' +
          related.map((f) => `- [${f.severity}] ${f.title} (${f.file}:${f.line}): ${f.explanation}`).join('\n')
        : '',
      '',
      `Chat with the developer in ${languageName(s.reportLanguage)}.`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  /** Resolve :flowId/:nodeId against the stored map (with findings linked). */
  function target(c: Context) {
    const m = stored();
    if (!m) return null;
    const map = linkFindings(m, findings);
    const flow = map.flows.find((f) => f.id === c.req.param('flowId'));
    const node = flow?.nodes.find((n) => n.id === c.req.param('nodeId'));
    if (!flow || !node) return null;
    const key = nodeKey(flow.id, node.id);
    const thread: ChatThread = ((state.threads ??= {})[key] ??= { messages: [] });
    return { map, flow, node, key, thread };
  }

  app.use('/api/map/*', async (c, next) => {
    if (x.settings().map.mode === 'off') return c.json({ error: 'map is disabled' }, 404);
    await next();
  });
  app.get('/api/map', (c) =>
    x.settings().map.mode === 'off' ? c.json({ error: 'map is disabled' }, 404) : c.json(status()),
  );

  app.post('/api/map/build', (c) => {
    if (build) return c.json({ error: 'The map is already being built' }, 409);
    startBuild();
    return follow(c);
  });

  app.get('/api/map/progress', follow);

  app.post('/api/map/cancel', async (c) => {
    const b = build;
    if (b) {
      build = null;
      b.ac.abort();
      const st = status();
      await Promise.all([...b.listeners].map((l) => l({ event: 'done', data: st })));
    }
    return c.json(status());
  });

  app.post('/api/map/nodes/:flowId/:nodeId/chat', async (c) => {
    const t = target(c);
    if (!t) return c.json({ error: 'not found' }, 404);
    const text = String((await c.req.json()).message || '').trim();
    if (!text) return c.json({ error: 'empty message' }, 400);
    return x.streamThread(c, {
      key: t.key,
      thread: t.thread,
      context: () => nodeContext(t.map, t.flow, t.node),
      text,
      record: true,
      langNote: `(Reply in ${languageName(x.settings().reportLanguage)}.)`,
    });
  });

  app.post('/api/map/nodes/:flowId/:nodeId/reset', (c) => {
    const t = target(c);
    if (!t) return c.json({ error: 'not found' }, 404);
    t.thread.messages = [];
    t.thread.sessionId = undefined;
    x.save();
    return c.json(t.thread);
  });

  return app;
}
