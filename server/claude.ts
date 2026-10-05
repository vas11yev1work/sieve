/**
 * Thin wrapper around `claude -p` (Claude Code headless mode).
 * Uses the user's own Claude Code login — no API key needed.
 */

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  model?: string;
  /** Built-in tools Claude may use; 'all' keeps Claude Code's full set (permissions still apply). */
  tools?: string[] | 'all';
  /** Tools that run without a permission prompt (`--allowedTools`); others are denied in headless mode. */
  allowedTools?: string[];
  env?: Record<string, string>;
  addDirs?: string[];
  /** Continue an existing session. */
  resume?: string;
  /** Appended to Claude Code's system prompt (first turn only). */
  systemPrompt?: string;
  /** Do not save the session on disk (one-off calls). */
  ephemeral?: boolean;
  onText?: (delta: string) => void;
  onTool?: (label: string) => void;
  /** Every stream-json event, as is. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped claude stream-json events
  onEvent?: (ev: any) => void;
  signal?: AbortSignal;
}

export interface ClaudeRunResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
}

const BIN = process.env.SIEVE_CLAUDE_BIN || 'claude';

function toolLabel(name: string, input: Record<string, unknown>): string {
  const p = (input.file_path || input.path || input.pattern || '') as string;
  const short = p ? ` ${String(p).split('/').slice(-3).join('/')}` : '';
  return `${name}${short}`;
}

export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [BIN, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (o.model) args.push('--model', o.model);
  if (o.resume) args.push('--resume', o.resume);
  else if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
  if (o.ephemeral) args.push('--no-session-persistence');
  for (const d of o.addDirs || []) args.push('--add-dir', d);
  if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
  // Variadic flag goes last; the prompt is sent on stdin.
  if (o.tools !== 'all') args.push('--tools', ...(o.tools?.length ? o.tools : ['Read', 'Grep', 'Glob']));

  const proc = Bun.spawn(args, {
    cwd: o.cwd,
    stdin: new TextEncoder().encode(o.prompt),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...o.env },
  });
  o.signal?.addEventListener('abort', () => proc.kill());

  let acc = '';
  let sawMessageText = false;
  let sessionId: string | undefined;
  let result: string | undefined;
  let isError = false;
  let costUsd: number | undefined;

  const handle = (line: string) => {
    if (!line.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped claude stream-json events
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    o.onEvent?.(ev);
    if (ev.session_id && !sessionId) sessionId = ev.session_id;
    if (ev.type === 'stream_event') {
      const e = ev.event;
      if (e?.type === 'message_start' && sawMessageText) {
        acc += '\n\n';
        o.onText?.('\n\n');
        sawMessageText = false;
      } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        acc += e.delta.text;
        sawMessageText = true;
        o.onText?.(e.delta.text);
      } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        o.onTool?.(e.content_block.name);
      }
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_use') o.onTool?.(toolLabel(c.name, c.input || {}));
      }
    } else if (ev.type === 'result') {
      sessionId = ev.session_id || sessionId;
      result = typeof ev.result === 'string' ? ev.result : undefined;
      isError = !!ev.is_error || (ev.subtype && ev.subtype !== 'success');
      costUsd = ev.total_cost_usd;
    }
  };

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  handle(buf);
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (o.signal?.aborted) throw new Error('aborted');
  if (isError || (code !== 0 && !acc && !result)) {
    throw new Error((result || stderr || `claude exited with code ${code}`).trim().slice(0, 2000));
  }
  // Prefer what we streamed (keeps text from before tool calls); fall back to the final result.
  const text = (acc.trim() ? acc : result || '').trim();
  return { text, sessionId, costUsd };
}

export function claudeAvailable(): boolean {
  return Bun.which(BIN) !== null;
}
