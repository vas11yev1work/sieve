<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { LoaderCircle, Play, X } from 'lucide-vue-next';
import type { InboxPr } from '../../../shared/types';
import { inboxApi } from '../api';
import { t } from '../i18n';

const props = defineProps<{ pr: InboxPr }>();
const emit = defineEmits<{ start: [only: string[]]; close: [] }>();

const list = ref<{ name: string; description: string; enabled: boolean }[] | null>(null);
const picked = ref<string[]>([]);
const error = ref('');
const i = computed(() => t.value.inbox);

onMounted(async () => {
  try {
    list.value = await inboxApi.reviewers(props.pr.url);
    picked.value = list.value.filter((r) => r.enabled).map((r) => r.name);
  } catch (e) {
    error.value = (e as Error).message;
  }
});
</script>

<template>
  <div class="backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true">
      <header>
        <h3>{{ i.pickTitle }} · #{{ pr.number }}</h3>
        <button class="ghost icon" :aria-label="t.cancel" @click="emit('close')"><X :size="18" /></button>
      </header>

      <div class="body">
        <LoaderCircle v-if="!list && !error" :size="20" class="spin muted" />
        <template v-if="list">
          <div class="bulk">
            <button class="link" @click="picked = list.map((r) => r.name)">{{ i.pickAll }}</button>
            <button class="link" @click="picked = []">{{ i.pickNone }}</button>
          </div>
          <label v-for="r in list" :key="r.name" class="item">
            <input v-model="picked" type="checkbox" :value="r.name" />
            <span>
              <span class="name mono">{{ r.name }}</span>
              <span v-if="!r.enabled" class="muted off">{{ i.pickOff }}</span>
              <span v-if="r.description" class="muted desc">{{ r.description }}</span>
            </span>
          </label>
        </template>
        <div v-if="error" class="error">{{ error }}</div>
      </div>

      <footer>
        <span class="grow" />
        <button class="ghost" @click="emit('close')">{{ t.cancel }}</button>
        <button class="primary" :disabled="!picked.length" @click="emit('start', picked)">
          <Play :size="14" /> {{ i.start }}
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
  width: min(520px, 100%);
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
  margin: 0;
  font-size: 16px;
}
.body {
  padding: 12px 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow: auto;
}
.bulk {
  display: flex;
  gap: 12px;
  margin-bottom: 4px;
}
button.link {
  border: none;
  background: none;
  padding: 2px 0;
  color: var(--muted);
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 3px;
}
button.link:hover {
  background: none;
  color: var(--text);
}
.item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 4px;
  border-radius: 8px;
  cursor: pointer;
}
.item:hover {
  background: var(--panel-2);
}
.item input {
  margin-top: 3px;
}
.name {
  font-weight: 600;
  font-size: 13px;
}
.off {
  font-size: 12px;
  margin-left: 8px;
}
.desc {
  display: block;
  font-size: 12.5px;
  margin-top: 2px;
}
.error {
  color: var(--danger);
  background: var(--danger-weak);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12.5px;
}
.grow {
  flex: 1;
}
.icon {
  padding: 4px;
}
</style>
