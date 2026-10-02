<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { api, type ReviewPlan } from '../api'
import { store } from '../store'
import { t } from '../i18n'
import Markdown from './Markdown.vue'
import {
  X,
  CircleCheck,
  ExternalLink,
  Copy,
  ClipboardCheck,
  Send,
  LoaderCircle,
  Info,
  MessageSquareText,
  FileText,
} from 'lucide-vue-next'

const emit = defineEmits<{ close: [] }>()

const event = ref('COMMENT')
const summary = ref('')
const allGeneral = ref(false)
const plan = ref<ReviewPlan | null>(null)
const busy = ref(false)
const error = ref('')
const done = ref<{ url?: string; count: number } | null>(null)
const copied = ref(false)

const isPr = store.run?.meta.mode === 'pr'
const canPublish = store.run?.capabilities.publish

let timer: ReturnType<typeof setTimeout> | undefined
async function refresh() {
  try {
    plan.value = await api.preview({ event: event.value, summary: summary.value, allGeneral: allGeneral.value })
  } catch (e) {
    error.value = (e as Error).message
  }
}
watch([event, allGeneral], refresh)
watch(summary, () => {
  clearTimeout(timer)
  timer = setTimeout(refresh, 400)
})
onMounted(refresh)

async function publish() {
  busy.value = true
  error.value = ''
  try {
    const r = await api.publish({ event: event.value, summary: summary.value, allGeneral: allGeneral.value })
    if (store.run) store.run.state = r.state
    done.value = { url: r.url, count: r.count }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function copyMd() {
  const md = await api.exportMd()
  await navigator.clipboard.writeText(md)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

const nothing = () => !plan.value || (!plan.value.ids.length && !summary.value.trim() && event.value === 'COMMENT')
</script>

<template>
  <div class="backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true">
      <header>
        <h3><Send :size="16" /> {{ t.publishTitle }}</h3>
        <button class="ghost icon" :aria-label="t.cancel" @click="emit('close')"><X :size="18" /></button>
      </header>

      <div v-if="done" class="body done">
        <CircleCheck :size="40" :stroke-width="1.5" class="ok-icon" />
        <div class="big">{{ t.publishedOk }}</div>
        <div class="muted count"><MessageSquareText :size="14" /> {{ done.count }}</div>
        <a v-if="done.url" class="primary-link" :href="done.url" target="_blank" rel="noopener"
          >{{ t.openOnGithub }} <ExternalLink :size="14"
        /></a>
      </div>

      <div v-else class="body">
        <div v-if="!isPr" class="notice"><Info :size="15" /> {{ t.localMode }}</div>

        <template v-if="isPr">
          <label>
            <span class="label">{{ t.event }}</span>
            <select v-model="event">
              <option value="COMMENT">{{ t.eventComment }}</option>
              <option value="REQUEST_CHANGES">{{ t.eventRequest }}</option>
              <option value="APPROVE">{{ t.eventApprove }}</option>
            </select>
          </label>
          <label>
            <span class="label">{{ t.summary }}</span>
            <textarea v-model="summary" rows="3" />
          </label>
          <label class="check"><input v-model="allGeneral" type="checkbox" /> {{ t.allGeneral }}</label>
        </template>

        <div v-if="plan && !plan.ids.length" class="muted">{{ t.nothingToPublish }}</div>
        <div v-else-if="plan" class="preview scroll">
          <div class="muted counts">{{ plan.inline }} {{ t.inline }} · {{ plan.general }} {{ t.general }}</div>
          <div v-for="(c, i) in plan.payload.comments" :key="i" class="item">
            <div class="mono loc">{{ c.path }}:{{ c.start_line ? `${c.start_line}–` : '' }}{{ c.line }}</div>
            <Markdown :text="c.body" />
          </div>
          <div v-if="plan.payload.body" class="item">
            <div class="mono loc"><FileText :size="12" /> {{ t.general }}</div>
            <Markdown :text="plan.payload.body" />
          </div>
        </div>

        <div v-if="error" class="error">{{ error }}</div>
      </div>

      <footer v-if="!done">
        <button @click="copyMd">
          <ClipboardCheck v-if="copied" :size="14" /><Copy v-else :size="14" /> {{ copied ? t.copied : t.export }}
        </button>
        <span class="grow" />
        <button class="ghost" @click="emit('close')">{{ t.cancel }}</button>
        <button v-if="isPr" class="primary" :disabled="busy || nothing() || !canPublish" @click="publish">
          <LoaderCircle v-if="busy" :size="14" class="spin" /><Send v-else :size="14" /> {{ t.publish }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(10, 10, 20, 0.45);
  display: grid;
  place-items: center;
  z-index: 50;
  padding: 16px;
}
.dialog {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  width: min(720px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
}
header {
  border-bottom: 1px solid var(--border);
  justify-content: space-between;
}
footer {
  border-top: 1px solid var(--border);
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 16px;
}
.body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
}
.check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
}
.preview {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
}
.counts {
  font-size: 12px;
}
.item {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}
.loc {
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 4px;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--hl-bg);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.error {
  color: var(--danger);
  background: var(--danger-weak);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12.5px;
  white-space: pre-wrap;
}
.grow {
  flex: 1;
}
.done {
  align-items: center;
  text-align: center;
  padding: 32px;
}
.big {
  font-size: 20px;
  font-weight: 600;
  color: var(--ok);
}
.primary-link {
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ok-icon {
  color: var(--ok);
}
.count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.icon {
  padding: 4px;
}
.loc {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
