<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { Finding } from '../../../shared/types';
import {
  store,
  findingState,
  sendChat,
  generateComment,
  stopStream,
  resetChat,
  update,
  selectNextAfter,
} from '../store';
import { t } from '../i18n';
import Markdown from './Markdown.vue';
import {
  MessageSquare,
  Eraser,
  Bot,
  LoaderCircle,
  Send,
  Square,
  Sparkles,
  Check,
  X,
  RotateCcw,
  ExternalLink,
  PenLine,
  CircleAlert,
} from 'lucide-vue-next';

const props = defineProps<{ finding: Finding }>();

const id = computed(() => props.finding.id);
const st = computed(() => findingState(id.value));
const pending = computed(() => store.pending[id.value]);
const canChat = computed(() => store.run?.capabilities.chat);

const input = ref('');
const draft = ref('');
const rejecting = ref(false);
const reason = ref('');
const learn = ref(true);
const log = ref<HTMLElement | null>(null);
const commentBox = ref<HTMLTextAreaElement | null>(null);

const drafts = new Map<string, string>();

watch(
  id,
  (n, o) => {
    if (o) drafts.set(o, input.value);
    input.value = drafts.get(n) || '';
    draft.value = st.value.comment || '';
    rejecting.value = false;
    reason.value = st.value.rejectReason || '';
    scrollDown();
  },
  { immediate: true },
);

// Server-side comment changes (generation) flow into the editor.
watch(
  () => st.value.comment,
  (c) => {
    if (c !== undefined && c !== draft.value) draft.value = c;
  },
);

watch(
  () => [st.value.messages.length, pending.value?.text],
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
  drafts.delete(id.value);
  sendChat(id.value, m);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveComment() {
  clearTimeout(saveTimer);
  if ((st.value.comment || '') !== draft.value) update(id.value, { comment: draft.value });
}
function onDraftInput() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveComment, 600);
}

async function accept() {
  saveComment();
  const cur = id.value;
  await update(cur, { status: 'accepted', comment: draft.value });
  selectNextAfter(cur);
}

async function confirmReject() {
  const cur = id.value;
  await update(cur, { status: 'rejected', rejectReason: reason.value, learn: learn.value && !!reason.value.trim() });
  rejecting.value = false;
  selectNextAfter(cur);
}

async function reopen() {
  await update(id.value, { status: 'open' });
}

function startReject() {
  rejecting.value = true;
}

defineExpose({ accept, startReject, generate: () => generateComment(id.value), focusChat: () => {} });

const lastWasNoComment = computed(() => {
  const m = st.value.messages[st.value.messages.length - 1];
  return m?.kind === 'comment' && !st.value.comment;
});
</script>

<template>
  <div class="panel">
    <div class="head">
      <span class="label"><MessageSquare :size="12" /> {{ t.chat }}</span>
      <button v-if="st.messages.length && !pending" class="ghost small" @click="resetChat(id)">
        <Eraser :size="13" /> {{ t.resetChat }}
      </button>
    </div>

    <div ref="log" class="log scroll">
      <div v-if="!canChat" class="hint danger-text"><CircleAlert :size="16" /> {{ t.chatUnavailable }}</div>
      <div v-else-if="!st.messages.length && !pending" class="hint muted empty">
        <Bot :size="26" :stroke-width="1.5" /> {{ t.chatEmpty }}
      </div>

      <div v-for="(m, i) in st.messages" :key="i" class="msg" :class="[m.role, m.kind]">
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

      <div v-if="store.errors[id]" class="error"><CircleAlert :size="14" /> {{ store.errors[id] }}</div>
    </div>

    <div class="composer">
      <textarea v-model="input" rows="2" :placeholder="t.chatPlaceholder" :disabled="!canChat" @keydown="onKey" />
      <div class="row">
        <span class="grow" />
        <button v-if="pending" class="danger" @click="stopStream(id)"><Square :size="13" /> {{ t.stop }}</button>
        <button v-else class="primary" :disabled="!input.trim() || !canChat" @click="send">
          <Send :size="14" /> {{ t.send }}
        </button>
      </div>
    </div>

    <div class="comment">
      <div class="head">
        <span class="label"><PenLine :size="12" /> {{ t.comment }} · {{ store.run?.settings.commentLanguage }}</span>
        <button class="small" :disabled="!!pending || !canChat" @click="generateComment(id)">
          <Sparkles :size="13" /> {{ draft ? t.regenerate : t.generate }}
        </button>
      </div>
      <div v-if="lastWasNoComment" class="hint muted">{{ t.noCommentNeeded }}</div>
      <textarea
        ref="commentBox"
        v-model="draft"
        rows="5"
        :placeholder="t.commentPlaceholder"
        :disabled="!!st.published"
        @input="onDraftInput"
        @blur="saveComment"
      />

      <div v-if="st.published" class="row">
        <span class="chip ok"><Check :size="12" /> {{ t.published }}</span>
        <a v-if="st.published.url" class="link" :href="st.published.url" target="_blank" rel="noopener"
          >{{ t.openOnGithub }} <ExternalLink :size="12"
        /></a>
      </div>

      <div v-else-if="rejecting" class="reject">
        <input v-model="reason" type="text" :placeholder="t.rejectReason" @keydown.enter="confirmReject" />
        <label class="check"><input v-model="learn" type="checkbox" /> {{ t.rememberReject }}</label>
        <div class="row">
          <span class="grow" />
          <button class="ghost" @click="rejecting = false">{{ t.cancel }}</button>
          <button class="danger" @click="confirmReject"><X :size="14" /> {{ t.confirmReject }}</button>
        </div>
      </div>

      <div v-else class="row">
        <template v-if="st.status === 'open'">
          <button class="danger" @click="startReject"><X :size="14" /> {{ t.reject }}</button>
          <span class="grow" />
          <button class="ok" :disabled="!draft.trim()" @click="accept"><Check :size="14" /> {{ t.accept }}</button>
        </template>
        <template v-else>
          <span class="chip" :class="st.status === 'accepted' ? 'ok' : 'danger'">
            <Check v-if="st.status === 'accepted'" :size="12" /><X v-else :size="12" />
            {{ st.status === 'accepted' ? t.accepted : t.rejected }}
          </span>
          <span v-if="st.status === 'rejected' && st.rejectReason" class="muted small-text">{{ st.rejectReason }}</span>
          <span class="grow" />
          <button class="ghost" @click="reopen"><RotateCcw :size="13" /> {{ t.reopen }}</button>
        </template>
      </div>
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
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px 8px;
}
.comment .head {
  padding: 0 0 8px;
}
.label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
}
button.small {
  padding: 3px 10px;
  font-size: 12.5px;
}
.log {
  flex: 1;
  min-height: 120px;
  padding: 4px 16px 12px;
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
.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
  padding: 8px 16px 12px;
  border-bottom: 1px solid var(--border);
}
.composer textarea {
  min-height: 52px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.grow {
  flex: 1;
}
.comment {
  padding: 12px 16px 16px;
  background: var(--panel);
}
.comment textarea {
  font-family: var(--mono);
  font-size: 12.5px;
}
.reject input[type='text'] {
  margin-top: 8px;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 6px;
}
.small-text {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
