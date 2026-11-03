/**
 * Worktree cleanup. A PR run keeps a full checkout of the repo (`<runDir>/wt`); findings and state are a few KB.
 * Pruning removes only worktrees, so every run stays listed and can still be opened.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RunMeta } from '../../shared/types.ts';
import { paths, readJson } from './run.ts';
import { RUNS_HOME } from './settings.ts';
import { sh } from './sh.ts';

export type PruneReason = 'repo-gone' | 'pr-closed' | 'older-revision';

export interface PruneItem {
  runDir: string;
  worktree: string;
  repoRoot: string;
  reason: PruneReason;
  url?: string;
  title: string;
}

/** PR runs of every repo that still have a worktree on disk. */
export function prRunsWithWorktree(base = RUNS_HOME): RunMeta[] {
  if (!existsSync(base)) return [];
  const out: RunMeta[] = [];
  for (const group of readdirSync(base)) {
    const groupDir = join(base, group);
    for (const id of safeReaddir(groupDir)) {
      const meta = readJson<RunMeta | null>(paths(join(groupDir, id)).meta, null);
      if (meta?.mode === 'pr' && existsSync(meta.worktree)) out.push(meta);
    }
  }
  return out;
}

/**
 * Which worktrees can go. `prState` returns the PR state from GitHub (OPEN / MERGED / CLOSED) or undefined when
 * it can't be read; an unknown state never removes anything by itself.
 */
export function planPrune(
  runs: RunMeta[],
  prState: (owner: string, repo: string, n: number) => string | undefined,
  repoExists: (root: string) => boolean = existsSync,
): PruneItem[] {
  const newest = new Map<string, string>();
  for (const r of runs) {
    const k = prKey(r);
    if (!newest.has(k) || r.createdAt > newest.get(k)!) newest.set(k, r.createdAt);
  }
  const states = new Map<string, string | undefined>();
  const items: PruneItem[] = [];
  for (const r of runs) {
    const k = prKey(r);
    let reason: PruneReason | undefined;
    if (!repoExists(r.repoRoot)) reason = 'repo-gone';
    else {
      if (!states.has(k)) states.set(k, prState(r.owner!, r.repo!, r.number!));
      const state = states.get(k);
      if (state === 'MERGED' || state === 'CLOSED') reason = 'pr-closed';
      else if (r.createdAt < newest.get(k)!) reason = 'older-revision';
    }
    if (reason)
      items.push({ runDir: r.runDir, worktree: r.worktree, repoRoot: r.repoRoot, reason, url: r.url, title: r.title });
  }
  return items;
}

/** Remove one run's worktree and unregister it from git. */
export function removeWorktree(item: Pick<PruneItem, 'worktree' | 'repoRoot'>) {
  if (existsSync(item.repoRoot)) {
    sh(['git', 'worktree', 'remove', '--force', item.worktree], { cwd: item.repoRoot });
  }
  rmSync(item.worktree, { recursive: true, force: true });
  if (existsSync(item.repoRoot)) sh(['git', 'worktree', 'prune'], { cwd: item.repoRoot });
}

/** Worktrees of earlier revisions of the same PR: a new review makes them dead weight. */
export function olderRevisions(runDir: string, prNumber: number): string[] {
  const group = join(runDir, '..');
  const id = runDir.split('/').pop();
  return safeReaddir(group)
    .filter((d) => d !== id && d.startsWith(`pr${prNumber}-`))
    .map((d) => paths(join(group, d)).worktree)
    .filter((wt) => existsSync(wt));
}

export function ghPrState(owner: string, repo: string, n: number): string | undefined {
  const r = sh(['gh', 'pr', 'view', String(n), '-R', `${owner}/${repo}`, '--json', 'state', '-q', '.state']);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

/** Size of a directory in KB (`du -sk`), 0 when it can't be read. */
export function sizeKb(dir: string): number {
  const r = sh(['du', '-sk', dir]);
  return r.ok ? Number.parseInt(r.stdout, 10) || 0 : 0;
}

const prKey = (r: RunMeta) => `${r.owner}/${r.repo}#${r.number}`.toLowerCase();

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
