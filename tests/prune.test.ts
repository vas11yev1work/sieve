import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { olderRevisions, planPrune } from '../cli/lib/prune.ts';
import type { RunMeta } from '../shared/types.ts';

const run = (number: number, sha: string, createdAt: string, repoRoot = '/repo'): RunMeta =>
  ({
    mode: 'pr',
    owner: 'o',
    repo: 'r',
    number,
    repoRoot,
    createdAt,
    runDir: `/runs/o-r/pr${number}-${sha}`,
    worktree: `/runs/o-r/pr${number}-${sha}/wt`,
    title: `PR ${number}`,
  }) as RunMeta;

const reasons = (items: ReturnType<typeof planPrune>) => items.map((i) => `${i.runDir.split('/').pop()}:${i.reason}`);

describe('planPrune', () => {
  test('keeps the newest revision of an open PR, removes the older ones', () => {
    const runs = [run(1, 'aaa', '2026-01-01'), run(1, 'bbb', '2026-01-02'), run(1, 'ccc', '2026-01-03')];
    expect(
      reasons(
        planPrune(
          runs,
          () => 'OPEN',
          () => true,
        ),
      ),
    ).toEqual(['pr1-aaa:older-revision', 'pr1-bbb:older-revision']);
  });

  test('removes every revision of a merged or closed PR', () => {
    const runs = [run(1, 'aaa', '2026-01-01'), run(1, 'bbb', '2026-01-02'), run(2, 'ccc', '2026-01-01')];
    const state = (_o: string, _r: string, n: number) => (n === 1 ? 'MERGED' : 'CLOSED');
    expect(reasons(planPrune(runs, state, () => true))).toEqual([
      'pr1-aaa:pr-closed',
      'pr1-bbb:pr-closed',
      'pr2-ccc:pr-closed',
    ]);
  });

  test('an unknown PR state removes only older revisions', () => {
    const runs = [run(1, 'aaa', '2026-01-01'), run(1, 'bbb', '2026-01-02')];
    expect(
      reasons(
        planPrune(
          runs,
          () => undefined,
          () => true,
        ),
      ),
    ).toEqual(['pr1-aaa:older-revision']);
  });

  test('a run whose repo is gone goes without asking GitHub', () => {
    const asked: number[] = [];
    const state = (_o: string, _r: string, n: number) => {
      asked.push(n);
      return 'OPEN';
    };
    const items = planPrune([run(1, 'aaa', '2026-01-01', '/gone')], state, (root) => root !== '/gone');
    expect(reasons(items)).toEqual(['pr1-aaa:repo-gone']);
    expect(asked).toEqual([]);
  });

  test('asks GitHub once per PR', () => {
    let calls = 0;
    planPrune(
      [run(1, 'aaa', '2026-01-01'), run(1, 'bbb', '2026-01-02')],
      () => (calls++, 'OPEN'),
      () => true,
    );
    expect(calls).toBe(1);
  });
});

describe('olderRevisions', () => {
  test('lists worktrees of other revisions of the same PR only', () => {
    const group = mkdtempSync(join(tmpdir(), 'sieve-prune-'));
    for (const id of ['pr1-aaa', 'pr1-bbb', 'pr12-ccc', 'pr2-ddd'])
      mkdirSync(join(group, id, 'wt'), { recursive: true });
    mkdirSync(join(group, 'pr1-eee')); // no worktree left: nothing to remove
    expect(olderRevisions(join(group, 'pr1-bbb'), 1)).toEqual([join(group, 'pr1-aaa', 'wt')]);
  });
});
