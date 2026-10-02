<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { store, load, counts, current, move, setLanguages, findingState, visible, type Tab } from './store'
import { t } from './i18n'
import FindingList from './components/FindingList.vue'
import FindingDetail from './components/FindingDetail.vue'
import ChatPanel from './components/ChatPanel.vue'
import PublishDialog from './components/PublishDialog.vue'
import { Funnel, GitBranch, ArrowRight, Languages, Send, Copy, Keyboard, LoaderCircle, CircleAlert, GitPullRequest, FileDiff } from 'lucide-vue-next'

const publishing = ref(false)
const langOpen = ref(false)
const reportLang = ref('')
const commentLang = ref('')
const persist = ref(false)
const chat = ref<InstanceType<typeof ChatPanel> | null>(null)

const LANGS = ['en', 'ru', 'sr', 'uk', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'nl', 'tr', 'zh', 'ja']

const tabs = computed<{ id: Tab; label: string }[]>(() => [
  { id: 'open', label: t.value.open },
  { id: 'accepted', label: t.value.accepted },
  { id: 'rejected', label: t.value.rejected },
  { id: 'filtered', label: t.value.filtered },
])

const ready = computed(() =>
  (store.run?.findings || []).filter((f) => {
    const s = findingState(f.id)
    return s.status === 'accepted' && s.comment && !s.published
  }).length,
)

watch(
  () => store.tab,
  () => {
    if (!visible.value.some((f) => f.id === store.selected)) store.selected = visible.value[0]?.id || ''
  },
)

function openLang() {
  reportLang.value = store.run?.settings.reportLanguage || 'en'
  commentLang.value = store.run?.settings.commentLanguage || 'en'
  persist.value = false
  langOpen.value = !langOpen.value
}

async function applyLang() {
  await setLanguages({ reportLanguage: reportLang.value.trim(), commentLanguage: commentLang.value.trim(), persist: persist.value })
  langOpen.value = false
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return
  if (e.metaKey || e.ctrlKey || e.altKey || publishing.value) return
  if (e.key === 'j' || e.key === 'ArrowDown') {
    move(1)
    e.preventDefault()
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    move(-1)
    e.preventDefault()
  } else if (e.key === 'a' && current.value) chat.value?.accept()
  else if (e.key === 'r' && current.value) chat.value?.startReject()
  else if (e.key === 'g' && current.value) chat.value?.generate()
}

onMounted(() => {
  load()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="store.loading" class="center muted"><LoaderCircle :size="22" class="spin" /></div>
  <div v-else-if="store.error" class="center error"><div><CircleAlert :size="22" /> {{ store.error }}</div></div>

  <div v-else-if="store.run" class="app">
    <header class="bar">
      <div class="brand">
        <Funnel :size="20" :stroke-width="2.25" class="logo" />
        <span>Sieve</span>
      </div>
      <div class="pr">
        <div class="title">
          <a v-if="store.run.meta.url" :href="store.run.meta.url" target="_blank" rel="noopener">
            <GitPullRequest :size="15" class="muted" /> <span v-if="store.run.meta.number" class="muted">#{{ store.run.meta.number }}</span>
            {{ store.run.meta.title }}
          </a>
          <span v-else><FileDiff :size="15" class="muted" /> {{ store.run.meta.title }}</span>
        </div>
        <div class="sub muted">
          <span v-if="store.run.meta.owner">{{ store.run.meta.owner }}/{{ store.run.meta.repo }} · </span>
          <span class="mono branch"><GitBranch :size="12" /> {{ store.run.meta.headRef }} <ArrowRight :size="12" /> {{ store.run.meta.baseRef }}</span>
          <span v-if="store.run.meta.author"> · @{{ store.run.meta.author }}</span>
          · {{ store.run.meta.changedFiles }} {{ t.files }}
          <span v-if="store.run.meta.isDraft" class="chip">{{ t.draft }}</span>
        </div>
      </div>

      <div class="actions">
        <div class="lang-wrap">
          <button class="ghost" :title="t.languageHint" @click="openLang">
            <Languages :size="15" /> <span class="mono">{{ store.run.settings.reportLanguage }}</span> / <span class="mono">{{ store.run.settings.commentLanguage }}</span>
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
      </div>
    </header>

    <nav class="tabs">
      <button v-for="tb in tabs" :key="tb.id" class="tab" :class="{ active: store.tab === tb.id }" @click="store.tab = tb.id">
        {{ tb.label }} <span class="n">{{ counts[tb.id] }}</span>
      </button>
      <span class="grow" />
      <span class="muted shortcuts"><Keyboard :size="13" /> {{ t.shortcuts }}</span>
    </nav>

    <main class="grid">
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

    <PublishDialog v-if="publishing" @close="publishing = false" />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
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
  color: var(--accent);
}
.branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pr .sub {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
.lang-wrap {
  position: relative;
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
