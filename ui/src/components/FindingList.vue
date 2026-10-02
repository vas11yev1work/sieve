<script setup lang="ts">
import { store, visible, findingState } from '../store';
import { t } from '../i18n';
import { Check, MessageSquareText, LoaderCircle, Inbox } from 'lucide-vue-next';
</script>

<template>
  <div class="list scroll">
    <div v-if="!visible.length" class="empty muted">
      <Inbox :size="28" :stroke-width="1.5" />
      <div>{{ store.run?.findings.length ? t.noFindings : t.nothingFound }}</div>
    </div>
    <button
      v-for="f in visible"
      :key="f.id"
      class="item"
      :class="{ active: f.id === store.selected, done: findingState(f.id).status !== 'open' }"
      @click="store.selected = f.id"
    >
      <div class="top">
        <span class="sev" :class="f.severity">{{ f.severity }}</span>
        <span class="chip">{{ f.category }}</span>
        <span class="grow" />
        <LoaderCircle v-if="store.pending[f.id]" :size="14" class="spin muted" />
        <span v-if="findingState(f.id).published" class="chip ok"><Check :size="12" /> {{ t.published }}</span>
        <span v-else-if="findingState(f.id).comment" class="chip accent" :title="t.comment"
          ><MessageSquareText :size="12"
        /></span>
      </div>
      <div class="title">{{ f.title }}</div>
      <div class="loc mono muted">
        {{ f.file }}:{{ f.line }}<template v-if="f.endLine">–{{ f.endLine }}</template>
      </div>
    </button>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  height: 100%;
}
.empty {
  padding: 32px 12px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
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
.item.done .title {
  color: var(--muted);
}
.top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.grow {
  flex: 1;
}
.title {
  font-weight: 550;
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.loc {
  font-size: 11.5px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
</style>
