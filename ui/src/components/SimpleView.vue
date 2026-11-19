<script setup lang="ts">
/** Your own change: the findings that passed validation, numbered, and one button to copy them all. */
import { computed, ref } from 'vue';
import { Copy, Check, Inbox } from 'lucide-vue-next';
import { store } from '../store';
import { t } from '../i18n';
import Markdown from './Markdown.vue';

const items = computed(() => (store.run?.findings || []).filter((f) => !f.filtered));
const filtered = computed(() => (store.run?.findings || []).length - items.value.length);
const copied = ref(false);

const loc = (f: { file: string; line: number; endLine?: number }) =>
  `${f.file}:${f.line}${f.endLine ? `-${f.endLine}` : ''}`;

function markdown() {
  const lines = [`# ${store.run!.meta.title}`, ''];
  for (const f of items.value)
    lines.push(
      `## ${f.id.toUpperCase()} · ${f.severity} — ${f.title}`,
      '',
      `\`${loc(f)}\``,
      '',
      f.explanation.trim(),
      '',
    );
  return lines.join('\n');
}

async function copy() {
  await navigator.clipboard.writeText(markdown());
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}
</script>

<template>
  <main class="simple">
    <div class="wrap">
      <div class="head">
        <h2>{{ t.simpleCount(items.length) }}</h2>
        <span v-if="filtered" class="muted">{{ t.simpleFiltered(filtered) }}</span>
        <span class="grow" />
        <button class="primary" :disabled="!items.length" @click="copy">
          <Check v-if="copied" :size="14" /><Copy v-else :size="14" /> {{ copied ? t.copied : t.copyAll }}
        </button>
      </div>

      <div v-if="!items.length" class="empty muted">
        <Inbox :size="28" :stroke-width="1.5" />
        <div>{{ t.nothingFound }}</div>
      </div>

      <article v-for="f in items" :key="f.id" class="item">
        <div class="top">
          <span class="num mono">{{ f.id.toUpperCase() }}</span>
          <span class="sev" :class="f.severity">{{ f.severity }}</span>
          <span class="chip">{{ f.category }}</span>
          <span class="mono muted loc">{{ loc(f) }}</span>
        </div>
        <h3><Markdown inline :text="f.title" /></h3>
        <Markdown class="text" :text="f.explanation" />
      </article>
    </div>
  </main>
</template>

<style scoped>
.simple {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px 64px;
}
.wrap {
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  position: sticky;
  top: -20px;
  z-index: 2;
  padding: 12px 0;
  background: var(--bg);
}
.head h2 {
  margin: 0;
  font-size: 17px;
}
.grow {
  flex: 1;
}
.empty {
  padding: 48px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.item {
  padding: 14px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.num {
  font-size: 12px;
  font-weight: 650;
  color: var(--muted);
}
.loc {
  font-size: 12px;
  min-width: 0;
  overflow-wrap: anywhere;
}
h3 {
  margin: 8px 0 6px;
  font-size: 15px;
  line-height: 1.35;
}
.text {
  font-size: 14px;
  line-height: 1.5;
}
@media (max-width: 560px) {
  .simple {
    padding: 12px 12px 48px;
  }
}
</style>
