import type { InboxJob } from '../../../shared/types';

const share = (job: InboxJob, phase: string) => {
  const list = job.agents.filter((a) => a.phase === phase);
  return { done: list.filter((a) => a.done).length, total: list.length };
};

/** Agents of the current agent stage: "2 of 4 reviewers". */
export const stageCount = share;

/**
 * Overall progress of a review, 0..1, for the ring. Stages get fixed slices of the circle
 * (reviewers the biggest: they take most of the time); agent stages fill their slice as agents finish.
 */
export function progress(job: InboxJob): number {
  const part = (phase: string) => {
    const s = share(job, phase);
    return s.total ? s.done / s.total : 0;
  };
  switch (job.phase) {
    case 'prepare':
      return 0.05;
    case 'review':
      return 0.1 + 0.55 * part('review');
    case 'validate':
      return 0.65 + 0.3 * part('validate');
    case 'finalize':
      return 0.97;
    case 'done':
      return 1;
    default:
      return 0;
  }
}
