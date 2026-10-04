<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue';
import { store, load, counts, current, move, setLanguages, findingState, visible, type Tab } from './store';
import { t } from './i18n';
import FindingList from './components/FindingList.vue';
import FindingDetail from './components/FindingDetail.vue';
import ChatPanel from './components/ChatPanel.vue';
import PublishDialog from './components/PublishDialog.vue';
import Markdown from './components/Markdown.vue';
import { mapStore, mapEnabled, prMap, loadMap, moveFlow, selectFlow, showNode } from './map';
import {
  GitBranch,
  ArrowRight,
  Languages,
  Send,
  Copy,
  Keyboard,
  LoaderCircle,
  CircleAlert,
  GitPullRequest,
  FileDiff,
  Power,
  ListChecks,
  Network,
  ListFilter,
} from 'lucide-vue-next';
import { api } from './api';

// Vue Flow + dagre are heavy; load them only when the map tab is opened.
const MapView = defineAsyncComponent(() => import('./components/MapView.vue'));

const publishing = ref(false);
const langOpen = ref(false);
const filterOpen = ref(false);
const reportLang = ref('');
const commentLang = ref('');
const persist = ref(false);
const chat = ref<InstanceType<typeof ChatPanel> | null>(null);

const LANGS = ['en', 'ru', 'sr', 'uk', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'nl', 'tr', 'zh', 'ja'];

const tabs = computed<{ id: Tab; label: string }[]>(() => [
  { id: 'open', label: t.value.open },
  { id: 'accepted', label: t.value.accepted },
  { id: 'rejected', label: t.value.rejected },
  { id: 'filtered', label: t.value.filtered },
]);

const reviewerNames = computed(() => [...new Set(store.run?.findings.flatMap((f) => f.reviewers))].sort());

function toggleReviewer(name: string) {
  const h = store.hiddenReviewers;
  store.hiddenReviewers = h.includes(name) ? h.filter((r) => r !== name) : [...h, name];
}

const ready = computed(
  () =>
    (store.run?.findings || []).filter((f) => {
      const s = findingState(f.id);
      return s.status === 'accepted' && s.comment && !s.published;
    }).length,
);

watch(visible, () => {
  if (!visible.value.some((f) => f.id === store.selected)) store.selected = visible.value[0]?.id || '';
});

function openLang() {
  reportLang.value = store.run?.settings.reportLanguage || 'en';
  commentLang.value = store.run?.settings.commentLanguage || 'en';
  persist.value = false;
  langOpen.value = !langOpen.value;
}

async function applyLang() {
  await setLanguages({
    reportLanguage: reportLang.value.trim(),
    commentLanguage: commentLang.value.trim(),
    persist: persist.value,
  });
  langOpen.value = false;
}

async function finish() {
  if (!confirm(t.value.finishConfirm)) return;
  await api.shutdown().catch(() => {});
  store.error = t.value.stopped;
}

// URL hash: #review | #map (summary) | #map/<flowId>[/<nodeId>] (graph) — survives reloads and can be shared.
let target: [string, string] | null = null;

function applyHash() {
  const [v, f = '', n = ''] = location.hash.replace(/^#/, '').split('/').map(decodeURIComponent);
  if (v !== 'map' || !mapEnabled.value) {
    store.view = 'review';
    return;
  }
  store.view = 'map';
  mapStore.tab = f ? 'graph' : 'summary';
  if (f) target = [f, n];
  applyTarget();
}

/** Select the flow/node from the hash once the map is there. */
function applyTarget() {
  const flow = target && prMap.value?.flows.find((x) => x.id === target![0]);
  if (!flow || !target) return;
  const n = target[1];
  target = null;
  if (flow.nodes.some((x) => x.id === n)) showNode(flow.id, n);
  else selectFlow(flow.id);
}

const hash = computed(() =>
  store.view === 'review'
    ? '#review'
    : mapStore.tab === 'summary'
      ? '#map'
      : '#' + ['map', mapStore.flowId, mapStore.nodeId].filter(Boolean).map(encodeURIComponent).join('/'),
);

function onMapKey(e: KeyboardEvent) {
  if (e.code === 'BracketLeft') moveFlow(-1);
  else if (e.code === 'BracketRight') moveFlow(1);
  else if (e.key === 'Escape') mapStore.nodeId = '';
  else if (e.code === 'KeyF') mapStore.fitTick++;
  else return;
  e.preventDefault();
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable))
    return;
  if (e.metaKey || e.ctrlKey || e.altKey || publishing.value) return;
  if (store.view === 'map') return mapStore.tab === 'graph' ? onMapKey(e) : undefined;
  if (e.code === 'KeyJ' || e.key === 'ArrowDown') {
    move(1);
    e.preventDefault();
  } else if (e.code === 'KeyK' || e.key === 'ArrowUp') {
    move(-1);
    e.preventDefault();
  } else if (e.code === 'KeyA' && current.value) chat.value?.accept();
  else if (e.code === 'KeyR' && current.value) chat.value?.startReject();
  else if (e.code === 'KeyG' && current.value) chat.value?.generate();
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  await load();
  await loadMap();
  applyHash();
  watch(prMap, applyTarget);
  watch(hash, (h) => location.hash !== h && history.replaceState(null, '', h), { immediate: true });
  window.addEventListener('hashchange', applyHash);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('hashchange', applyHash);
});
</script>

<template>
  <div v-if="store.loading" class="center muted"><LoaderCircle :size="22" class="spin" /></div>
  <div v-else-if="store.error" class="center error">
    <div class="message"><CircleAlert :size="22" /> {{ store.error }}</div>
  </div>

  <div v-else-if="store.run" class="app">
    <header class="bar">
      <div class="brand">
        <img src="/logo.svg" width="24" height="24" alt="" class="logo" />
        <span>Sieve</span>
      </div>
      <nav v-if="mapEnabled" class="views">
        <button class="view" :class="{ active: store.view === 'review' }" @click="store.view = 'review'">
          <ListChecks :size="15" /> {{ t.review }}
        </button>
        <button class="view" :class="{ active: store.view === 'map' }" @click="store.view = 'map'">
          <Network :size="15" /> {{ t.map }}
          <LoaderCircle v-if="mapStore.status?.state === 'building'" :size="13" class="spin" />
        </button>
      </nav>
      <div class="pr">
        <div class="title">
          <a v-if="store.run.meta.url" :href="store.run.meta.url" target="_blank" rel="noopener">
            <GitPullRequest :size="15" class="muted" />
            <span v-if="store.run.meta.number" class="muted">#{{ store.run.meta.number }}</span>
            <Markdown inline :text="store.run.meta.title" />
          </a>
          <span v-else><FileDiff :size="15" class="muted" /> <Markdown inline :text="store.run.meta.title" /></span>
        </div>
        <div class="sub muted">
          <template v-if="store.run.meta.owner">
            <span>{{ store.run.meta.owner }}/{{ store.run.meta.repo }}</span>
            <span class="dot">·</span>
          </template>
          <span class="mono branch">
            <GitBranch :size="12" /> {{ store.run.meta.headRef }} <ArrowRight :size="12" />
            {{ store.run.meta.baseRef }}
          </span>
          <template v-if="store.run.meta.author">
            <span class="dot">·</span>
            <span>@{{ store.run.meta.author }}</span>
          </template>
          <span class="dot">·</span>
          <span>{{ store.run.meta.changedFiles }} {{ t.files }}</span>
          <span v-if="store.run.meta.isDraft" class="chip">{{ t.draft }}</span>
        </div>
      </div>

      <div class="actions">
        <div class="lang-wrap">
          <button class="ghost" :title="t.languageHint" @click="openLang">
            <Languages :size="15" /> <span class="mono">{{ store.run.settings.reportLanguage }}</span> /
            <span class="mono">{{ store.run.settings.commentLanguage }}</span>
          </button>
          <div v-if="langOpen" class="popover">
            <div class="muted hint">{{ t.languageHint }}</div>
            <label>
              <span>{{ t.report }}</span>
              <input v-model="reportLang" type="text" list="langs" />
            </label>
            <label>
              <span>{{ t.comments }}</span>
              <input v-model="commentLang" type="text" list="langs" />
            </label>
            <label class="check"><input v-model="persist" type="checkbox" /> {{ t.saveDefault }}</label>
            <div class="row">
              <button class="ghost" @click="langOpen = false">{{ t.cancel }}</button>
              <button class="primary" @click="applyLang">OK</button>
            </div>
          </div>
          <datalist id="langs">
            <option v-for="l in LANGS" :key="l" :value="l" />
          </datalist>
        </div>
        <button class="primary" @click="publishing = true">
          <Send v-if="store.run.meta.mode === 'pr'" :size="14" /><Copy v-else :size="14" />
          {{ store.run.meta.mode === 'pr' ? t.publish : t.export }}
          <span v-if="ready" class="count">{{ ready }}</span>
        </button>
        <button class="ghost" :title="t.finish" @click="finish"><Power :size="15" /> {{ t.finish }}</button>
      </div>
    </header>

    <nav v-if="store.view === 'review'" class="tabs">
      <button
        v-for="tb in tabs"
        :key="tb.id"
        class="tab"
        :class="{ active: store.tab === tb.id }"
        @click="store.tab = tb.id"
      >
        {{ tb.label }} <span class="n">{{ counts[tb.id] }}</span>
      </button>
      <div v-if="reviewerNames.length > 1" class="filter-wrap">
        <button class="tab" :class="{ active: store.hiddenReviewers.length }" @click="filterOpen = !filterOpen">
          <ListFilter :size="14" /> {{ t.reviewerFilter }}
          <span v-if="store.hiddenReviewers.length" class="n">
            {{ reviewerNames.length - store.hiddenReviewers.length }}/{{ reviewerNames.length }}
          </span>
        </button>
        <div v-if="filterOpen" class="popover filter-pop">
          <label v-for="r in reviewerNames" :key="r" class="check">
            <input type="checkbox" :checked="!store.hiddenReviewers.includes(r)" @change="toggleReviewer(r)" />
            <span class="mono">{{ r }}</span>
          </label>
        </div>
      </div>
      <span class="grow" />
      <span class="muted shortcuts"><Keyboard :size="13" /> {{ t.shortcuts }}</span>
    </nav>

    <main v-if="store.view === 'review'" class="grid">
      <aside class="col list-col">
        <FindingList />
      </aside>
      <section class="col detail-col">
        <FindingDetail v-if="current" :finding="current" />
        <div v-else class="center muted">{{ t.selectFinding }}</div>
      </section>
      <aside class="col chat-col">
        <ChatPanel v-if="current" ref="chat" :finding="current" />
      </aside>
    </main>
    <main v-else class="map-main"><MapView /></main>

    <PublishDialog v-if="publishing" @close="publishing = false" />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.center {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
}
.error {
  color: var(--danger);
}
.message {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar {
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
.views {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--panel-2);
  border-radius: 10px;
}
.view {
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 4px 10px;
  border-radius: 7px;
}
.view.active {
  background: var(--panel);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow);
}
.view.active:hover:not(:disabled) {
  background: var(--panel);
}
.map-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.pr {
  flex: 1;
  min-width: 0;
  padding-left: 16px;
  border-left: 1px solid var(--border);
}
.pr .title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pr .title a,
.pr .title > span {
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
}
.logo {
  display: block;
}
.branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pr .sub {
  /* one centered row: the branch (icon + mono text) and the plain-text parts share a center line */
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
}
.pr .sub .dot {
  opacity: 0.6;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.count {
  background: rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  padding: 0 7px;
  font-size: 12px;
}
.lang-wrap,
.filter-wrap {
  position: relative;
}
.filter-wrap {
  margin-left: 8px;
  padding-left: 12px;
  border-left: 1px solid var(--border);
}
.filter-wrap .tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.filter-pop {
  left: 12px;
  right: auto;
  width: 200px;
  gap: 2px;
  padding: 6px;
}
.filter-pop .check {
  gap: 10px;
  padding: 6px 8px;
  border-radius: 7px;
  color: var(--text);
  font-size: 12.5px;
}
.filter-pop .check:hover {
  background: var(--panel-2);
}
.popover {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: 280px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 12px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.popover label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
.popover .check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.popover .hint {
  font-size: 12px;
}
.popover .row {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.tab {
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 5px 10px;
}
.tab.active {
  background: var(--panel-2);
  color: var(--text);
  font-weight: 600;
}
.tab .n {
  font-size: 11.5px;
  background: var(--panel-2);
  border-radius: 999px;
  padding: 0 7px;
}
.tab.active .n {
  background: var(--accent-weak);
  color: var(--accent);
}
.grow {
  flex: 1;
}
.shortcuts {
  font-size: 11.5px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr) minmax(340px, 440px);
}
.col {
  min-height: 0;
  min-width: 0;
}
.list-col {
  border-right: 1px solid var(--border);
  background: var(--panel);
}
.detail-col {
  overflow: hidden;
}
.chat-col {
  border-left: 1px solid var(--border);
  background: var(--panel);
}
@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 260px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .chat-col {
    grid-column: 1 / -1;
    border-left: none;
    border-top: 1px solid var(--border);
    max-height: 55vh;
  }
  .shortcuts {
    display: none;
  }
}
@media (max-width: 720px) {
  .grid {
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  .list-col {
    max-height: 35vh;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .pr {
    display: none;
  }
}
</style>
