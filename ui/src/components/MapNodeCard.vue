<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import type { MapNode } from '../../../shared/types';
import { KIND_ICONS, mapStore, sevCounts } from '../map';
import Markdown from './Markdown.vue';

/** A connection point for exactly one edge; `offset` (px) shifts it from the middle of its side. */
export interface Port {
  id: string;
  type: 'source' | 'target';
  side: Position;
  offset: number;
}

const props = defineProps<{ id: string; data: { node: MapNode; ports: Port[] } }>();
const along = (p: Port) =>
  p.side === Position.Top || p.side === Position.Bottom
    ? { left: `calc(50% + ${p.offset}px)` }
    : { top: `calc(50% + ${p.offset}px)` };
const n = computed(() => props.data.node);
const sevs = computed(() => sevCounts(n.value.findingIds || []));
const SIGN = { added: '+', modified: '~', removed: '−', unchanged: '' } as const;
</script>

<template>
  <div class="card" :class="[n.change, { selected: mapStore.nodeId === id }]">
    <Handle
      v-for="p in data.ports"
      :id="p.id"
      :key="p.id"
      :type="p.type"
      :position="p.side"
      :style="along(p)"
      :connectable="false"
    />
    <div class="top">
      <component :is="KIND_ICONS[n.kind]" :size="14" class="kind" />
      <span class="kind-name">{{ n.kind }}</span>
      <span class="grow" />
      <span v-for="s in sevs" :key="s.sev" class="sevn" :class="s.sev">{{ s.n }}</span>
      <span v-if="n.change !== 'unchanged'" class="chg" :title="n.change">{{ SIGN[n.change] }}</span>
    </div>
    <div class="label"><Markdown inline :text="n.label" /></div>
    <div v-if="n.file" class="loc mono">
      {{ n.file }}<template v-if="n.line">:{{ n.line }}</template>
    </div>
  </div>
</template>

<style scoped>
.card {
  width: 260px;
  padding: 8px 10px 9px 12px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--border);
  box-shadow: var(--shadow);
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s,
    opacity 0.12s;
}
.card.unchanged {
  background: var(--panel-2);
  box-shadow: none;
}
.card.unchanged .label,
.card.unchanged .kind {
  color: var(--muted);
}
.card.added {
  border-left-color: var(--chg-added);
  --chg: var(--chg-added);
}
.card.modified {
  border-left-color: var(--chg-modified);
  --chg: var(--chg-modified);
}
.card.removed {
  border-left-color: var(--chg-removed);
  --chg: var(--chg-removed);
}
.card.removed .label {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--chg-removed) 60%, transparent);
}
.card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.card.added.selected,
.card.modified.selected,
.card.removed.selected {
  border-left-color: var(--chg);
}
.top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}
.kind {
  color: var(--accent);
}
.kind-name {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
}
.grow {
  flex: 1;
}
.chg {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font: 700 13px/1 var(--mono);
  color: var(--chg);
  background: color-mix(in srgb, var(--chg) 16%, transparent);
}
.label {
  font-weight: 600;
  font-size: 13px;
  line-height: 1.35;
  color: var(--text);
  word-break: break-word;
}
.loc {
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.card :deep(.vue-flow__handle) {
  opacity: 0;
  pointer-events: none;
}
</style>
