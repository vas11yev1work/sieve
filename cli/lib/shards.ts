/**
 * Large PRs: one agent cannot read a 200-file diff, so it samples and still says "clean".
 * Here a big change is split into parts ("shards") of related files, each reviewed by its own agent,
 * and the parts' verdicts are merged back into one per reviewer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { ReviewerVerdict, Settings } from '../../shared/types.ts';

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
}

/** A reviewer's answer for one part, as the orchestrator records it. */
export interface RawReview extends ReviewerVerdict {
  /** 1-based part number; absent when the reviewer saw the whole change. */
  shard?: number;
  /** Changed files the reviewer read or ruled out of its focus. */
  checkedFiles?: string[];
}

/** How many parts the change needs: 1 = review it whole. */
export function shardCount(stats: FileStat[], s: Settings['sharding']): number {
  if (!s.enabled || !stats.length) return 1;
  const lines = stats.reduce((n, f) => n + f.additions + f.deletions, 0);
  const need = Math.max(Math.ceil(stats.length / s.maxFiles), Math.ceil(lines / s.maxLines));
  return Math.min(Math.max(need, 1), s.maxShards);
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const IMPORT_RE =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const stem = (p: string) => p.replace(CODE_EXT, '');

/**
 * Import links between the changed files: relative imports, and alias imports (`@/x`, `~/x`, `#x`)
 * matched by path suffix. Bare package imports are ignored.
 */
export function importEdges(worktree: string, files: string[]): [string, string][] {
  const byStem = new Map<string, string[]>();
  for (const f of files) {
    if (!CODE_EXT.test(f)) continue;
    for (const k of new Set([stem(f), stem(f).replace(/\/index$/, '')])) byStem.set(k, [...(byStem.get(k) || []), f]);
  }
  const resolve = (spec: string): string | undefined => {
    const target = stem(spec);
    if (byStem.get(target)?.length === 1) return byStem.get(target)![0];
    // Alias: the import path is a suffix of the file path. Ambiguous matches are dropped.
    const hits = [...new Set([...byStem].filter(([k]) => k.endsWith('/' + target)).flatMap(([, v]) => v))];
    return hits.length === 1 ? hits[0] : undefined;
  };

  const edges: [string, string][] = [];
  for (const from of files) {
    const abs = join(worktree, from);
    if (!CODE_EXT.test(from) || !existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3] || m[4]!;
      let to: string | undefined;
      if (spec.startsWith('.')) to = resolve(posix.normalize(posix.join(dirname(from), spec)));
      else if (/^(?:@\/|~\/|#)/.test(spec)) to = resolve(spec.replace(/^(?:@\/|~\/|#\/?)/, ''));
      if (to && to !== from) edges.push([from, to]);
    }
  }
  return edges;
}

// ponytail: a file imported by this many changed files is shared by all of them (types, barrels);
// linking through it would glue the whole PR into one part. Every agent can still read it.
const HUB_IMPORTERS = 5;

/**
 * Split the changed files into `count` parts of roughly equal size (lines changed).
 * Files linked by imports stay together, and parts follow path order, so a folder lands in one part
 * unless it alone is bigger than a part.
 */
export function groupFiles(stats: FileStat[], edges: [string, string][], count: number): string[][] {
  if (count <= 1) return [stats.map((f) => f.path)];
  const weight = new Map(stats.map((f) => [f.path, Math.max(1, f.additions + f.deletions)]));

  const importers = new Map<string, number>();
  for (const [, to] of edges) importers.set(to, (importers.get(to) || 0) + 1);

  const parent = new Map(stats.map((f) => [f.path, f.path]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const [a, b] of edges)
    if (weight.has(a) && weight.has(b) && (importers.get(b) || 0) < HUB_IMPORTERS) parent.set(find(a), find(b));

  const components = new Map<string, string[]>();
  for (const f of stats) components.set(find(f.path), [...(components.get(find(f.path)) || []), f.path]);
  const sum = (paths: string[]) => paths.reduce((n, p) => n + weight.get(p)!, 0);
  const sorted = [...components.values()].map((c) => c.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));

  const target = Math.ceil(sum(stats.map((f) => f.path)) / count);
  // A component bigger than a part is cut in path order.
  const pieces = sorted.flatMap((c) => {
    if (sum(c) <= target) return [c];
    const out: string[][] = [[]];
    for (const p of c) {
      if (out.at(-1)!.length && sum(out.at(-1)!) + weight.get(p)! > target) out.push([]);
      out.at(-1)!.push(p);
    }
    return out;
  });

  const parts: string[][] = [[]];
  for (const piece of pieces) {
    const cur = parts.at(-1)!;
    if (cur.length && sum(cur) + sum(piece) > target && parts.length < count) parts.push([...piece]);
    else cur.push(...piece);
  }
  return parts;
}

const WORST: ReviewerVerdict['verdict'][] = ['failed', 'incomplete', 'issues', 'clean'];

/**
 * One verdict per reviewer from its parts' answers.
 * - A part that says `clean` but leaves files of its scope out of `checkedFiles` becomes `incomplete`;
 *   those files are listed in `unchecked`. Without `checkedFiles` coverage is unknown and left as is.
 * - A part with no answer counts as `failed` (when the orchestrator recorded no reviews at all, nothing is shown).
 * - The merged verdict is the worst part's: failed > incomplete > issues > clean.
 */
export function mergeReviews(
  raw: RawReview[],
  plan: { name: string; shard?: { index: number; count: number } }[],
  scopeOf: (shard: number | undefined) => string[],
  normalize: (file: string) => string | null,
): ReviewerVerdict[] {
  if (!raw.length) return [];
  const names = [...new Set([...plan.map((p) => p.name), ...raw.map((r) => r.name)])];
  return names.map((name) => {
    const expected = plan.filter((p) => p.name === name).map((p) => p.shard?.index);
    const parts = (expected.length ? expected : [undefined]).map((index) => {
      const r = raw.find((x) => x.name === name && (x.shard ?? undefined) === index) ??
        (expected.length === 1 ? raw.find((x) => x.name === name) : undefined) ?? {
          name,
          verdict: 'failed' as const,
          summary: 'No answer from this part.',
        };
      let verdict = WORST.includes(r.verdict) ? r.verdict : 'failed';
      let unchecked: string[] = [];
      if (Array.isArray(r.checkedFiles)) {
        const checked = new Set(r.checkedFiles.map((f) => normalize(f)).filter(Boolean));
        unchecked = scopeOf(index).filter((f) => !checked.has(f));
        if (verdict === 'clean' && unchecked.length) verdict = 'incomplete';
      }
      return { index, verdict, summary: r.summary, unchecked };
    });

    const verdict = WORST.find((v) => parts.some((p) => p.verdict === v))!;
    const summary =
      parts.length === 1
        ? parts[0]!.summary
        : parts
            .filter((p) => p.summary)
            .map((p) => `[${p.index}/${parts.length}] ${p.summary}`)
            .join(' ');
    const unchecked = [...new Set(parts.flatMap((p) => p.unchecked))].sort();
    return { name, verdict, ...(summary ? { summary } : {}), ...(unchecked.length ? { unchecked } : {}) };
  });
}
