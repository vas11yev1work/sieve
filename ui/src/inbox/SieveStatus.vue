<script setup lang="ts">
/**
 * Sieve's part of a row: a running review shows a ring of its overall progress and what it is
 * doing right now; otherwise one dot per run and what waits on the current commit.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { CircleX, Network } from 'lucide-vue-next';
import type { InboxPr } from '../../../shared/types';
import { SEVERITIES } from '../../../shared/types';
import { t } from '../i18n';
import { progress, runColor, stageCount } from './track';

const props = defineProps<{ pr: InboxPr; ahead: number }>();
const emit = defineEmits<{ dismiss: [] }>();

const i = computed(() => t.value.inbox);
const job = computed(() => props.pr.job);
const running = computed(() => job.value?.state === 'running');
const queued = computed(() => job.value?.state === 'queued');
const failed = computed(() => job.value?.state === 'error');
const cur = computed(() => props.pr.runs.find((r) => r.onHead));
const total = computed(() => (cur.value ? SEVERITIES.reduce((n, s) => n + cur.value!.findings[s], 0) : 0));
const published = computed(() => cur.value?.reviews.reduce((n, r) => n + r.count, 0) || 0);

// Ring: r = 7 on a 18×18 box.
const C = 2 * Math.PI * 7;
const dash = computed(() => (job.value ? C * (1 - progress(job.value)) : C));

const doing = computed(() => {
  const j = job.value!;
  if (j.phase === 'review') {
    const s = stageCount(j, 'review');
    return s.total ? i.value.reviewers(s.done, s.total) : i.value.prepare;
  }
  if (j.phase === 'validate') {
    const s = stageCount(j, 'validate');
    return i.value.validators(s.done, s.total);
  }
  if (j.phase === 'finalize') return i.value.finalize;
  return i.value.prepare;
});

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  running,
  (on) => {
    clearInterval(timer);
    if (on) timer = setInterval(() => (now.value = Date.now()), 1000);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(timer));
const elapsed = computed(() => {
  if (!job.value?.startedAt) return '';
  const s = Math.max(0, Math.floor((now.value - Date.parse(job.value.startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});
</script>

<template>
  <div class="status">
    <!-- Running / queued: progress ring -->
    <template v-if="running || queued">
      <div class="line" role="status">
        <svg class="ring" :class="{ queued }" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <circle class="track" cx="9" cy="9" r="7" />
          <circle v-if="running" class="arc" cx="9" cy="9" r="7" :stroke-dasharray="C" :stroke-dashoffset="dash" />
        </svg>
        <span class="main" :class="{ muted: queued }">{{ running ? doing : i.queued(ahead) }}</span>
        <span v-if="running" class="time">{{ elapsed }}</span>
      </div>
    </template>

    <template v-else-if="failed">
      <div class="line bad">
        <CircleX :size="16" /><span class="main">{{ i.failed }}</span>
      </div>
      <p class="sub err" :title="job!.error">{{ job!.error }}</p>
      <p class="sub">
        <button class="link" @click="emit('dismiss')">{{ i.dismiss }}</button>
        <span v-if="job!.log" class="muted clip" :title="job!.log">{{ i.log }}: {{ job!.log }}</span>
      </p>
    </template>

    <!-- One dot per run, oldest first: filled = on the current commit, ring = older -->
    <div v-else class="line wrap">
      <span v-if="pr.runs.length" class="dots" aria-hidden="true">
        <i
          v-for="r in [...pr.runs].reverse()"
          :key="r.runDir"
          :class="{ ring: !r.onHead }"
          :style="{ '--c': runColor(r) }"
        />
      </span>
      <span class="main" :class="{ muted: !pr.runs.length }">
        {{ pr.runs.length ? i.runs(pr.runs.length) : i.notReviewed }}
      </span>
      <template v-if="cur">
        <a v-if="cur.reviews.length" :href="cur.reviews.at(-1)!.url" target="_blank" rel="noopener">
          {{ i.published(published) }}
        </a>
        <span v-else-if="cur.unpublished" class="accent">{{ i.toPublish(cur.unpublished) }}</span>
        <span v-else-if="cur.status.open" class="accent">{{ i.toTriage(cur.status.open) }}</span>
        <span v-else-if="!total" class="muted">{{ i.noFindings }}</span>
        <span v-if="cur.map" class="muted map"><Network :size="12" /> {{ i.mapReady }}</span>
      </template>
      <span v-else-if="pr.runs.length" class="old">{{ i.olderRun }}</span>
    </div>
  </div>
</template>

<style scoped>
.status {
  min-width: 0;
  font-size: 12.5px;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}
.main {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.muted .main,
.main.muted {
  font-weight: 400;
}
.wrap {
  flex-wrap: wrap;
  column-gap: 10px;
  row-gap: 2px;
}
.dots {
  display: inline-flex;
  gap: 4px;
}
.dots i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-sizing: border-box;
  background: var(--c);
}
.dots i.ring {
  background: none;
  border: 2px solid var(--c);
}
.old {
  color: var(--sev-major);
}
.time {
  margin-left: auto;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.sub {
  margin: 2px 0 0 24px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 12px;
  color: var(--text);
  min-width: 0;
}
.ring {
  flex: none;
  transform: rotate(-90deg);
}
.ring circle {
  fill: none;
  stroke-width: 2.5;
}
.ring .track {
  stroke: var(--border);
}
/* Queued: an empty ring, 0% — unlike the dashed "not reviewed" icon. */
.ring.queued .track {
  stroke: color-mix(in srgb, var(--muted) 45%, var(--border));
}
.ring .arc {
  stroke: var(--accent);
  stroke-linecap: round;
  transition: stroke-dashoffset 0.6s ease-out;
}
.bad {
  color: var(--danger);
}
.accent {
  color: var(--accent);
}
.map {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.err {
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.clip {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
button.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--muted);
  font-size: 12px;
  text-decoration: underline;
  text-decoration-color: var(--border);
  text-underline-offset: 3px;
}
button.link:hover:not(:disabled) {
  background: none;
  color: var(--text);
}
@media (prefers-reduced-motion: reduce) {
  .ring .arc {
    transition: none;
  }
}
</style>
