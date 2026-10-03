<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import type { MapFlow } from '../../../shared/types';
import { mapStore, prMap, currentFlow, currentNode, buildMap, cancelMap, selectFlow, sevCounts } from '../map';
import { t } from '../i18n';
import MapGraph from './MapGraph.vue';
import MapNodePanel from './MapNodePanel.vue';
import MapSummary from './MapSummary.vue';
import { Network, Sparkles, LoaderCircle, CircleAlert, RotateCcw, RefreshCw, Square, Keyboard } from 'lucide-vue-next';

// Elapsed build time, ticking while building.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => mapStore.status?.state,
  (s) => {
    clearInterval(timer);
    if (s === 'building') timer = setInterval(() => (now.value = Date.now()), 1000);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));
const elapsed = computed(() => {
  const st = mapStore.status;
  if (st?.state !== 'building') return '';
  const s = Math.max(0, Math.round((now.value - Date.parse(st.startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});

const changed = (f: MapFlow) => f.nodes.filter((n) => n.change !== 'unchanged').length;
const flowSevs = (f: MapFlow) => sevCounts(f.nodes.flatMap((n) => n.findingIds || []));

function rebuild() {
  if (confirm(t.value.rebuildConfirm)) buildMap();
}
</script>

<template>
  <div v-if="!mapStore.status || mapStore.status.state === 'none'" class="state">
    <Network :size="40" :stroke-width="1.25" class="accent-icon" />
    <h2>{{ t.mapNone }}</h2>
    <p class="muted">{{ t.mapNoneText }}</p>
    <button class="primary" @click="buildMap"><Sparkles :size="15" /> {{ t.buildMap }}</button>
  </div>

  <div v-else-if="mapStore.status.state === 'building'" class="state">
    <LoaderCircle :size="32" class="spin accent-icon" />
    <h2>
      {{ t.mapBuilding }} <span class="muted mono elapsed">{{ elapsed }}</span>
    </h2>
    <ul class="events mono">
      <li v-for="(e, i) in mapStore.events" :key="e" :class="{ last: i === mapStore.events.length - 1 }">{{ e }}</li>
    </ul>
    <button class="ghost" @click="cancelMap"><Square :size="13" /> {{ t.cancel }}</button>
  </div>

  <div v-else-if="mapStore.status.state === 'error'" class="state">
    <CircleAlert :size="32" class="danger-icon" />
    <h2>{{ t.mapError }}</h2>
    <pre class="err">{{ mapStore.status.error }}</pre>
    <button class="primary" @click="buildMap"><RotateCcw :size="14" /> {{ t.retry }}</button>
  </div>

  <div v-else-if="prMap" class="map">
    <nav class="subnav">
      <button class="tab" :class="{ active: mapStore.tab === 'summary' }" @click="mapStore.tab = 'summary'">
        {{ t.mapSummary }}
      </button>
      <button
        class="tab"
        :class="{ active: mapStore.tab === 'graph' }"
        :disabled="!prMap.flows.length"
        @click="mapStore.tab = 'graph'"
      >
        {{ t.mapGraph }} <span class="n">{{ prMap.flows.length }}</span>
      </button>
      <span class="grow" />
      <span v-if="mapStore.tab === 'graph'" class="muted shortcuts"><Keyboard :size="13" /> {{ t.mapShortcuts }}</span>
      <button class="ghost" @click="rebuild"><RefreshCw :size="14" /> {{ t.rebuild }}</button>
    </nav>

    <MapSummary v-if="mapStore.tab === 'summary' || !prMap.flows.length" :map="prMap" />
    <main v-else class="grid">
      <aside class="col list scroll">
        <button
          v-for="f in prMap.flows"
          :key="f.id"
          class="item"
          :class="{ active: f.id === mapStore.flowId }"
          @click="selectFlow(f.id)"
        >
          <div class="title">{{ f.title }}</div>
          <div class="desc muted">{{ f.description }}</div>
          <div class="stats">
            <span v-if="changed(f)" class="chip chg">{{ changed(f) }} {{ t.changedCount }}</span>
            <span v-for="s in flowSevs(f)" :key="s.sev" class="sevn" :class="s.sev">{{ s.n }}</span>
          </div>
        </button>
      </aside>
      <section class="col graph-col">
        <MapGraph v-if="currentFlow" :key="currentFlow.id" :flow="currentFlow" />
      </section>
      <aside class="col panel-col">
        <MapNodePanel v-if="currentFlow" :flow="currentFlow" :node="currentNode" />
      </aside>
    </main>
  </div>
</template>

<style scoped>
.state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}
.state h2 {
  margin: 0;
  font-size: 18px;
}
.state p {
  max-width: 520px;
  margin: 0 0 6px;
}
.accent-icon {
  color: var(--accent);
}
.danger-icon {
  color: var(--danger);
}
.elapsed {
  font-size: 14px;
  font-weight: 400;
}
.events {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12px;
  color: var(--muted);
  min-height: 100px;
  width: min(520px, 100%);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 2px;
}
.events li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}
.events li.last {
  opacity: 1;
  color: var(--text);
}
.err {
  max-width: 640px;
  white-space: pre-wrap;
  color: var(--danger);
  background: var(--danger-weak);
  border: none;
  text-align: left;
}
.map {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.subnav {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.subnav .tab {
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 5px 10px;
}
.subnav .tab.active {
  background: var(--panel-2);
  color: var(--text);
  font-weight: 600;
}
.subnav .n {
  font-size: 11.5px;
  background: var(--panel-2);
  border-radius: 999px;
  padding: 0 7px;
}
.subnav .tab.active .n {
  background: var(--accent-weak);
  color: var(--accent);
}
.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
}
.pad {
  padding: 6px 12px 4px;
}
.grow {
  flex: 1;
}
.shortcuts {
  font-size: 11.5px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr) minmax(340px, 420px);
  grid-template-rows: minmax(0, 1fr);
}
.col {
  min-height: 0;
  min-width: 0;
}
.list {
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item {
  display: block;
  text-align: left;
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  padding: 10px 12px;
  border-radius: 10px;
}
.item:hover:not(:disabled) {
  background: var(--panel-2);
}
.item.active {
  background: var(--accent-weak);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.item .title {
  font-weight: 600;
  line-height: 1.35;
}
.item .desc {
  font-size: 12.5px;
  line-height: 1.4;
  margin-top: 2px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.stats {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.stats:empty {
  display: none;
}
.chip.chg {
  color: var(--chg-modified);
  background: color-mix(in srgb, var(--chg-modified) 14%, transparent);
}
.graph-col {
  position: relative;
}
.panel-col {
  background: var(--panel);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 240px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .panel-col {
    grid-column: 1 / -1;
    border-left: none;
    border-top: 1px solid var(--border);
    height: 50vh;
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
  .list {
    max-height: 30vh;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .graph-col {
    min-height: 60vh;
  }
}
</style>
