<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { MapFlow, MapNode } from '../../../shared/types';
import { api, type FindingContext } from '../api';
import { store, threadState, sendThread, resetThread } from '../store';
import { KIND_ICONS, mapStore, nodeBase, nodeKey, showFinding, sevCounts } from '../map';
import Markdown from './Markdown.vue';
import { t } from '../i18n';
import DiffView from './DiffView.vue';
import ChatThread from './ChatThread.vue';
import PanelTabs from './PanelTabs.vue';
import { ExternalLink, Eraser, MousePointerClick } from 'lucide-vue-next';

/** Right panel of the graph: the selected step (or the flow when nothing is selected) and the step's chat. */
const props = defineProps<{ flow: MapFlow; node: MapNode | null }>();

const tab = ref<'details' | 'chat'>('details');
const key = computed(() => (props.node ? nodeKey(props.flow.id, props.node.id) : ''));
const base = computed(() => (props.node ? nodeBase(props.flow.id, props.node.id) : ''));
const thread = computed(() => threadState(key.value));
const pending = computed(() => store.pending[key.value]);
const tabs = computed(() => [
  { id: 'details' as const, label: t.value.details },
  { id: 'chat' as const, label: t.value.chat, count: props.node ? thread.value.messages.length : 0 },
]);
const related = computed(() => (store.run?.findings || []).filter((f) => props.node?.findingIds?.includes(f.id)));

const ctx = ref<FindingContext | null>(null);
watch(
  () => [props.node?.file, props.node?.line, props.node?.endLine] as const,
  async ([file, line, endLine]) => {
    ctx.value = null;
    if (!file || !line) return;
    try {
      const c = await api.code(file, line, endLine);
      if (props.node?.file === file && props.node?.line === line) ctx.value = c;
    } catch {
      ctx.value = { hunks: [], snippet: null };
    }
  },
  { immediate: true },
);

const fileLink = computed(() => {
  const m = store.run?.meta;
  const n = props.node;
  if (!m || m.mode !== 'pr' || !m.owner || !n?.file) return '';
  const range = n.line ? (n.endLine ? `#L${n.line}-L${n.endLine}` : `#L${n.line}`) : '';
  return `https://github.com/${m.owner}/${m.repo}/blob/${m.headSha}/${n.file}${range}`;
});
const loc = (n: MapNode) => (n.file ? `${n.file}${n.line ? `:${n.line}${n.endLine ? `–${n.endLine}` : ''}` : ''}` : '');
const SIGN = { added: '+', modified: '~', removed: '−', unchanged: '' } as const;

function pick(id: string) {
  mapStore.nodeId = id;
  mapStore.focusTick++;
}
</script>

<template>
  <div class="panel">
    <PanelTabs v-model="tab" :tabs="tabs">
      <button
        v-if="tab === 'chat' && node && thread.messages.length && !pending"
        class="ghost reset"
        @click="resetThread(key, base)"
      >
        <Eraser :size="14" /> {{ t.resetChat }}
      </button>
    </PanelTabs>

    <!-- Details: the selected step -->
    <div v-if="tab === 'details' && node" class="body scroll">
      <div class="meta">
        <span class="chip accent"><component :is="KIND_ICONS[node.kind]" :size="12" /> {{ node.kind }}</span>
        <span v-if="node.change !== 'unchanged'" class="chip chg" :class="node.change">{{
          t[node.change as 'added' | 'modified' | 'removed']
        }}</span>
      </div>
      <h3><Markdown inline :text="node.label" /></h3>
      <div v-if="loc(node)" class="loc mono">
        <a v-if="fileLink" :href="fileLink" target="_blank" rel="noopener"
          >{{ loc(node) }} <ExternalLink :size="12"
        /></a>
        <span v-else>{{ loc(node) }}</span>
      </div>

      <section v-if="node.summary">
        <h4>{{ t.whatHappens }}</h4>
        <p><Markdown inline :text="node.summary" /></p>
      </section>
      <section v-if="node.changeSummary">
        <h4>{{ t.whatChanged }}</h4>
        <p><Markdown inline :text="node.changeSummary" /></p>
      </section>

      <section v-if="related.length">
        <h4>{{ t.stepFindings }}</h4>
        <button v-for="f in related" :key="f.id" class="finding" @click="showFinding(f.id)">
          <span class="sev" :class="f.severity">{{ f.severity }}</span>
          <Markdown inline class="ftitle" :text="f.title" />
        </button>
      </section>

      <section v-if="node.file && node.line">
        <h4>{{ t.code }}</h4>
        <DiffView :ctx="ctx" :line="node.line" :end-line="node.endLine" />
      </section>
    </div>

    <!-- Details: the flow, when no step is selected -->
    <div v-else-if="tab === 'details'" class="body scroll">
      <h3><Markdown inline :text="flow.title" /></h3>
      <p class="muted"><Markdown inline :text="flow.description" /></p>
      <section v-if="flow.trigger">
        <h4>{{ t.trigger }}</h4>
        <p><Markdown inline :text="flow.trigger" /></p>
      </section>
      <section>
        <h4>{{ t.steps }}</h4>
        <ol class="steps">
          <li v-for="n in flow.nodes" :key="n.id">
            <button class="step" :class="n.change" @click="pick(n.id)">
              <component :is="KIND_ICONS[n.kind]" :size="14" class="kind" />
              <Markdown inline class="slabel" :text="n.label" />
              <span v-for="s in sevCounts(n.findingIds || [])" :key="s.sev" class="sevn" :class="s.sev">{{ s.n }}</span>
              <span v-if="n.change !== 'unchanged'" class="sign">{{ SIGN[n.change] }}</span>
            </button>
          </li>
        </ol>
      </section>
    </div>

    <ChatThread
      v-else-if="node"
      :thread-key="key"
      :messages="thread.messages"
      :placeholder="t.nodeChatPlaceholder"
      :empty="t.nodeChatEmpty"
      @send="(m) => sendThread(key, base, m)"
    />
    <div v-else class="pick muted">
      <MousePointerClick :size="26" :stroke-width="1.5" />
      {{ t.discussPick }}
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.reset {
  padding: 4px 8px;
  font-size: 12.5px;
}
.body {
  flex: 1;
  min-height: 0;
  padding: 16px 16px 24px;
}
.meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.chip.chg {
  color: var(--c);
  background: color-mix(in srgb, var(--c) 14%, transparent);
}
.chip.added {
  --c: var(--chg-added);
}
.chip.modified {
  --c: var(--chg-modified);
}
.chip.removed {
  --c: var(--chg-removed);
}
h3 {
  margin: 0 0 4px;
  font-size: 16px;
  line-height: 1.35;
  word-break: break-word;
}
h4 {
  margin: 0 0 4px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
}
.body > p {
  margin: 0 0 16px;
  font-size: 13.5px;
}
.loc {
  font-size: 12px;
  margin-bottom: 16px;
  word-break: break-all;
}
.loc a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
section {
  margin-bottom: 18px;
}
section p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
}
.finding {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  margin-top: 6px;
  padding: 8px 10px;
}
.ftitle {
  font-weight: 550;
  font-size: 13px;
  line-height: 1.35;
}
.steps {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.step {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--step-bg);
  padding: 9px 10px 9px 12px;
  font-size: 13px;
  /* change indicator on the left, inside the rounded corner */
  box-shadow: inset 3px 0 0 var(--c, transparent);
}
.step:hover:not(:disabled) {
  background: var(--step-bg);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.step:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.step.unchanged {
  color: var(--muted);
}
.step.added {
  --c: var(--chg-added);
}
.step.modified {
  --c: var(--chg-modified);
}
.step.removed {
  --c: var(--chg-removed);
}
.step .kind {
  color: var(--accent);
}
.slabel {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.sign {
  font: 700 13px/1 var(--mono);
  color: var(--c);
}
.pick {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}
</style>
