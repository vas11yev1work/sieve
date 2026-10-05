<script setup lang="ts">
/** Header button + popover for the report / comment languages (review page and inbox). */
import { ref } from 'vue';
import { Languages } from 'lucide-vue-next';
import { t } from '../i18n';

const props = defineProps<{ report: string; comment: string; saveLabel: string }>();
const emit = defineEmits<{ apply: [{ reportLanguage: string; commentLanguage: string; persist: boolean }] }>();

const LANGS = ['en', 'ru', 'sr', 'uk', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'nl', 'tr', 'zh', 'ja'];

const open = ref(false);
const reportLang = ref('');
const commentLang = ref('');
const persist = ref(false);

function toggle() {
  reportLang.value = props.report;
  commentLang.value = props.comment;
  persist.value = false;
  open.value = !open.value;
}

function apply() {
  emit('apply', {
    reportLanguage: reportLang.value.trim(),
    commentLanguage: commentLang.value.trim(),
    persist: persist.value,
  });
  open.value = false;
}
</script>

<template>
  <div class="lang-wrap">
    <button class="ghost" :title="t.languageHint" :aria-expanded="open" @click="toggle">
      <Languages :size="15" /> <span class="mono">{{ report }}</span> / <span class="mono">{{ comment }}</span>
    </button>
    <div v-if="open" class="popover" @keydown.esc="open = false">
      <div class="muted hint">{{ t.languageHint }}</div>
      <label>
        <span>{{ t.report }}</span>
        <input v-model="reportLang" type="text" list="langs" />
      </label>
      <label>
        <span>{{ t.comments }}</span>
        <input v-model="commentLang" type="text" list="langs" />
      </label>
      <label class="check"><input v-model="persist" type="checkbox" /> {{ saveLabel }}</label>
      <div class="row">
        <button class="ghost" @click="open = false">{{ t.cancel }}</button>
        <button class="primary" @click="apply">OK</button>
      </div>
    </div>
    <datalist id="langs">
      <option v-for="l in LANGS" :key="l" :value="l" />
    </datalist>
  </div>
</template>

<style scoped>
.lang-wrap {
  position: relative;
}
.popover {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: 280px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 12px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.popover label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
.popover .check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.popover .hint {
  font-size: 12px;
}
.popover .row {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
</style>
