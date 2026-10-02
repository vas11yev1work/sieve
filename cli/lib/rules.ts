import { basename, dirname } from 'node:path';
import type { RuleFile } from '../../shared/types.ts';
import { listFiles } from './source.ts';

function matcher(patterns: string[]) {
  const globs = patterns.map((p) => new Bun.Glob(p));
  return (path: string) => globs.some((g) => g.match(path));
}

export function isIgnored(path: string, ignore: string[]): boolean {
  return matcher(ignore)(path);
}

/**
 * Find rule files in `dir` matching the configured globs and keep the ones that apply to the change.
 * CLAUDE.md / AGENTS.md are scoped to their folder; everything else applies repo-wide.
 */
export function discoverRules(dir: string, patterns: string[], changed: string[]): RuleFile[] {
  const isRule = matcher(patterns);
  const out: RuleFile[] = [];
  for (const path of listFiles(dir)) {
    if (path.startsWith('.sieve/runs/') || path.includes('node_modules/')) continue;
    if (!isRule(path)) continue;
    const name = basename(path);
    const scoped = name === 'CLAUDE.md' || name === 'AGENTS.md';
    const scope = scoped ? (dirname(path) === '.' ? '' : dirname(path)) : '';
    if (scope && !changed.some((f) => f.startsWith(scope + '/'))) continue;
    out.push({ path, scope });
  }
  return out.sort((a, b) => a.scope.length - b.scope.length || a.path.localeCompare(b.path));
}
