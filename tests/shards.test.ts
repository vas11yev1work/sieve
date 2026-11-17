import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { groupFiles, importEdges, mergeReviews, shardCount, type FileStat } from '../cli/lib/shards.ts';
import { DEFAULT_SETTINGS } from '../cli/lib/settings.ts';

const stat = (path: string, additions = 10): FileStat => ({ path, additions, deletions: 0 });

describe('shardCount', () => {
  const s = DEFAULT_SETTINGS.sharding;

  test('a small change is reviewed whole', () => {
    expect(shardCount([stat('a.ts', 100)], s)).toBe(1);
  });

  test('enough parts for the file and line limits, capped', () => {
    expect(
      shardCount(
        Array.from({ length: 90 }, (_, i) => stat(`f${i}.ts`, 1)),
        s,
      ),
    ).toBe(3);
    expect(shardCount([stat('a.ts', 7000)], s)).toBe(3);
    expect(
      shardCount(
        Array.from({ length: 1000 }, (_, i) => stat(`f${i}.ts`)),
        s,
      ),
    ).toBe(4);
  });

  test('disabled', () => {
    expect(shardCount([stat('a.ts', 99999)], { ...s, enabled: false })).toBe(1);
  });
});

describe('importEdges', () => {
  const wt = mkdtempSync(join(tmpdir(), 'sieve-shards-'));
  afterAll(() => rmSync(wt, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'src/pages/product.vue': `<script setup lang="ts">\nimport { useCart } from "@/shared/cart";\nimport Card from './card.vue';\nimport { ref } from 'vue';\n</script>`,
    'src/pages/card.vue': `<template><div /></template>`,
    'src/shared/cart/index.ts': `export * from './useCart';`,
    'src/shared/cart/useCart.ts': `const t = await import('../../utils/time.js');`,
    'src/utils/time.ts': `export const now = 1;`,
    'src/a/index.ts': `import x from '#/b/util';`,
    'src/a/b/util.ts': ``,
    'src/c/b/util.ts': ``,
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), text);
  }

  test('relative, dynamic and alias imports; packages and ambiguous aliases are skipped', () => {
    const edges = importEdges(wt, [...Object.keys(files), 'src/deleted.ts']);
    expect(edges.sort()).toEqual(
      [
        ['src/pages/product.vue', 'src/shared/cart/index.ts'],
        ['src/pages/product.vue', 'src/pages/card.vue'],
        ['src/shared/cart/index.ts', 'src/shared/cart/useCart.ts'],
        ['src/shared/cart/useCart.ts', 'src/utils/time.ts'],
      ].sort() as [string, string][],
    );
  });
});

describe('groupFiles', () => {
  test('linked files stay together even when far apart in path order', () => {
    const stats = [stat('a/x.ts'), stat('b/y.ts'), stat('c/z.ts'), stat('d/w.ts')];
    const parts = groupFiles(stats, [['a/x.ts', 'd/w.ts']], 2);
    expect(parts).toHaveLength(2);
    expect(parts.find((p) => p.includes('a/x.ts'))).toContain('d/w.ts');
  });

  test('every file lands in exactly one part, parts are balanced by lines', () => {
    const stats = Array.from({ length: 20 }, (_, i) => stat(`dir${i % 4}/f${i}.ts`));
    const parts = groupFiles(stats, [], 4);
    expect(parts).toHaveLength(4);
    expect(parts.flat().sort()).toEqual(stats.map((s) => s.path).sort());
    for (const p of parts) expect(p.length).toBe(5);
    // path order: a folder is not split when it fits in a part
    for (const p of parts) expect(new Set(p.map((f) => f.split('/')[0])).size).toBe(1);
  });

  test('a hub imported by many files does not glue everything into one part', () => {
    const stats = [stat('types.ts'), ...Array.from({ length: 8 }, (_, i) => stat(`m${i}/a.ts`))];
    const edges = stats.slice(1).map((s) => [s.path, 'types.ts'] as [string, string]);
    expect(groupFiles(stats, edges, 3)).toHaveLength(3);
  });

  test('a component bigger than a part is cut', () => {
    const stats = Array.from({ length: 6 }, (_, i) => stat(`f${i}.ts`));
    const edges = stats.slice(1).map((s, i) => [stats[i]!.path, s.path] as [string, string]);
    const parts = groupFiles(stats, edges, 3);
    expect(parts).toHaveLength(3);
    expect(parts.flat()).toHaveLength(6);
  });
});

describe('mergeReviews', () => {
  const plan = [
    { name: 'logic', shard: { index: 1, count: 2 } },
    { name: 'logic', shard: { index: 2, count: 2 } },
    { name: 'jira' },
  ];
  const shards = [
    ['a.ts', 'b.ts'],
    ['c.ts', 'd.ts'],
  ];
  const scope = (s: number | undefined) => (s ? shards[s - 1]! : shards.flat());
  const norm = (f: string) => f.replace(/^\.\//, '');

  test('a clean part that skipped files becomes incomplete and lists them', () => {
    const out = mergeReviews(
      [
        { name: 'logic', shard: 1, verdict: 'clean', summary: 'ok', checkedFiles: ['a.ts', './b.ts'] },
        { name: 'logic', shard: 2, verdict: 'clean', summary: 'ok too', checkedFiles: ['c.ts'] },
        { name: 'jira', verdict: 'clean', checkedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] },
      ],
      plan,
      scope,
      norm,
    );
    expect(out).toEqual([
      { name: 'logic', verdict: 'incomplete', summary: '[1/2] ok [2/2] ok too', unchecked: ['d.ts'] },
      { name: 'jira', verdict: 'clean' },
    ]);
  });

  test('worst part wins; a missing part is failed; no checkedFiles = coverage unknown', () => {
    const out = mergeReviews(
      [
        { name: 'logic', shard: 1, verdict: 'issues', summary: 'found' },
        { name: 'jira', verdict: 'clean' },
      ],
      plan,
      scope,
      norm,
    );
    expect(out[0]).toMatchObject({ name: 'logic', verdict: 'failed' });
    expect(out[1]).toEqual({ name: 'jira', verdict: 'clean' });
  });

  test('issues stay issues even with unchecked files, and the files are listed', () => {
    const out = mergeReviews(
      [{ name: 'jira', verdict: 'issues', checkedFiles: ['a.ts'] }],
      [{ name: 'jira' }],
      scope,
      norm,
    );
    expect(out).toEqual([{ name: 'jira', verdict: 'issues', unchecked: ['b.ts', 'c.ts', 'd.ts'] }]);
  });

  test('no reviews recorded → nothing to show', () => {
    expect(mergeReviews([], plan, scope, norm)).toEqual([]);
  });
});
