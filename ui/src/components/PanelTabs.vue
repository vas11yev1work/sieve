<script setup lang="ts" generic="T extends string">
/** Tab bar of a side panel: fixed height, tabs on the left, actions (slot) on the right. */
defineProps<{ tabs: { id: T; label: string; count?: number; warn?: boolean }[] }>();
const active = defineModel<T>({ required: true });
</script>

<template>
  <div class="bar" role="tablist">
    <button
      v-for="tb in tabs"
      :key="tb.id"
      role="tab"
      class="tab"
      :class="{ active: active === tb.id }"
      :aria-selected="active === tb.id"
      @click="active = tb.id"
    >
      {{ tb.label }}<span v-if="tb.count" class="n" :class="{ warn: tb.warn }">{{ tb.count }}</span>
    </button>
    <span class="grow" />
    <slot />
  </div>
</template>

<style scoped>
.bar {
  flex-shrink: 0;
  height: 44px;
  display: flex;
  align-items: stretch;
  gap: 18px;
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--border);
}
.tab {
  position: relative;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
  color: var(--muted);
  font-size: 13.5px;
  font-weight: 500;
}
.tab:hover:not(:disabled) {
  background: transparent;
  color: var(--text);
}
.tab.active {
  color: var(--text);
  font-weight: 600;
}
.tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.n {
  margin-left: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--muted);
}
.tab.active .n {
  background: var(--accent-weak);
  color: var(--accent);
}
.n.warn,
.tab.active .n.warn {
  background: color-mix(in srgb, var(--sev-major) 14%, transparent);
  color: var(--sev-major);
}
.grow {
  flex: 1;
}
.bar > :slotted(*) {
  align-self: center;
}
</style>
