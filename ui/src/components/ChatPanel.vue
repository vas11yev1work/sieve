<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { Finding } from '../../../shared/types';
import { store, findingState, sendChat, generateComment, resetChat, update, selectNextAfter } from '../store';
import Markdown from './Markdown.vue';
import { t } from '../i18n';
import ChatThread from './ChatThread.vue';
import PanelTabs from './PanelTabs.vue';
import { Sparkles, Check, X, RotateCcw, ExternalLink, Eraser, LoaderCircle } from 'lucide-vue-next';

const props = defineProps<{ finding: Finding }>();

const id = computed(() => props.finding.id);
const st = computed(() => findingState(id.value));
const pending = computed(() => store.pending[id.value]);
const canChat = computed(() => store.run?.capabilities.chat);

const draft = ref('');
const rejecting = ref(false);
const reason = ref('');
const learn = ref(true);
const tab = ref<'chat' | 'comment'>('chat');
const tabs = computed(() => [
  { id: 'chat' as const, label: t.value.chat, count: st.value.messages.length },
  { id: 'comment' as const, label: t.value.comment },
]);
const commentPending = computed(() => pending.value?.kind === 'comment');

function generate() {
  tab.value = 'comment';
  generateComment(id.value);
}

watch(
  id,
  () => {
    draft.value = st.value.comment || '';
    rejecting.value = false;
    reason.value = st.value.rejectReason || '';
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

defineExpose({ accept, startReject, generate });

const lastWasNoComment = computed(() => {
  const m = st.value.messages[st.value.messages.length - 1];
  return m?.kind === 'comment' && !st.value.comment;
});
</script>

<template>
  <div class="panel">
    <PanelTabs v-model="tab" :tabs="tabs">
      <button
        v-if="tab === 'chat' && st.messages.length && !pending"
        class="ghost reset"
        :title="t.resetChat"
        @click="resetChat(id)"
      >
        <Eraser :size="14" /> {{ t.resetChat }}
      </button>
      <span v-else-if="tab === 'comment'" class="muted lang">{{ store.run?.settings.commentLanguage }}</span>
    </PanelTabs>

    <ChatThread
      v-if="tab === 'chat'"
      :thread-key="id"
      :messages="st.messages"
      :placeholder="t.chatPlaceholder"
      :empty="t.chatEmpty"
      @send="(m) => sendChat(id, m)"
    />

    <div v-else class="comment scroll">
      <p class="muted intro">{{ t.commentIntro }}</p>
      <textarea v-if="commentPending" class="box" :value="pending!.text" readonly />
      <textarea
        v-else
        v-model="draft"
        class="box"
        :placeholder="t.commentPlaceholder"
        :disabled="!!st.published"
        @input="onDraftInput"
        @blur="saveComment"
      />
      <div v-if="lastWasNoComment" class="hint muted">{{ t.noCommentNeeded }}</div>
      <button class="gen" :disabled="!!pending || !canChat || !!st.published" @click="generate">
        <LoaderCircle v-if="commentPending" :size="14" class="spin" /><Sparkles v-else :size="14" />
        {{ draft ? t.regenerate : t.generate }}
      </button>
    </div>

    <footer class="actions">
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
          <span v-if="!draft.trim()" class="muted need">{{ t.needComment }}</span>
          <button class="ok" :disabled="!draft.trim()" @click="accept"><Check :size="14" /> {{ t.accept }}</button>
        </template>
        <template v-else>
          <span class="chip" :class="st.status === 'accepted' ? 'ok' : 'danger'">
            <Check v-if="st.status === 'accepted'" :size="12" /><X v-else :size="12" />
            {{ st.status === 'accepted' ? t.accepted : t.rejected }}
          </span>
          <span v-if="st.status === 'rejected' && st.rejectReason" class="muted small-text"
            ><Markdown inline :text="st.rejectReason"
          /></span>
          <span class="grow" />
          <button class="ghost" @click="reopen"><RotateCcw :size="13" /> {{ t.reopen }}</button>
        </template>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.reset {
  padding: 4px 8px;
  font-size: 12.5px;
}
.lang {
  font-family: var(--mono);
  font-size: 12px;
}
.comment {
  flex: 1;
  min-height: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.intro {
  margin: 0;
  font-size: 13px;
}
.box {
  /* fixed height: ten lines of the comment, scrolls inside */
  height: calc(10 * 1.55em + 18px);
  flex-shrink: 0;
  resize: none;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.55;
}
.gen {
  align-self: flex-start;
}
.hint {
  font-size: 13px;
}
.actions {
  flex-shrink: 0;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.reject .row {
  margin-top: 8px;
}
.grow {
  flex: 1;
}
.need {
  font-size: 12px;
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
