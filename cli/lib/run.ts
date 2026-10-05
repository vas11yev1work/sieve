import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Finding, ParsedFile, RawFinding, RuleFile, RunMeta, RunState } from '../../shared/types.ts';

export const paths = (runDir: string) => ({
  meta: join(runDir, 'meta.json'),
  patch: join(runDir, 'diff.patch'),
  diff: join(runDir, 'diff.json'),
  rules: join(runDir, 'rules.json'),
  reviewers: join(runDir, 'reviewers.json'),
  raw: join(runDir, 'raw'),
  candidates: join(runDir, 'candidates.json'),
  findings: join(runDir, 'findings.json'),
  state: join(runDir, 'state.json'),
  prompts: join(runDir, 'prompts'),
  map: join(runDir, 'map.json'),
  mapPrompt: join(runDir, 'prompts', 'map.md'),
  worktree: join(runDir, 'wt'),
  server: join(runDir, 'server.json'),
});

export function readJson<T>(path: string, fallback?: T): T {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing file: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Atomic write so the UI never reads a half-written file. */
export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * Parse agent output: plain JSON, or text with a JSON array/object inside
 * (agents sometimes wrap output in prose or code fences).
 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  if (!t) return [];
  try {
    return JSON.parse(t);
  } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]!);
    } catch {}
  }
  // Whichever bracket comes first wins: an array of objects, or an object with arrays inside.
  const spans = [
    [t.indexOf('['), t.lastIndexOf(']')],
    [t.indexOf('{'), t.lastIndexOf('}')],
  ]
    .filter(([a, b]) => a! !== -1 && b! > a!)
    .sort((x, y) => x[0]! - y[0]!);
  for (const [a, b] of spans) {
    try {
      return JSON.parse(t.slice(a, b! + 1));
    } catch {}
  }
  throw new Error('not valid JSON');
}

export function loadRun(runDir: string) {
  const p = paths(runDir);
  return {
    meta: readJson<RunMeta>(p.meta),
    files: readJson<ParsedFile[]>(p.diff),
    rules: readJson<RuleFile[]>(p.rules, []),
    findings: readJson<Finding[]>(p.findings, []),
    state: readJson<RunState>(p.state, { findings: {} }),
  };
}

export type { RawFinding };
