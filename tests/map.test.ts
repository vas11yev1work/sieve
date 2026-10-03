import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from '../cli/lib/diff.ts';
import { DEFAULT_SETTINGS } from '../cli/lib/settings.ts';
import { linkFindings, normalizeMap, parseMapOutput } from '../cli/lib/map.ts';
import type { Finding, RunMeta } from '../shared/types.ts';

const PATCH = `diff --git a/src/store.ts b/src/store.ts
--- a/src/store.ts
+++ b/src/store.ts
@@ -8,3 +8,4 @@
 a
-b
+c
+d
 e
`;

const wt = mkdtempSync(join(tmpdir(), 'sieve-map-'));
mkdirSync(join(wt, 'src'));
writeFileSync(join(wt, 'src/store.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
writeFileSync(join(wt, 'src/card.vue'), 'x\n'.repeat(10));

const files = parseDiff(PATCH);
const meta = { worktree: wt, changedFiles: ['src/store.ts'] } as RunMeta;
const norm = (raw: unknown) => normalizeMap(raw, meta, files, DEFAULT_SETTINGS);
const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'store',
  label: id,
  summary: 's',
  ...extra,
});

describe('normalizeMap', () => {
  test('paths, lines, kinds', () => {
    const m = norm({
      flows: [
        {
          id: 'f',
          title: 'F',
          nodes: [
            node('a', { file: './src/store.ts', line: 9, endLine: 500, change: 'modified' }),
            node('b', { file: join(wt, 'src/card.vue'), line: 0, kind: 'weird' }),
            node('c', { file: 'src/missing.ts', line: 3 }),
            node('d', { file: '../etc/passwd', line: 1 }),
          ],
        },
      ],
    });
    const [a, b, c, d] = m.flows[0]!.nodes;
    expect(a).toMatchObject({ file: 'src/store.ts', line: 9, endLine: 30, change: 'modified' });
    expect(b).toMatchObject({ file: 'src/card.vue', kind: 'other' });
    expect(b!.line).toBeUndefined();
    expect(c!.file).toBeUndefined();
    expect(c!.line).toBeUndefined();
    expect(d!.file).toBeUndefined();
  });

  test('change is checked against the diff', () => {
    const [n1, n2, n3] = norm({
      flows: [
        {
          nodes: [
            node('a', { file: 'src/store.ts', line: 10, change: 'unchanged' }), // line 10 was added
            node('b', { file: 'src/card.vue', line: 1, change: 'modified', changeSummary: 'x' }), // not in the diff
            node('c', { file: 'src/store.ts', line: 20, change: 'unchanged' }),
          ],
        },
      ],
    }).flows[0]!.nodes;
    expect(n1!.change).toBe('modified');
    expect(n2!.change).toBe('unchanged');
    expect(n2!.changeSummary).toBeUndefined();
    expect(n3!.change).toBe('unchanged');
  });

  test('duplicate ids, broken edges, self-loops', () => {
    const f = norm({
      flows: [
        {
          id: 'f',
          nodes: [node('a'), node('a'), node('b')],
          edges: [
            { from: 'a', to: 'b', kind: 'async', label: 'await' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'b' },
            { from: 'b', to: 'ghost' },
            { from: 'a', to: 'a-2', kind: 'nope' },
          ],
        },
      ],
    }).flows[0]!;
    expect(f.nodes.map((n) => n.id)).toEqual(['a', 'a-2', 'b']);
    expect(f.edges).toEqual([
      { from: 'a', to: 'b', kind: 'async', label: 'await' },
      { from: 'a', to: 'a-2' },
    ]);
  });

  test('flows: empty dropped, unchanged last, limits', () => {
    const m = norm({
      overview: { summary: ' S ', areas: ['UI', 1], risks: ['1', '2', '3', '4', '5', '6'] },
      flows: [
        { id: 'quiet', nodes: [node('a')] },
        { id: 'empty', nodes: [] },
        { id: 'quiet', nodes: [node('a', { file: 'src/store.ts', line: 10 })] },
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `x${i}`,
          nodes: Array.from({ length: 25 }, (_, j) => node(`n${j}`)),
        })),
      ],
    });
    expect(m.overview).toEqual({ summary: 'S', areas: ['UI'], risks: ['1', '2', '3', '4', '5'] });
    expect(m.flows).toHaveLength(6);
    expect(m.flows[0]!.id).toBe('quiet-2');
    expect(m.flows.every((f) => f.nodes.length <= 20)).toBe(true);
    expect(m.flows.some((f) => f.id === 'empty')).toBe(false);
  });

  test('parseMapOutput', () => {
    expect(parseMapOutput('Here you go:\n```json\n{"flows":[]}\n```')).toEqual({ flows: [] });
    expect(parseMapOutput('prose {"overview":{"areas":["a"]},"flows":[]} tail')).toEqual({
      overview: { areas: ['a'] },
      flows: [],
    });
    expect(() => parseMapOutput('[1,2]')).toThrow();
  });
});

describe('linkFindings', () => {
  const f = (id: string, file: string, line: number, extra: Partial<Finding> = {}) =>
    ({ id, file, line, filtered: false, ...extra }) as Finding;
  const map = norm({
    flows: [
      {
        id: 'f',
        nodes: [
          node('a', { file: 'src/store.ts', line: 10, endLine: 12 }),
          node('b', { file: 'src/card.vue' }),
          node('c'),
        ],
      },
    ],
  });

  test('by file and line range with slack', () => {
    const linked = linkFindings(map, [
      f('f1', 'src/store.ts', 15), // 12 + 3
      f('f2', 'src/store.ts', 5, { endLine: 7 }), // 10 - 3
      f('f3', 'src/store.ts', 16),
      f('f4', 'src/store.ts', 11, { filtered: true }),
      f('f5', 'src/card.vue', 1), // node without lines: never linked
    ]);
    const [a, b, c] = linked.flows[0]!.nodes;
    expect(a!.findingIds).toEqual(['f1', 'f2']);
    expect(b!.findingIds).toBeUndefined();
    expect(c!.findingIds).toBeUndefined();
    // the stored map is not mutated
    expect(map.flows[0]!.nodes[0]!.findingIds).toBeUndefined();
  });
});
