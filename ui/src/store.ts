import { reactive, computed } from 'vue';
import type { Finding, FindingState, FindingStatus } from '../../shared/types';
import { api, stream, type RunData } from './api';
import { uiLang } from './i18n';

export type Tab = FindingStatus | 'filtered' | 'all';
/** Category filter on top of the status tabs: quality findings vs everything else. */
export type Kind = 'all' | 'issues' | 'quality';

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
  tab: 'open' as Tab,
  kind: 'all' as Kind,
  selected: '' as string,
  pending: {} as Record<string, Pending>,
  errors: {} as Record<string, string>,
});

function langCode(l: string) {
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

function matchesKind(f: Finding, kind: Kind) {
  return kind === 'all' || (kind === 'quality') === (f.category === 'quality');
}

function matchesStatus(f: Finding, tab: Tab) {
  if (tab === 'all') return true;
  if (tab === 'filtered') return f.filtered;
  return !f.filtered && findingState(f.id).status === tab;
}

export const matchesTab = (f: Finding, tab: Tab) => matchesKind(f, store.kind) && matchesStatus(f, tab);

export const visible = computed(() => (store.run?.findings || []).filter((f) => matchesTab(f, store.tab)));

export const counts = computed(() => {
  const c: Record<Tab, number> = { open: 0, accepted: 0, rejected: 0, filtered: 0, all: 0 };
  for (const f of store.run?.findings || []) {
    if (!matchesKind(f, store.kind)) continue;
    c.all++;
    if (f.filtered) c.filtered++;
    else c[findingState(f.id).status]++;
  }
  return c;
});

export const kindCounts = computed(() => {
  const c: Record<Kind, number> = { all: 0, issues: 0, quality: 0 };
  for (const f of store.run?.findings || []) {
    if (!matchesStatus(f, store.tab)) continue;
    c.all++;
    c[f.category === 'quality' ? 'quality' : 'issues']++;
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

async function runStream(id: string, kind: 'chat' | 'comment', message?: string) {
  if (store.pending[id]) return;
  const abort = new AbortController();
  store.errors[id] = '';
  if (kind === 'chat' && message) {
    // optimistic user message
    const st = findingState(id);
    setState(id, { ...st, messages: [...st.messages, { role: 'user', text: message, at: new Date().toISOString() }] });
  }
  store.pending[id] = { kind, text: '', abort };
  try {
    const res = await stream<{ state: FindingState; noComment?: boolean }>(
      `/api/findings/${id}/${kind}`,
      kind === 'chat' ? { message } : {},
      {
        onDelta: (t) => {
          const p = store.pending[id];
          if (p) {
            p.text += t;
            p.tool = undefined;
          }
        },
        onTool: (label) => {
          const p = store.pending[id];
          if (p) p.tool = label;
        },
      },
      abort.signal,
    );
    setState(id, res.state);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/abort/i.test(msg)) store.errors[id] = msg;
    // resync with server (the user message was saved there)
    try {
      const fresh = await api.run();
      if (store.run) store.run.state = fresh.state;
    } catch {}
  } finally {
    delete store.pending[id];
  }
}

export const sendChat = (id: string, message: string) => runStream(id, 'chat', message);
export const generateComment = (id: string) => runStream(id, 'comment');
export const stopStream = (id: string) => store.pending[id]?.abort.abort();

export async function resetChat(id: string) {
  setState(id, await api.reset(id));
}

export async function setLanguages(body: { reportLanguage?: string; commentLanguage?: string; persist?: boolean }) {
  const s = await api.settings(body);
  if (store.run) store.run.settings = s;
  uiLang.value = langCode(s.reportLanguage);
}
