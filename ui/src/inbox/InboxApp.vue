<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RefreshCw, LoaderCircle, CircleAlert, Search, Inbox, Power, Info } from 'lucide-vue-next';
import type { InboxBucket, InboxData, InboxPr } from '../../../shared/types';
import { inboxApi } from '../api';
import { t, uiLang } from '../i18n';
import { langCode } from '../store';
import InboxRow from './InboxRow.vue';
import ReviewerPicker from './ReviewerPicker.vue';
import LanguagePicker from '../components/LanguagePicker.vue';
import { ago } from './ago';

const data = ref<InboxData | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref('');
const filter = ref('');
const opening = ref('');
const tick = ref(Date.now());
const stopped = ref(false);
/** PR whose "Review" was clicked: the reviewer picker is open for it. */
const picking = ref<InboxPr | null>(null);

const ORDER: InboxBucket[] = ['reviewing', 'review'];

async function load(refresh = false) {
  refreshing.value = refresh;
  try {
    data.value = await inboxApi.load(refresh);
    uiLang.value = langCode(data.value.reportLanguage);
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

const matches = (p: InboxPr, q: string) =>
  !q ||
  [`${p.owner}/${p.repo}`, p.title, p.author, `#${p.number}`, String(p.number)].some((s) =>
    s.toLowerCase().includes(q),
  );

/** Findings of the run on the current head still wait for you. */
const pending = (p: InboxPr) =>
  p.runs.some((r) => r.onHead && !r.reviews.length && (r.status.open > 0 || r.unpublished > 0));

/**
 * Not approved by anyone first, approved by others below; within each, PRs whose Sieve findings
 * wait for you go first (a just-finished review stays in view), then the most recently updated.
 */
const byNeed = (a: InboxPr, b: InboxPr) =>
  Number(a.approvals > 0) - Number(b.approvals > 0) ||
  Number(pending(b)) - Number(pending(a)) ||
  b.updatedAt.localeCompare(a.updatedAt);

const groups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const prs = (data.value?.prs || []).filter((p) => matches(p, q));
  return ORDER.map((id) => ({
    id,
    prs: prs.filter((p) => p.bucket === id).sort(byNeed),
  })).filter((g) => g.prs.length);
});

/** Jobs started before this one that have not finished — for "Queued, 2 ahead". */
const queue = computed(() =>
  (data.value?.prs || [])
    .map((p) => p.job)
    .filter((j) => j && (j.state === 'queued' || j.state === 'running'))
    .sort((a, b) => a!.queuedAt.localeCompare(b!.queuedAt))
    .map((j) => j!.url),
);
const ahead = (url: string) => Math.max(0, queue.value.indexOf(url));

const anyActive = computed(() => queue.value.length > 0);
const total = computed(() => data.value?.prs.length || 0);

async function call(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    error.value = (e as Error).message;
  }
  await load();
}

function review(only: string[]) {
  const p = picking.value!;
  picking.value = null;
  void call(() => inboxApi.review(p.url, only));
}
const cancel = (p: InboxPr) => call(() => inboxApi.cancel(p.url));
const dismiss = (p: InboxPr) => call(() => inboxApi.dismiss(p.url));

async function setLanguages(body: { reportLanguage: string; commentLanguage: string; persist: boolean }) {
  try {
    const l = await inboxApi.settings(body);
    if (data.value) Object.assign(data.value, l);
    uiLang.value = langCode(l.reportLanguage);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function stop() {
  if (!confirm(anyActive.value ? t.value.inbox.stopConfirmBusy : t.value.inbox.stopConfirm)) return;
  await inboxApi.shutdown().catch(() => {});
  stopped.value = true;
}

async function open(p: InboxPr, runDir: string) {
  // Open the tab now: browsers block window.open after an await.
  const w = window.open('', '_blank');
  opening.value = p.url;
  try {
    const { url } = await inboxApi.open(runDir);
    if (w) w.location.href = url;
    else location.href = url;
    await load();
  } catch (e) {
    w?.close();
    error.value = (e as Error).message;
  } finally {
    opening.value = '';
  }
}

// Poll while reviews run; otherwise re-read when the tab comes back after a while.
let poll: ReturnType<typeof setInterval> | undefined;
watch([anyActive, stopped], ([on, off]) => {
  clearInterval(poll);
  if (on && !off) poll = setInterval(() => void load(), 2500);
});
const clock = setInterval(() => (tick.value = Date.now()), 30_000);
function onFocus() {
  if (stopped.value) return;
  const at = data.value?.fetchedAt ? Date.parse(data.value.fetchedAt) : 0;
  if (Date.now() - at > 60_000) void load();
}

onMounted(() => {
  document.title = 'Sieve inbox';
  void load();
  window.addEventListener('focus', onFocus);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  clearInterval(clock);
  window.removeEventListener('focus', onFocus);
});

const updated = computed(() => {
  void tick.value;
  return data.value?.fetchedAt ? t.value.inbox.updated(ago(data.value.fetchedAt)) : '';
});
const counts = computed(() => Object.fromEntries(groups.value.map((g) => [g.id, g.prs.length])));
</script>

<template>
  <div v-if="loading" class="center muted"><LoaderCircle :size="22" class="spin" /></div>
  <div v-else-if="stopped" class="center muted">{{ t.inbox.stopped }}</div>

  <div v-else class="page">
    <header class="bar">
      <div class="brand">
        <img src="/logo.svg" width="24" height="24" alt="" />
        <span>Sieve</span>
      </div>
      <h1>{{ t.inbox.title }}</h1>
      <nav v-if="data?.enabled && total" class="jump" aria-label="Groups">
        <a v-for="g in groups" :key="g.id" :href="`#${g.id}`" :class="`b-${g.id}`">
          {{ t.inbox.groups[g.id]![0] }} <span class="n">{{ counts[g.id] }}</span>
        </a>
      </nav>
      <span class="grow" />
      <span v-if="data?.viewer" class="muted who">@{{ data.viewer }}</span>
      <span class="muted updated">{{ updated }}</span>
      <button class="ghost" :disabled="refreshing" :title="updated" @click="load(true)">
        <RefreshCw :size="14" :class="{ spin: refreshing }" /> {{ t.inbox.refresh }}
      </button>
      <LanguagePicker
        v-if="data"
        :report="data.reportLanguage"
        :comment="data.commentLanguage"
        :save-label="t.inbox.saveDefault"
        @apply="setLanguages"
      />
      <button class="ghost" :title="t.inbox.stop" @click="stop"><Power :size="15" /> {{ t.inbox.stop }}</button>
    </header>

    <main class="main">
      <div v-if="data && !data.enabled" class="state">
        <Inbox :size="28" class="muted" />
        <h2>{{ t.inbox.off }}</h2>
        <p class="muted">{{ t.inbox.offText }}</p>
        <pre>{ "inbox": { "enabled": true } }</pre>
      </div>

      <template v-else>
        <div v-if="error || data?.error" class="banner" role="alert">
          <CircleAlert :size="16" />
          <div>
            <strong>{{ data?.error && !error ? t.inbox.ghError : error }}</strong>
            <div v-if="data?.error && !error" class="muted">{{ data.error }}</div>
            <div v-if="data?.error && !error" class="muted">{{ t.inbox.ghErrorHint }}</div>
          </div>
        </div>

        <div class="tools">
          <label class="search">
            <Search :size="15" class="muted" />
            <input v-model="filter" type="text" :placeholder="t.inbox.filter" :aria-label="t.inbox.filter" />
          </label>
          <span
            v-if="data?.query"
            class="query"
            tabindex="0"
            :title="`${t.inbox.search}: ${data.query}`"
            :aria-label="`${t.inbox.search}: ${data.query}`"
            ><Info :size="16"
          /></span>
        </div>

        <div v-if="!total" class="state">
          <Inbox :size="28" class="muted" />
          <h2>{{ t.inbox.empty }}</h2>
        </div>
        <div v-else-if="!groups.length" class="state muted">{{ t.inbox.emptyFiltered }}</div>

        <section v-for="g in groups" :id="g.id" :key="g.id" class="group" :class="`b-${g.id}`">
          <div class="ghead">
            <h2>{{ t.inbox.groups[g.id]![0] }}</h2>
            <span class="n">{{ g.prs.length }}</span>
            <span class="hint muted">{{ t.inbox.groups[g.id]![1] }}</span>
          </div>
          <div class="list">
            <div class="cols muted" aria-hidden="true">
              <span>{{ t.inbox.colPr }}</span>
              <span>{{ t.inbox.colGithub }}</span>
              <span>{{ t.inbox.colSieve }}</span>
              <span />
            </div>
            <InboxRow
              v-for="p in g.prs"
              :key="p.url"
              :pr="p"
              :ahead="ahead(p.url)"
              :opening="opening === p.url"
              @review="picking = p"
              @cancel="cancel(p)"
              @dismiss="dismiss(p)"
              @open="(dir) => open(p, dir)"
            />
          </div>
        </section>
      </template>
    </main>
    <ReviewerPicker v-if="picking" :pr="picking" @start="review" @close="picking = null" />
  </div>
</template>

<style scoped>
.page {
  --inbox-cols: minmax(0, 1.7fr) minmax(170px, 0.8fr) minmax(220px, 1fr) 128px;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.center {
  height: 100%;
  display: grid;
  place-items: center;
}
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.01em;
}
h1 {
  margin: 0;
  padding-left: 16px;
  border-left: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
}
.jump {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--panel-2);
  border-radius: 10px;
  min-width: 0;
  overflow: hidden;
}
.jump a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 7px;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
}
.jump a:hover {
  background: var(--panel);
  color: var(--text);
  text-decoration: none;
}
.n {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  background: var(--panel-2);
  color: var(--muted);
  border-radius: 999px;
  padding: 0 7px;
}
.jump .n {
  background: var(--panel);
}
.jump a .n {
  background: var(--accent);
  color: var(--accent-text);
}
.grow {
  flex: 1;
}
.who,
.updated {
  font-size: 12.5px;
  white-space: nowrap;
}
.main {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px 64px;
}
.main > * {
  max-width: 1320px;
  margin-left: auto;
  margin-right: auto;
}
.banner {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  margin-bottom: 16px;
  border-radius: var(--radius);
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 13px;
}
.banner .lucide {
  margin-top: 2px;
}
.tools {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}
.search {
  flex: 0 1 420px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.search input {
  border: none;
  padding: 8px 0;
  background: transparent;
  box-shadow: none !important;
}
.query {
  display: inline-flex;
  color: var(--muted);
  cursor: help;
  border-radius: 50%;
}
.query:hover,
.query:focus-visible {
  color: var(--text);
  outline: none;
}
.query:focus-visible {
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.cols {
  display: grid;
  grid-template-columns: var(--inbox-cols);
  gap: 20px;
  padding: 7px 20px 7px 20px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel-2) 50%, transparent);
}
.group {
  margin-bottom: 28px;
}
.ghead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 0 4px 8px;
}
.ghead h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.ghead .n {
  background: var(--accent);
  color: var(--accent-text);
}
.hint {
  font-size: 12.5px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.list {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 72px 16px;
  text-align: center;
}
.state h2 {
  margin: 0;
  font-size: 17px;
}
.state p {
  margin: 0;
}
.state pre {
  margin: 4px 0 0;
}
/* Room for the group links first; the time is also in the Refresh button's tooltip. */
@media (max-width: 1360px) {
  .who,
  .updated {
    display: none;
  }
}
@media (max-width: 960px) {
  .cols,
  .jump,
  .who {
    display: none;
  }
}
@media (max-width: 560px) {
  .main {
    padding: 16px 12px 48px;
  }
  .updated,
  .hint {
    display: none;
  }
  .bar {
    gap: 10px;
  }
}
</style>
