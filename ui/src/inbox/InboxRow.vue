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
  LoaderCircle,
  Info,
  ChevronDown,
  Clock,
} from 'lucide-vue-next';
import type { InboxPr, InboxRun } from '../../../shared/types';
import { SEVERITIES } from '../../../shared/types';
import { t } from '../i18n';
import Markdown from '../components/Markdown.vue';
import SieveStatus from './SieveStatus.vue';
import { ago, since, waitFrom, when } from './ago';
import { runColor } from './track';

const props = defineProps<{ pr: InboxPr; ahead: number; opening: boolean; expanded: boolean }>();
const emit = defineEmits<{
  review: [];
  cancel: [];
  dismiss: [];
  open: [runDir: string];
  toggle: [];
  snooze: [];
}>();

const i = computed(() => t.value.inbox);
const cur = computed(() => props.pr.runs.find((r) => r.onHead));
const job = computed(() => props.pr.job);
const active = computed(() => job.value?.state === 'queued' || job.value?.state === 'running');
const failed = computed(() => job.value?.state === 'error');
const teams = computed(() => props.pr.teams.join(', '));
const my = computed(() => (props.pr.myReview ? i.value.my[props.pr.myReview.state] : undefined));

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

/** One primary action per row; reviewing again and older runs live under "Details". */
const action = computed(() => {
  if (active.value) return { kind: 'cancel', label: t.value.cancel, cls: '' };
  if (failed.value) return { kind: 'review', label: i.value.retry, cls: 'primary' };
  if (props.pr.why === 'findings') return { kind: 'open', label: i.value.open, cls: 'primary' };
  if (cur.value) return { kind: 'open', label: i.value.open, cls: '' };
  return { kind: 'review', label: i.value.review, cls: 'go' };
});

const where = computed(() => (props.pr.checkout ? i.value.runsFrom(props.pr.checkout) : i.value.runsFromClone));

function act(kind: string) {
  if (kind === 'review') emit('review');
  else if (kind === 'cancel') emit('cancel');
  else if (kind === 'open' && cur.value) emit('open', cur.value.runDir);
}

const size = computed(() => {
  const n = props.pr.additions + props.pr.deletions;
  return n < 100 ? 'S' : n < 600 ? 'M' : n < 2000 ? 'L' : 'XL';
});

const why = computed(() => i.value.why[props.pr.why]?.(teams.value, !!props.pr.myReview?.onHead) ?? '');

/** "waits for you 2d": highlighted once your turn has lasted a day. */
const wait = computed(() => {
  const from = waitFrom(props.pr);
  if (!from) return null;
  const d = since(from);
  if (props.pr.turn === 'author') return { text: i.value.waitAuthor(d), late: false };
  return { text: i.value.waitYou(d), late: props.pr.turn === 'me' && Date.now() - Date.parse(from) >= 86_400_000 };
});

function summary(r: InboxRun) {
  const n = r.status.open + r.status.accepted + r.status.rejected;
  if (!n) return i.value.noFindings;
  const sent = r.reviews.reduce((k, x) => k + x.count, 0);
  return `${r.status.open ? i.value.triaged(n - r.status.open, n) : i.value.allTriaged}, ${i.value.inPr(sent)}`;
}
</script>

<template>
  <article class="row" :class="{ active, expanded }">
    <div class="pr">
      <div class="where">
        <span class="mono">{{ pr.owner }}/{{ pr.repo }} #{{ pr.number }}</span>
        <span v-if="pr.isDraft" class="chip">{{ t.draft }}</span>
        <span v-for="l in pr.labels" :key="l.name" class="label">
          <i :style="{ background: `#${l.color}` }" />{{ l.name }}
        </span>
      </div>
      <a class="title" :href="pr.url" target="_blank" rel="noopener"><Markdown inline :text="pr.title" /></a>
      <div class="meta">
        <span>@{{ pr.author }}</span>
        <span class="size" :title="`${pr.baseRef} ← ${pr.headRef}, ${i.files(pr.changedFiles)}`">
          <b :class="`s-${size}`">{{ size }}</b>
          <span class="add mono">+{{ pr.additions }}</span>
          <span class="del mono">−{{ pr.deletions }}</span>
        </span>
        <span :title="pr.updatedAt">{{ ago(pr.updatedAt) }}</span>
        <span v-if="wait" :class="{ late: wait.late }">{{ wait.text }}</span>
      </div>
      <p v-if="why" class="why"><Info :size="14" />{{ why }}</p>
    </div>

    <div class="stat">
      <ul class="badges">
        <li :class="decision.cls"><component :is="decision.icon" :size="14" />{{ decision.text }}</li>
        <li v-if="pr.myReview" :class="{ warn: !pr.myReview.onHead }" :title="my?.[pr.myReview.onHead ? 1 : 2]">
          <CircleDot :size="14" /><span class="clip">{{ my?.[0] ?? pr.myReview.state }}</span>
        </li>
        <li v-if="ci" :class="ci.cls" :title="ci.text"><component :is="ci.icon" :size="14" />CI</li>
        <li v-if="pr.threads.unresolved" class="warn" :title="i.threads(pr.threads.unresolved)">
          <MessagesSquare :size="14" />{{ pr.threads.unresolved }}
        </li>
        <li v-if="pr.mergeable === 'CONFLICTING'" class="bad"><GitMerge :size="14" />{{ i.conflicts }}</li>
        <li v-if="pr.requested === 'team'" :title="i.viaTeam(teams)">
          <Users :size="14" /><span class="clip">{{ teams }}</span>
        </li>
      </ul>
      <SieveStatus :pr="pr" :ahead="ahead" @dismiss="emit('dismiss')" />
    </div>

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
      <button class="ghost more-toggle" :aria-expanded="expanded" @click="emit('toggle')">
        {{ expanded ? i.collapse : i.details }}
        <ChevronDown :size="14" :class="{ flip: expanded }" />
      </button>
    </div>

    <div v-if="expanded" class="more">
      <div class="more-head">
        <h3>{{ i.history }}</h3>
        <button v-if="cur && !active" :title="where" @click="emit('review')">{{ i.reviewAgain }}</button>
        <button :title="i.snoozeHint" @click="emit('snooze')"><Clock :size="14" />{{ i.snooze }}</button>
      </div>
      <ol v-if="pr.runs.length" class="runs">
        <li v-for="r in pr.runs" :key="r.runDir">
          <span class="rail"><i :class="{ ring: !r.onHead }" :style="{ '--c': runColor(r) }" /></span>
          <div class="run">
            <div class="run-info">
              <div class="run-head">
                <strong>{{ when(r.createdAt) }}</strong>
                <span class="mono muted">{{ r.headSha.slice(0, 7) }}</span>
                <span class="pill" :class="{ cur: r.onHead }">{{ r.onHead ? i.currentCommit : i.olderCommit }}</span>
              </div>
              <div class="run-sub muted">
                <template v-for="s in SEVERITIES" :key="s">
                  <span v-if="r.findings[s]" class="sevn" :class="s" :title="s">{{ r.findings[s] }}</span>
                </template>
                <span>{{ summary(r) }}</span>
              </div>
            </div>
            <a v-if="r.url" :href="r.url" target="_blank" rel="noopener" class="btn">{{ i.open }}</a>
            <button v-else :disabled="opening" @click="emit('open', r.runDir)">{{ i.open }}</button>
          </div>
        </li>
      </ol>
      <p v-else class="muted none">{{ i.notReviewed }}</p>
    </div>
  </article>
</template>

<style scoped>
/* Breakpoints are on the page width (container "inbox"): wide >= 1024, medium 640-1023, narrow < 640. */
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px 136px;
  grid-template-areas: 'pr stat act';
  gap: 14px 28px;
  align-items: start;
  padding: 18px 22px 18px 19px;
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
  grid-area: pr;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.where {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 12.5px;
  color: var(--muted);
}
.label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
}
.label i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.title {
  color: var(--text);
  font-size: 15.5px;
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
  gap: 4px 14px;
  font-size: 13px;
  color: var(--muted);
}
.size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.size b {
  font-size: 11px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
}
.s-S {
  color: var(--ok);
}
.s-M {
  color: var(--accent);
}
.s-L {
  color: var(--sev-major);
}
.s-XL {
  color: var(--danger);
}
.add {
  color: var(--add-fg);
  font-size: 12.5px;
}
.del {
  color: var(--del-fg);
  font-size: 12.5px;
}
.late {
  color: var(--sev-major);
  font-weight: 600;
}
.why {
  align-self: flex-start;
  display: inline-flex;
  align-items: flex-start;
  gap: 7px;
  margin: 2px 0 0;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--panel-2);
  font-size: 13px;
  line-height: 1.4;
}
.why .lucide {
  flex: none;
  margin-top: 1px;
  color: var(--muted);
}
.stat {
  grid-area: stat;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.badges {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.badges li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 3px 9px 3px 7px;
  border-radius: 999px;
  background: var(--panel-2);
  font-size: 12.5px;
  font-weight: 550;
  white-space: nowrap;
}
.badges .lucide {
  flex: none;
  color: var(--muted);
}
.badges .ok .lucide {
  color: var(--ok);
}
.badges .bad .lucide {
  color: var(--danger);
}
.badges .warn .lucide {
  color: var(--sev-major);
}
.clip {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.act {
  grid-area: act;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.act > button:not(.more-toggle),
.act > .btn {
  justify-content: center;
  padding: 8px 14px;
  font-weight: 600;
  white-space: nowrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 12px;
  color: var(--text);
  background: var(--panel);
  white-space: nowrap;
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
}
button.go:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}
.more-toggle {
  justify-content: center;
  gap: 4px;
  padding: 6px 8px;
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
}
.flip {
  transform: rotate(180deg);
}
.more {
  grid-column: 1 / -1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px 4px;
  border-radius: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.more-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.more-head h3 {
  flex: 1 1 auto;
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--muted);
}
.more-head button {
  padding: 6px 11px;
  font-size: 13px;
}
.runs {
  margin: 0;
  padding: 0;
  list-style: none;
  max-width: 760px;
}
.runs li {
  display: flex;
  gap: 12px;
}
/* Timeline: a dot per run on a rail that runs down to the next one. */
.rail {
  flex: none;
  width: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 15px;
}
.rail i {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-sizing: border-box;
  background: var(--c);
}
.rail i.ring {
  background: var(--bg);
  border: 2px solid var(--c);
}
.runs li:not(:last-child) .rail::after {
  content: '';
  flex: 1;
  width: 2px;
  margin-top: 4px;
  background: var(--border);
}
/* Each run is a card, so its Open button sits inside the run it opens. */
.run {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  padding: 10px 12px 10px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.run > .btn,
.run > button {
  flex: none;
  font-size: 13px;
  font-weight: 600;
}
.run-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.run-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 13.5px;
}
.run-head strong {
  font-weight: 600;
}
.run-head .mono {
  font-size: 12px;
}
.pill {
  font-size: 12px;
  color: var(--muted);
}
.pill.cur {
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--ok);
  background: var(--ok-weak);
}
.run-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12.5px;
}
.none {
  margin: 0 0 12px;
  font-size: 13.5px;
}
@container inbox (width < 1024px) {
  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: 'pr act' 'stat stat';
    gap: 12px 20px;
  }
  .stat {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 18px;
  }
}
/* Narrow: no grid at all, the parts just stack. */
@container inbox (width < 640px) {
  .row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    padding: 14px 16px 14px 13px;
  }
  .act {
    flex-direction: row;
  }
  .act > :first-child {
    flex: 1;
  }
  .more {
    padding: 12px 12px 4px;
  }
}
</style>
