import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Settings } from '../../shared/types.ts';
import { SIEVE_HOME } from './settings.ts';

export interface Reviewer {
  name: string;
  description: string;
  model: string;
  category: string;
  enabled: boolean;
  /** "builtin" | "global" | "project" */
  source: string;
  file: string;
  body: string;
}

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) data[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: m[2]!.trim() };
}

function loadDir(dir: string, source: string): Reviewer[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => {
      const file = join(dir, f);
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      return {
        name: data.name || basename(f, '.md'),
        description: data.description || '',
        model: data.model || 'sonnet',
        category: data.category || 'bug',
        enabled: data.enabled !== 'false',
        source,
        file,
        body,
      };
    });
}

/**
 * Reviewers come from three places; a later one with the same name replaces an earlier one:
 *   <sieve>/skills/review/reviewers  <  ~/.sieve/reviewers  <  <repo>/.sieve/reviewers
 * Then `settings.reviewers[name]` can disable a reviewer or change its model.
 * `only` (from `--only`) runs exactly the named reviewers, including ones disabled in settings.
 * `skip` (from `--skip`) removes the named reviewers from whatever would run.
 */
export function loadReviewers(
  sieveRoot: string,
  repoRoot: string,
  settings: Settings,
  only?: string[],
  skip?: string[],
): Reviewer[] {
  const byName = new Map<string, Reviewer>();
  for (const r of [
    ...loadDir(join(sieveRoot, 'skills', 'review', 'reviewers'), 'builtin'),
    ...loadDir(join(SIEVE_HOME, 'reviewers'), 'global'),
    ...loadDir(join(repoRoot, '.sieve', 'reviewers'), 'project'),
  ]) {
    byName.set(r.name, r);
  }
  for (const [name, cfg] of Object.entries(settings.reviewers || {})) {
    const r = byName.get(name);
    if (!r) continue;
    if (cfg.enabled !== undefined) r.enabled = cfg.enabled;
    if (cfg.model) r.model = cfg.model;
  }
  const unknown = [...(only || []), ...(skip || [])].filter((n) => !byName.has(n));
  if (unknown.length)
    throw new Error(`Unknown reviewer(s): ${unknown.join(', ')}. Available: ${[...byName.keys()].join(', ')}`);
  const picked = only?.length ? only.map((n) => byName.get(n)!) : [...byName.values()].filter((r) => r.enabled);
  return picked.filter((r) => !skip?.includes(r.name));
}
