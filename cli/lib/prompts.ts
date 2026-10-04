import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, ParsedFile, RuleFile, RunMeta, Settings } from '../../shared/types.ts';
import type { Reviewer } from './reviewers.ts';
import { languageName } from './settings.ts';
import { paths } from './run.ts';

export function render(tpl: string, vars: Record<string, string | number | undefined>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

function template(sieveRoot: string, name: string): string {
  return readFileSync(join(sieveRoot, 'skills', 'review', 'templates', name), 'utf8');
}

export function diffStats(files: ParsedFile[]) {
  let additions = 0;
  let deletions = 0;
  const per = files.map((f) => {
    let a = 0;
    let d = 0;
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.type === 'add') a++;
        else if (l.type === 'del') d++;
      }
    additions += a;
    deletions += d;
    return { path: f.path, status: f.status, additions: a, deletions: d, binary: f.binary };
  });
  return { additions, deletions, per };
}

function commonVars(meta: RunMeta, settings: Settings, files: ParsedFile[]) {
  const s = diffStats(files);
  const MAX = 200;
  const list = s.per
    .slice(0, MAX)
    .map((f) => `  - \`${f.path}\` (${f.status}${f.binary ? ', binary' : `, +${f.additions}/-${f.deletions}`})`)
    .join('\n');
  return {
    title: meta.title,
    author: meta.author || 'unknown',
    url: meta.url || '(local changes, no PR)',
    body: (meta.body || '(no description)').slice(0, 6000),
    baseRef: meta.baseRef,
    headRef: meta.headRef,
    baseShort: meta.baseSha.slice(0, 8),
    headShort: meta.headSha.slice(0, 8),
    worktree: meta.worktree,
    diffPath: paths(meta.runDir).patch,
    fileCount: files.length,
    additions: s.additions,
    deletions: s.deletions,
    fileList: list + (s.per.length > MAX ? `\n  - … and ${s.per.length - MAX} more (see the diff)` : ''),
    reportLanguage: languageName(settings.reportLanguage),
  };
}

export function reviewerPrompt(
  sieveRoot: string,
  meta: RunMeta,
  settings: Settings,
  files: ParsedFile[],
  rules: RuleFile[],
  reviewer: Reviewer,
): string {
  const rulesSection = rules.length
    ? '- Project rules that apply to this change (read the ones relevant to your focus):\n' +
      rules
        .map((r) => `  - \`${join(meta.repoRoot, r.path)}\`${r.scope ? ` — scope: \`${r.scope}/\`` : ' — whole repo'}`)
        .join('\n')
    : '- No project rule files were found.';

  const learned = join(meta.repoRoot, '.sieve', 'learned.md');
  const learnedSection = existsSync(learned)
    ? `- Team notes from previous reviews — findings the team rejected and why. Do not repeat these mistakes: \`${learned}\``
    : '';

  return render(template(sieveRoot, 'reviewer.md'), {
    ...commonVars(meta, settings, files),
    name: reviewer.name,
    focus: reviewer.body,
    defaultCategory: reviewer.category,
    rulesSection,
    learnedSection,
  });
}

export function validatorPrompt(
  sieveRoot: string,
  meta: RunMeta,
  settings: Settings,
  files: ParsedFile[],
  f: Finding,
): string {
  const { id, file, line, endLine, severity, category, rule, title, explanation, suggestion } = f;
  return render(template(sieveRoot, 'validator.md'), {
    ...commonVars(meta, settings, files),
    id,
    file,
    finding: JSON.stringify(
      { id, file, line, endLine, severity, category, rule, title, explanation, suggestion },
      null,
      2,
    ),
  });
}

/** Pick a model for validating a finding. "auto": opus for bugs/security, sonnet for the rest. */
export function validatorModel(settings: Settings, f: Finding): string {
  const m = settings.validation.model;
  if (m && m !== 'auto') return m;
  return ['bug', 'security'].includes(f.category) ? 'opus' : 'sonnet';
}

export function mapPrompt(sieveRoot: string, meta: RunMeta, settings: Settings, files: ParsedFile[]): string {
  return render(template(sieveRoot, 'cartographer.md'), commonVars(meta, settings, files));
}
