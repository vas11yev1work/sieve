<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RefreshCw, LoaderCircle, CircleAlert, Search, ChevronRight, Inbox } from 'lucide-vue-next';
import type { InboxBucket, InboxData, InboxPr } from '../../../shared/types';
import { inboxApi } from '../api';
import { t, uiLang } from '../i18n';
import { langCode } from '../store';
import InboxRow from './InboxRow.vue';
import { ago } from './ago';

const data = ref<InboxData | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref('');
const filter = ref('');
const opening = ref('');
const showReviewed = ref(false);
const tick = ref(Date.now());

const ORDER: InboxBucket[] = ['reviewing', 'new', 'triage', 'done', 'reviewed'];

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

const groups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const prs = (data.value?.prs || []).filter((p) => matches(p, q));
  return ORDER.map((id) => ({
    id,
    prs: prs.filter((p) => p.bucket === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
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

const review = (p: InboxPr) => call(() => inboxApi.review(p.url));
const cancel = (p: InboxPr) => call(() => inboxApi.cancel(p.url));
const dismiss = (p: InboxPr) => call(() => inboxApi.dismiss(p.url));

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
watch(anyActive, (on) => {
  clearInterval(poll);
  if (on) poll = setInterval(() => void load(), 2500);
});
const clock = setInterval(() => (tick.value = Date.now()), 30_000);
function onFocus() {
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
      <button class="ghost" :disabled="refreshing" @click="load(true)">
        <RefreshCw :size="14" :class="{ spin: refreshing }" /> {{ t.inbox.refresh }}
      </button>
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
          <span v-if="data?.query" class="muted query" :title="data.query">
            {{ t.inbox.search }}: <span class="mono">{{ data.query }}</span>
          </span>
        </div>

        <div v-if="!total" class="state">
          <Inbox :size="28" class="muted" />
          <h2>{{ t.inbox.empty }}</h2>
        </div>
        <div v-else-if="!groups.length" class="state muted">{{ t.inbox.emptyFiltered }}</div>

        <section v-for="g in groups" :id="g.id" :key="g.id" class="group" :class="`b-${g.id}`">
          <component
            :is="g.id === 'reviewed' ? 'button' : 'div'"
            class="ghead"
            :aria-expanded="g.id === 'reviewed' ? showReviewed : undefined"
            @click="g.id === 'reviewed' && (showReviewed = !showReviewed)"
          >
            <ChevronRight v-if="g.id === 'reviewed'" :size="16" class="chev" :class="{ open: showReviewed }" />
            <h2>{{ t.inbox.groups[g.id]![0] }}</h2>
            <span class="n">{{ g.prs.length }}</span>
            <span class="hint muted">{{ t.inbox.groups[g.id]![1] }}</span>
          </component>
          <div v-if="g.id !== 'reviewed' || showReviewed" class="list">
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
              @review="review(p)"
              @cancel="cancel(p)"
              @dismiss="dismiss(p)"
              @open="(dir) => open(p, dir)"
            />
          </div>
        </section>
      </template>
    </main>
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
.jump a.b-reviewing .n,
.jump a.b-new .n {
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
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.query .mono {
  font-size: 11.5px;
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
  width: 100%;
  border: none;
  background: none;
  border-radius: 0;
  color: inherit;
  text-align: left;
}
button.ghead:hover:not(:disabled) {
  background: none;
}
button.ghead:hover h2 {
  color: var(--accent);
}
.chev {
  align-self: center;
  color: var(--muted);
  transition: transform 0.15s;
}
.chev.open {
  transform: rotate(90deg);
}
.ghead h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.group.b-new .ghead .n,
.group.b-reviewing .ghead .n {
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
.group.b-done .list,
.group.b-reviewed .list {
  background: color-mix(in srgb, var(--panel) 60%, var(--bg));
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
  .query,
  .hint {
    display: none;
  }
  .bar {
    gap: 10px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chev {
    transition: none;
  }
}
</style>
