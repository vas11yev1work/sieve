<script setup lang="ts">
import { computed } from 'vue';
import {
  CircleCheck,
  CircleX,
  CircleDot,
  CircleDashed,
  ShieldCheck,
  ShieldX,
  ShieldEllipsis,
  GitMerge,
  MessagesSquare,
  Users,
  GitBranch,
  ArrowLeft,
  LoaderCircle,
} from 'lucide-vue-next';
import type { InboxPr } from '../../../shared/types';
import { t } from '../i18n';
import Markdown from '../components/Markdown.vue';
import SieveStatus from './SieveStatus.vue';
import { ago } from './ago';

const props = defineProps<{ pr: InboxPr; ahead: number; opening: boolean }>();
const emit = defineEmits<{ review: []; cancel: []; dismiss: []; open: [runDir: string] }>();

const i = computed(() => t.value.inbox);
const cur = computed(() => props.pr.runs.find((r) => r.onHead));
const last = computed(() => props.pr.runs[0]);
const job = computed(() => props.pr.job);
const active = computed(() => job.value?.state === 'queued' || job.value?.state === 'running');
const failed = computed(() => job.value?.state === 'error');

const decision = computed(() => {
  const p = props.pr;
  if (p.decision === 'APPROVED') return { cls: 'ok', icon: CircleCheck, text: i.value.approved(p.approvals) };
  if (p.decision === 'CHANGES_REQUESTED') return { cls: 'bad', icon: CircleX, text: i.value.changes };
  if (p.decision === 'REVIEW_REQUIRED') return { cls: '', icon: CircleDashed, text: i.value.required };
  return { cls: '', icon: CircleDashed, text: p.approvals ? i.value.approved(p.approvals) : i.value.noReviews };
});

const ci = computed(() => {
  const s = props.pr.ci;
  if (!s) return null;
  if (s === 'SUCCESS') return { cls: 'ok', icon: ShieldCheck, text: i.value.ci[s] };
  if (s === 'FAILURE' || s === 'ERROR') return { cls: 'bad', icon: ShieldX, text: i.value.ci[s] };
  return { cls: 'warn', icon: ShieldEllipsis, text: i.value.ci[s] };
});

/** Findings of the run on the current head still wait for you (to triage or to publish). */
const pending = computed(
  () => !!cur.value && !cur.value.reviews.length && (cur.value.status.open > 0 || cur.value.unpublished > 0),
);

/** One primary action per row; `secondary` opens an older run or re-runs a reviewed one. */
const action = computed(() => {
  if (active.value) return { kind: 'cancel', label: t.value.cancel, cls: '' };
  if (failed.value) return { kind: 'review', label: i.value.retry, cls: 'primary' };
  if (pending.value) return { kind: 'open', label: i.value.open, cls: 'primary' };
  if (cur.value) return { kind: 'open', label: i.value.open, cls: '' };
  return { kind: 'review', label: i.value.review, cls: 'go' };
});
const secondary = computed(() => {
  if (active.value || failed.value) return null;
  if (cur.value) return { kind: 'review', label: i.value.reviewAgain };
  if (last.value) return { kind: 'open-last', label: i.value.olderRun };
  return null;
});

const where = computed(() => (props.pr.checkout ? i.value.runsFrom(props.pr.checkout) : i.value.runsFromClone));

function act(kind: string) {
  if (kind === 'review') emit('review');
  else if (kind === 'cancel') emit('cancel');
  else if (kind === 'open' && cur.value) emit('open', cur.value.runDir);
  else if (kind === 'open-last' && last.value) emit('open', last.value.runDir);
}
</script>

<template>
  <article class="row" :class="[`b-${pr.bucket}`, { active }]">
    <div class="pr">
      <div class="where">
        <span class="repo">{{ pr.owner }}/{{ pr.repo }}</span>
        <span class="num">#{{ pr.number }}</span>
        <span v-if="pr.isDraft" class="chip">{{ t.draft }}</span>
        <span v-for="l in pr.labels" :key="l.name" class="label">
          <i :style="{ background: `#${l.color}` }" />{{ l.name }}
        </span>
      </div>
      <a class="title" :href="pr.url" target="_blank" rel="noopener"><Markdown inline :text="pr.title" /></a>
      <div class="meta">
        <span>@{{ pr.author }}</span>
        <span class="branch mono" :title="`${pr.headRef} → ${pr.baseRef}`">
          <GitBranch :size="12" />{{ pr.baseRef }} <ArrowLeft :size="11" /> {{ pr.headRef }}
        </span>
        <span class="size">
          <span class="add">+{{ pr.additions }}</span> <span class="del">−{{ pr.deletions }}</span>
          <span class="muted">{{ i.files(pr.changedFiles) }}</span>
        </span>
        <span class="muted" :title="pr.updatedAt">{{ ago(pr.updatedAt) }}</span>
      </div>
    </div>

    <ul class="gh">
      <li :class="decision.cls"><component :is="decision.icon" :size="14" />{{ decision.text }}</li>
      <li v-if="pr.myReview" :class="{ warn: !pr.myReview.onHead }">
        <CircleDot :size="14" />
        <span>{{ i.my[pr.myReview.state] || pr.myReview.state }} {{ pr.myReview.onHead ? '' : i.olderCommit }}</span>
      </li>
      <li v-if="ci" :class="ci.cls"><component :is="ci.icon" :size="14" />{{ ci.text }}</li>
      <li v-if="pr.mergeable === 'CONFLICTING'" class="bad"><GitMerge :size="14" />{{ i.conflicts }}</li>
      <li v-if="pr.threads.unresolved" class="warn">
        <MessagesSquare :size="14" />{{ i.threads(pr.threads.unresolved) }}
      </li>
      <li v-if="pr.requested === 'team'" class="quiet">
        <Users :size="14" /><span class="clip">{{ i.viaTeam(pr.teams.join(', ')) }}</span>
      </li>
    </ul>

    <SieveStatus :pr="pr" :ahead="ahead" @dismiss="emit('dismiss')" />

    <div class="act">
      <a
        v-if="action.kind === 'open' && cur?.url"
        :href="cur.url"
        target="_blank"
        rel="noopener"
        class="btn"
        :class="action.cls"
        >{{ action.label }}</a
      >
      <button v-else :class="action.cls" :disabled="opening" :title="where" @click="act(action.kind)">
        <LoaderCircle v-if="opening && action.kind === 'open'" :size="14" class="spin" />
        {{ action.label }}
      </button>
      <button
        v-if="secondary"
        class="link"
        :title="secondary.kind === 'review' ? where : ''"
        @click="act(secondary.kind)"
      >
        {{ secondary.label }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: var(--inbox-cols);
  gap: 20px;
  align-items: start;
  padding: 14px 20px 14px 17px;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
.row.active {
  border-left-color: var(--accent);
  background: color-mix(in srgb, var(--accent-weak) 35%, transparent);
}
.pr {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.where {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--muted);
}
.num {
  font-variant-numeric: tabular-nums;
}
.label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  padding: 0 7px 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
}
.label i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.title {
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.title:hover {
  color: var(--accent);
  text-decoration: none;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 14px;
  row-gap: 2px;
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 2px;
}
.branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.size {
  display: inline-flex;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.add {
  color: var(--add-fg);
}
.del {
  color: var(--del-fg);
}
.gh {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12.5px;
  min-width: 0;
}
.gh li {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  min-width: 0;
}
.gh li > .lucide {
  color: var(--muted);
}
.ok,
.gh li.ok > .lucide {
  color: var(--ok);
}
.bad,
.gh li.bad,
.gh li.bad > .lucide {
  color: var(--danger);
}
.gh li.warn > .lucide {
  color: var(--sev-major);
}
.gh li.quiet {
  color: var(--muted);
}
.clip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.act {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.act > button:not(.link),
.btn {
  justify-content: center;
}
.btn {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 12px;
  color: var(--text);
  background: var(--panel);
}
.btn:hover {
  text-decoration: none;
  background: var(--panel-2);
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.btn.primary:hover {
  filter: brightness(1.08);
}
/* Review: outlined until hovered, so a long queue of them stays calm. */
button.go {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  font-weight: 600;
}
button.go:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
button.link {
  border: none;
  background: none;
  padding: 2px 0;
  color: var(--muted);
  font-size: 12px;
  justify-content: center;
  text-decoration: underline;
  text-decoration-color: var(--border);
  text-underline-offset: 3px;
}
button.link:hover:not(:disabled) {
  background: none;
  color: var(--text);
}
@media (max-width: 960px) {
  .row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px 16px;
  }
  .pr {
    grid-column: 1 / -1;
  }
  .act {
    grid-column: 1 / -1;
    flex-direction: row;
    align-items: center;
  }
}
@media (max-width: 560px) {
  .row {
    grid-template-columns: minmax(0, 1fr);
    padding: 12px 16px 12px 13px;
  }
}
</style>
