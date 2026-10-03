<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { ChatMessage } from '../../../shared/types';
import { store, stopStream } from '../store';
import { t } from '../i18n';
import Markdown from './Markdown.vue';
import { Bot, LoaderCircle, ArrowUp, Square, PenLine, CircleAlert } from 'lucide-vue-next';

/** Message log + composer of one chat thread (a finding or a map step). Reset lives in the parent's tab bar. */
const props = defineProps<{ threadKey: string; messages: ChatMessage[]; placeholder: string; empty: string }>();
const emit = defineEmits<{ send: [message: string] }>();

const pending = computed(() => store.pending[props.threadKey]);
const canChat = computed(() => store.run?.capabilities.chat);

const input = ref('');
const log = ref<HTMLElement | null>(null);
const drafts = new Map<string, string>();

watch(
  () => props.threadKey,
  (n, o) => {
    if (o) drafts.set(o, input.value);
    input.value = drafts.get(n) || '';
    scrollDown();
  },
  { immediate: true },
);

watch(
  () => [props.messages.length, pending.value?.text],
  () => scrollDown(),
);

function scrollDown() {
  nextTick(() => {
    if (log.value) log.value.scrollTop = log.value.scrollHeight;
  });
}

function send() {
  const m = input.value.trim();
  if (!m || pending.value) return;
  input.value = '';
  drafts.delete(props.threadKey);
  emit('send', m);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="thread">
    <div ref="log" class="log scroll">
      <div v-if="!canChat" class="hint danger-text"><CircleAlert :size="16" /> {{ t.chatUnavailable }}</div>
      <div v-else-if="!messages.length && !pending" class="hint muted empty">
        <Bot :size="26" :stroke-width="1.5" /> {{ empty }}
      </div>

      <div v-for="(m, i) in messages" :key="i" class="msg" :class="[m.role, m.kind]">
        <div v-if="m.kind === 'comment'" class="tag"><PenLine :size="11" /> {{ t.comment }}</div>
        <Markdown v-if="m.role === 'assistant'" :text="m.text" />
        <div v-else class="plain">{{ m.text }}</div>
      </div>

      <div v-if="pending" class="msg assistant" :class="pending.kind">
        <div v-if="pending.kind === 'comment'" class="tag"><PenLine :size="11" /> {{ t.comment }}</div>
        <Markdown v-if="pending.text" :text="pending.text" />
        <div class="status muted">
          <LoaderCircle :size="13" class="spin" />
          <span class="mono">{{ pending.tool || t.thinking }}</span>
        </div>
      </div>

      <div v-if="store.errors[threadKey]" class="error"><CircleAlert :size="14" /> {{ store.errors[threadKey] }}</div>
    </div>

    <div class="composer">
      <textarea v-model="input" rows="3" :placeholder="placeholder" :disabled="!canChat" @keydown="onKey" />
      <button v-if="pending" class="icon danger" :title="t.stop" :aria-label="t.stop" @click="stopStream(threadKey)">
        <Square :size="14" />
      </button>
      <button
        v-else
        class="icon primary"
        :title="t.send"
        :aria-label="t.send"
        :disabled="!input.trim() || !canChat"
        @click="send"
      >
        <ArrowUp :size="18" :stroke-width="2.25" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.log {
  flex: 1;
  min-height: 120px;
  padding: 14px 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint {
  font-size: 13px;
  padding: 8px 0;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.hint.empty {
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 24px 8px;
}
.danger-text {
  color: var(--danger);
}
.msg {
  max-width: 92%;
  padding: 9px 12px;
  border-radius: 12px;
  font-size: 13.5px;
  word-wrap: break-word;
}
.msg.user {
  align-self: flex-end;
  background: var(--accent);
  color: var(--accent-text);
  border-bottom-right-radius: 4px;
}
.msg.user .plain {
  white-space: pre-wrap;
}
.msg.assistant {
  align-self: flex-start;
  background: var(--panel-2);
  border-bottom-left-radius: 4px;
}
.msg.comment {
  border: 1px dashed color-mix(in srgb, var(--accent) 50%, transparent);
  background: var(--accent-weak);
}
.tag {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent);
  font-weight: 700;
  margin-bottom: 4px;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-top: 4px;
}
.error {
  display: flex;
  gap: 6px;
  color: var(--danger);
  background: var(--danger-weak);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12.5px;
  white-space: pre-wrap;
}
.composer {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--border);
}
.composer textarea {
  flex: 1;
  /* exactly three lines, never resized */
  height: calc(3 * 1.5em + 18px);
  resize: none;
  line-height: 1.5;
}
button.icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  justify-content: center;
  border-radius: 9px;
}
</style>
