<script setup lang="ts">
import { computed, ref } from 'vue';
import { BookMarked, ChevronDown } from 'lucide-vue-next';
import { t } from '../i18n';

/** Repos to show, "owner/repo"; empty = all. */
const model = defineModel<string[]>({ required: true });
const props = defineProps<{ counts: Record<string, number> }>();

const open = ref(false);
const i = computed(() => t.value.inbox);
// A picked repo stays in the list after its last PR is gone, so it can be unpicked.
const names = computed(() => [...new Set([...Object.keys(props.counts), ...model.value])].sort());
const label = computed(() => {
  const n = model.value.length;
  return !n ? i.value.reposAll : n === 1 ? model.value[0] : i.value.reposPicked(n);
});
const toggle = (name: string) =>
  (model.value = model.value.includes(name) ? model.value.filter((x) => x !== name) : [...model.value, name]);
</script>

<template>
  <div class="repos" @keydown.esc="open = false">
    <button :aria-expanded="open" aria-haspopup="true" @click="open = !open">
      <BookMarked :size="15" class="muted" />
      <span class="label">{{ label }}</span>
      <ChevronDown :size="14" class="muted" />
    </button>
    <template v-if="open">
      <div class="backdrop" @click="open = false" />
      <div class="pop" role="group" :aria-label="i.repos">
        <label v-for="n in names" :key="n" class="opt">
          <input type="checkbox" :checked="model.includes(n)" @change="toggle(n)" />
          <span class="mono name">{{ n }}</span>
          <span class="muted">{{ counts[n] ?? 0 }}</span>
        </label>
        <div class="foot muted">
          <span>{{ model.length ? i.reposKept : i.reposNone }}</span>
          <button v-if="model.length" class="ghost reset" @click="model = []">{{ i.reset }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.repos {
  position: relative;
  min-width: 0;
}
.repos > button {
  max-width: 100%;
  padding: 7px 12px;
}
.label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}
.pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 21;
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: 60vh;
  overflow: auto;
  padding: 6px;
  box-sizing: border-box;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.opt {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
}
.opt:hover {
  background: var(--panel-2);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding: 8px 10px 4px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
}
.foot span {
  flex: 1;
}
.reset {
  padding: 2px 6px;
  font-weight: 600;
  color: var(--accent);
}
</style>
