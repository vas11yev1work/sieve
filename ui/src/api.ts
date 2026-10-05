import type {
  ChatThread,
  Finding,
  FindingState,
  InboxData,
  InboxJob,
  MapStatus,
  ParsedHunk,
  RunState,
  Settings,
} from '../../shared/types';

export interface RunData {
  meta: {
    id: string;
    mode: 'pr' | 'local';
    title: string;
    url?: string;
    author?: string;
    owner?: string;
    repo?: string;
    number?: number;
    baseRef: string;
    headRef: string;
    headSha: string;
    isDraft?: boolean;
    state?: string;
    changedFiles: number;
  };
  settings: { reportLanguage: string; commentLanguage: string; mapMode: Settings['map']['mode'] };
  findings: Finding[];
  state: RunState;
  capabilities: { publish: boolean; chat: boolean };
}

export interface FindingContext {
  hunks: ParsedHunk[];
  snippet: { start: number; lines: string[] } | null;
}

export interface ReviewPlan {
  payload: {
    body: string;
    comments: { path: string; line: number; start_line?: number; body: string }[];
    event: string;
  };
  ids: string[];
  inline: number;
  general: number;
}

async function json<T>(r: Response): Promise<T> {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  run: () => fetch('/api/run').then((r) => json<RunData>(r)),
  context: (id: string) => fetch(`/api/findings/${id}/context`).then((r) => json<FindingContext>(r)),
  code: (file: string, line: number, endLine?: number) =>
    fetch(
      `/api/code?${new URLSearchParams({ file, line: String(line), endLine: endLine ? String(endLine) : '' })}`,
    ).then((r) => json<FindingContext>(r)),
  map: () => fetch('/api/map').then((r) => json<MapStatus>(r)),
  cancelMap: () => fetch('/api/map/cancel', { method: 'POST' }).then((r) => json<MapStatus>(r)),
  resetThread: (url: string) => fetch(url, { method: 'POST' }).then((r) => json<ChatThread>(r)),
  patch: (id: string, body: Partial<FindingState> & { learn?: boolean }) =>
    fetch(`/api/findings/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<FindingState>(r)),
  reset: (id: string) => fetch(`/api/findings/${id}/reset`, { method: 'POST' }).then((r) => json<FindingState>(r)),
  settings: (body: { reportLanguage?: string; commentLanguage?: string; persist?: boolean }) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ reportLanguage: string; commentLanguage: string }>(r)),
  preview: (q: { event: string; summary: string; allGeneral: boolean }) =>
    fetch(
      `/api/publish/preview?${new URLSearchParams({ event: q.event, summary: q.summary, allGeneral: q.allGeneral ? '1' : '' })}`,
    ).then((r) => json<ReviewPlan>(r)),
  publish: (body: { event: string; summary: string; allGeneral: boolean }) =>
    fetch('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ url?: string; count: number; state: RunState }>(r)),
  exportMd: () => fetch('/api/export').then((r) => r.text()),
  shutdown: () => fetch('/api/shutdown', { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
};

const post = <T>(url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(
    (r) => json<T>(r),
  );

export const inboxApi = {
  load: (refresh = false) => fetch(`/api/inbox${refresh ? '?refresh=1' : ''}`).then((r) => json<InboxData>(r)),
  review: (url: string) => post<InboxJob>('/api/inbox/review', { url }),
  cancel: (url: string) => post<InboxJob>('/api/inbox/cancel', { url }),
  dismiss: (url: string) => post<{ ok: boolean }>('/api/inbox/dismiss', { url }),
  open: (runDir: string) => post<{ url: string }>('/api/inbox/open', { runDir }),
};

export interface StreamHandlers {
  onDelta?: (text: string) => void;
  onTool?: (label: string) => void;
  onProgress?: (label: string) => void;
}

/** POST (or GET when `body` is null) + Server-Sent Events. Resolves with the `done` payload. */
export async function stream<T>(url: string, body: unknown, h: StreamHandlers, signal?: AbortSignal): Promise<T> {
  const r = await fetch(
    url,
    body === null
      ? { signal }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal },
  );
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result: T | undefined;
  let error: string | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trimStart();
      }
      const payload = data ? JSON.parse(data) : {};
      if (event === 'delta') h.onDelta?.(payload.text);
      else if (event === 'tool') h.onTool?.(payload.label);
      else if (event === 'progress') h.onProgress?.(payload.label);
      else if (event === 'done') result = payload;
      else if (event === 'error') error = payload.message;
    }
  }
  if (error) throw new Error(error);
  if (result === undefined) throw new Error('Connection closed');
  return result;
}
