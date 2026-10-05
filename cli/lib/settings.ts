import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../../shared/types.ts';

export const SIEVE_HOME = process.env.SIEVE_HOME || join(homedir(), '.sieve');

export const DEFAULT_SETTINGS: Settings = {
  reportLanguage: 'en',
  commentLanguage: 'en',
  commentStyle: 'Short and friendly, 1-3 sentences. State the problem and the fix. No greetings, no filler, no praise.',
  rules: [
    'CLAUDE.md',
    '**/CLAUDE.md',
    'AGENTS.md',
    '**/AGENTS.md',
    '.claude/rules/**/*.md',
    '.sieve/rules/**/*.md',
    '.cursor/rules/**/*.mdc',
    '.cursorrules',
    '.github/copilot-instructions.md',
    '.github/instructions/**/*.md',
    'CONTRIBUTING.md',
  ],
  reviewers: {},
  validation: { enabled: true, model: 'auto', minConfidence: 0.6 },
  minSeverity: 'minor',
  chat: { model: 'sonnet', tools: ['Read', 'Grep', 'Glob'] },
  server: { port: 0, open: true },
  map: { mode: 'on-demand', model: 'sonnet' },
  ignore: [
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/bun.lock',
    '**/bun.lockb',
    '**/*.min.js',
    '**/*.map',
    '**/*.snap',
    '**/dist/**',
  ],
  inbox: {
    enabled: false,
    port: 7438,
    requested: 'me-or-team',
    repos: [],
    owners: [],
    excludeRepos: [],
    includeDrafts: false,
    showReviewed: true,
    checkouts: {},
  },
};

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`, { cause: e });
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge, arrays and scalars replace. `rulesExtra`/`ignoreExtra` append. */
function merge<T>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (k === '$schema') continue;
    if (k === 'rulesExtra' && Array.isArray(v)) {
      out.rules = [...((out.rules as string[]) || []), ...v];
    } else if (k === 'ignoreExtra' && Array.isArray(v)) {
      out.ignore = [...((out.ignore as string[]) || []), ...v];
    } else if (isObj(v) && isObj(out[k])) {
      out[k] = merge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function settingsFiles(repoRoot?: string): string[] {
  const files = [join(SIEVE_HOME, 'settings.json')];
  if (repoRoot) {
    files.push(join(repoRoot, '.sieve', 'settings.json'));
    files.push(join(repoRoot, '.sieve', 'settings.local.json'));
  }
  return files;
}

/**
 * Settings precedence (later wins):
 *   defaults < ~/.sieve/settings.json < <repo>/.sieve/settings.json < <repo>/.sieve/settings.local.json < CLI flags
 */
export function loadSettings(repoRoot?: string, overrides: Partial<Settings> = {}): Settings {
  let s: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const f of settingsFiles(repoRoot)) {
    const j = readJson(f);
    if (j) s = merge(s, j);
  }
  return merge(s, overrides as Record<string, unknown>);
}

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  uk: 'Ukrainian',
  sr: 'Serbian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  pl: 'Polish',
  nl: 'Dutch',
  tr: 'Turkish',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
};

/** "ru" -> "Russian"; anything else is passed through ("Brazilian Portuguese"). */
export function languageName(lang: string): string {
  return LANG_NAMES[lang.toLowerCase()] || lang;
}
