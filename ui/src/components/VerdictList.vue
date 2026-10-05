<script setup lang="ts">
import { computed } from 'vue';
import { store, matchesTab, type Tab } from '../store';
import { t } from '../i18n';
import Markdown from './Markdown.vue';
import { CircleCheck, CircleDot, TriangleAlert, CircleX } from 'lucide-vue-next';
import type { ReviewerVerdict } from '../../../shared/types';

const emit = defineEmits<{ show: [] }>();

const icons = { clean: CircleCheck, issues: CircleDot, incomplete: TriangleAlert, failed: CircleX };
// Who could not finish comes first: that is what the user must not miss.
const order: ReviewerVerdict['verdict'][] = ['failed', 'incomplete', 'issues', 'clean'];

const rows = computed(() => {
  const findings = store.run?.findings || [];
  return [...(store.run?.reviews || [])]
    .map((r) => ({ ...r, findings: findings.filter((f) => f.reviewers.includes(r.name)).length }))
    .sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.name.localeCompare(b.name));
});

/** Show only this reviewer's findings: hide every other reviewer in the filter. */
function showFindings(name: string) {
  const all = new Set((store.run?.findings || []).flatMap((f) => f.reviewers));
  store.hiddenReviewers = [...all].filter((n) => n !== name);
  // Its findings may all be accepted, rejected or filtered out — open the status tab that has them.
  const mine = (store.run?.findings || []).filter((f) => f.reviewers.includes(name));
  if (!mine.some((f) => matchesTab(f, store.tab))) {
    const tabs: Tab[] = ['open', 'accepted', 'rejected', 'filtered'];
    store.tab = tabs.find((tb) => mine.some((f) => matchesTab(f, tb))) || store.tab;
  }
  emit('show');
}
</script>

<template>
  <div class="list scroll">
    <article v-for="r in rows" :key="r.name" class="item">
      <div class="top">
        <span class="verdict" :class="r.verdict">
          <component :is="icons[r.verdict]" :size="14" /> {{ t.verdicts[r.verdict] }}
        </span>
      </div>
      <div class="name">{{ r.name }}</div>
      <div v-if="r.summary" class="summary"><Markdown inline :text="r.summary" /></div>
      <button v-if="r.findings" class="ghost show" @click="showFindings(r.name)">
        {{ t.showFindings(r.findings) }}
      </button>
    </article>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  padding: 8px;
  height: 100%;
}
.item {
  padding: 10px 12px 12px;
}
.item + .item {
  border-top: 1px solid var(--border);
}
.top {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
}
.verdict {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
}
.clean {
  color: var(--ok);
}
.issues {
  color: var(--sev-minor);
}
.incomplete {
  color: var(--sev-major);
}
.failed {
  color: var(--danger);
}
.name {
  font-weight: 550;
}
.summary {
  margin-top: 4px;
  line-height: 1.45;
  color: var(--muted);
}
/* A reviewer that did not finish: its reason is the thing to read, so it gets the text color. */
.item:has(.incomplete) .summary,
.item:has(.failed) .summary {
  color: var(--text);
}
.show {
  margin-top: 8px;
  padding: 3px 8px;
  margin-left: -8px;
  font-size: 12.5px;
  color: var(--accent);
}
</style>
