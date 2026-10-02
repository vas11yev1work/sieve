<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { Finding } from '../../../shared/types'
import { api, type FindingContext } from '../api'
import { store } from '../store'
import { t } from '../i18n'
import Markdown from './Markdown.vue'
import DiffView from './DiffView.vue'
import { Users, ShieldCheck, ShieldX, ExternalLink, BookOpen, Wrench, Code, TriangleAlert, Tag } from 'lucide-vue-next'

const props = defineProps<{ finding: Finding }>()
const ctx = ref<FindingContext | null>(null)
const cache = new Map<string, FindingContext>()

watch(
  () => props.finding.id,
  async (id) => {
    ctx.value = cache.get(id) || null
    if (ctx.value) return
    try {
      const c = await api.context(id)
      cache.set(id, c)
      if (props.finding.id === id) ctx.value = c
    } catch {
      ctx.value = { hunks: [], snippet: null }
    }
  },
  { immediate: true },
)

const fileLink = computed(() => {
  const m = store.run?.meta
  if (!m || m.mode !== 'pr' || !m.owner) return ''
  const f = props.finding
  const range = f.endLine ? `L${f.line}-L${f.endLine}` : `L${f.line}`
  return `https://github.com/${m.owner}/${m.repo}/blob/${m.headSha}/${f.file}#${range}`
})

const v = computed(() => props.finding.validation)
</script>

<template>
  <div class="detail scroll">
    <div class="meta">
      <span class="sev" :class="finding.severity">{{ finding.severity }}</span>
      <span class="chip"><Tag :size="12" /> {{ finding.category }}</span>
      <span v-if="finding.reviewers.length" class="chip" :title="t.reviewers">
        <Users :size="12" /> {{ finding.reviewers.join(' · ') }}
      </span>
      <span
        v-if="v.verdict !== 'skipped'"
        class="chip"
        :class="v.verdict === 'valid' ? 'ok' : 'danger'"
        :title="v.reason || ''"
      >
        <ShieldCheck v-if="v.verdict === 'valid'" :size="12" /><ShieldX v-else :size="12" /> {{ v.verdict }}<template v-if="v.confidence !== undefined"> · {{ Math.round(v.confidence * 100) }}%</template>
      </span>
    </div>

    <h2>{{ finding.title }}</h2>

    <div class="loc mono">
      <a v-if="fileLink" :href="fileLink" target="_blank" rel="noopener">{{ finding.file }}:{{ finding.line }}<template v-if="finding.endLine">–{{ finding.endLine }}</template> <ExternalLink :size="12" /></a>
      <span v-else>{{ finding.file }}:{{ finding.line }}<template v-if="finding.endLine">–{{ finding.endLine }}</template></span>
    </div>

    <div v-if="!finding.inDiff" class="notice"><TriangleAlert :size="15" /> {{ t.outsideDiff }}</div>

    <Markdown class="explanation" :text="finding.explanation" />

    <blockquote v-if="finding.rule" class="rule">
      <div class="label"><BookOpen :size="12" /> {{ t.rule }} · <span class="mono">{{ finding.rule.path }}</span></div>
      {{ finding.rule.quote }}
    </blockquote>

    <section v-if="finding.suggestion">
      <div class="label"><Wrench :size="12" /> {{ t.suggestion }}</div>
      <Markdown :text="finding.suggestion" />
    </section>

    <section v-if="v.reason && v.verdict !== 'skipped'">
      <div class="label"><ShieldCheck :size="12" /> {{ t.validation }}</div>
      <Markdown class="muted" :text="v.reason" />
    </section>

    <section>
      <div class="label"><Code :size="12" /> {{ t.code }}</div>
      <DiffView :ctx="ctx" :line="finding.line" :end-line="finding.endLine" />
    </section>
  </div>
</template>

<style scoped>
.detail {
  padding: 20px 24px 32px;
  height: 100%;
}
.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
h2 {
  font-size: 20px;
  line-height: 1.3;
  margin: 10px 0 6px;
  letter-spacing: -0.01em;
}
.loc a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.loc {
  font-size: 12.5px;
  margin-bottom: 14px;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--hl-bg);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 14px;
  font-size: 13px;
}
.explanation {
  font-size: 14.5px;
  margin-bottom: 16px;
}
.rule {
  margin: 0 0 16px;
  padding: 10px 14px;
  border-left: 3px solid var(--accent);
  background: var(--accent-weak);
  border-radius: 0 8px 8px 0;
  font-style: italic;
}
.rule .label {
  font-style: normal;
}
.label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
  margin-bottom: 6px;
}
section {
  margin-bottom: 18px;
}
</style>
