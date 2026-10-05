import { reactive, computed } from 'vue';
import type { ChatThread, Finding, FindingState, FindingStatus } from '../../shared/types';
import { api, stream, type RunData } from './api';
import { uiLang } from './i18n';

export type Tab = FindingStatus | 'filtered' | 'all';
/** Top-level tab. */
export type View = 'review' | 'map';

interface Pending {
  kind: 'chat' | 'comment';
  text: string;
  tool?: string;
  abort: AbortController;
}

export const store = reactive({
  loading: true,
  error: '',
  run: null as RunData | null,
  view: 'review' as View,
  tab: 'open' as Tab,
  selected: '' as string,
  /** Reviewers whose findings are hidden from the list (filter in the tabs bar). */
  hiddenReviewers: [] as string[],
  /** Keyed by thread: a finding id or `map:<flowId>:<nodeId>`. */
  pending: {} as Record<string, Pending>,
  errors: {} as Record<string, string>,
});

export function langCode(l: string) {
  const s = l.toLowerCase();
  if (s.startsWith('ru') || s.startsWith('рус')) return 'ru';
  return 'en';
}

export async function load() {
  try {
    store.run = await api.run();
    uiLang.value = langCode(store.run.settings.reportLanguage);
    const first = visible.value[0];
    if (first) store.selected = first.id;
  } catch (e) {
    store.error = (e as Error).message;
  } finally {
    store.loading = false;
  }
}

export const findingState = (id: string): FindingState =>
  store.run?.state.findings[id] || { status: 'open', messages: [] };

export const threadState = (key: string): ChatThread => store.run?.state.threads?.[key] || { messages: [] };

function setThread(key: string, s: ChatThread) {
  if (store.run) (store.run.state.threads ??= {})[key] = s;
}

const hidden = (f: Finding) => f.reviewers.length > 0 && f.reviewers.every((r) => store.hiddenReviewers.includes(r));

export function matchesTab(f: Finding, tab: Tab) {
  if (hidden(f)) return false;
  if (tab === 'all') return true;
  if (tab === 'filtered') return f.filtered;
  return !f.filtered && findingState(f.id).status === tab;
}

export const visible = computed(() => (store.run?.findings || []).filter((f) => matchesTab(f, store.tab)));

export const counts = computed(() => {
  const c: Record<Tab, number> = { open: 0, accepted: 0, rejected: 0, filtered: 0, all: 0 };
  for (const f of store.run?.findings || []) {
    if (hidden(f)) continue;
    c.all++;
    if (f.filtered) c.filtered++;
    else c[findingState(f.id).status]++;
  }
  return c;
});

export const current = computed(() => store.run?.findings.find((f) => f.id === store.selected) || null);

function setState(id: string, s: FindingState) {
  if (store.run) store.run.state.findings[id] = s;
}

export async function update(id: string, body: Partial<FindingState> & { learn?: boolean }) {
  setState(id, await api.patch(id, body));
}

/** After accept/reject, jump to the next item that is still in the current tab. */
export function selectNextAfter(id: string) {
  const list = store.run?.findings.filter((f) => matchesTab(f, store.tab)) || [];
  if (list.some((f) => f.id === id)) return;
  const all = store.run?.findings || [];
  const idx = all.findIndex((f) => f.id === id);
  const next = all.slice(idx + 1).find((f) => matchesTab(f, store.tab)) || list[0];
  store.selected = next?.id || '';
}

export function move(delta: number) {
  const list = visible.value;
  if (!list.length) return;
  const i = list.findIndex((f) => f.id === store.selected);
  const n = list[Math.min(list.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta))];
  if (n) store.selected = n.id;
}

/** One streamed answer in a thread; `get`/`set` read and replace the thread's state. */
async function runStream<S extends ChatThread>(
  key: string,
  url: string,
  kind: 'chat' | 'comment',
  message: string | undefined,
  get: () => S,
  set: (s: S) => void,
) {
  if (store.pending[key]) return;
  const abort = new AbortController();
  store.errors[key] = '';
  if (kind === 'chat' && message) {
    // optimistic user message
    const st = get();
    set({ ...st, messages: [...st.messages, { role: 'user', text: message, at: new Date().toISOString() }] });
  }
  store.pending[key] = { kind, text: '', abort };
  try {
    const res = await stream<{ state: S; noComment?: boolean }>(
      url,
      kind === 'chat' ? { message } : {},
      {
        onDelta: (t) => {
          const p = store.pending[key];
          if (p) {
            p.text += t;
            p.tool = undefined;
          }
        },
        onTool: (label) => {
          const p = store.pending[key];
          if (p) p.tool = label;
        },
      },
      abort.signal,
    );
    set(res.state);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/abort/i.test(msg)) store.errors[key] = msg;
    // resync with server (the user message was saved there)
    try {
      const fresh = await api.run();
      if (store.run) store.run.state = fresh.state;
    } catch {}
  } finally {
    delete store.pending[key];
  }
}

const findingStream = (id: string, kind: 'chat' | 'comment', message?: string) =>
  runStream(
    id,
    `/api/findings/${id}/${kind}`,
    kind,
    message,
    () => findingState(id),
    (s) => setState(id, s),
  );

export const sendChat = (id: string, message: string) => findingStream(id, 'chat', message);
export const generateComment = (id: string) => findingStream(id, 'comment');
export const stopStream = (key: string) => store.pending[key]?.abort.abort();

export async function resetChat(id: string) {
  setState(id, await api.reset(id));
}

/** Chat in a non-finding thread; `base` is its API path (…/chat and …/reset live under it). */
export const sendThread = (key: string, base: string, message: string) =>
  runStream(
    key,
    `${base}/chat`,
    'chat',
    message,
    () => threadState(key),
    (s) => setThread(key, s),
  );

export async function resetThread(key: string, base: string) {
  setThread(key, await api.resetThread(`${base}/reset`));
}

export async function setLanguages(body: { reportLanguage?: string; commentLanguage?: string; persist?: boolean }) {
  const s = await api.settings(body);
  if (store.run) store.run.settings = { ...store.run.settings, ...s };
  uiLang.value = langCode(s.reportLanguage);
}
