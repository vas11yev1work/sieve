#!/usr/bin/env bun
/**
 * Sieve CLI — the deterministic half of the review pipeline.
 * The Claude Code skill (skills/review/SKILL.md) orchestrates the agents and calls these commands.
 *
 *   sieve prepare [PR url | owner/repo#n | n] [--base <ref>] [--lang <l>] [--comment-lang <l>] [--only <a,b>] [--skip <a,b>] [--min-severity <s>] [--force]
 *   sieve candidates <runDir>    < merged reviewer findings (JSON array)
 *   sieve finalize <runDir>      < validator verdicts (JSON array, optional)
 *   sieve map <runDir>           < cartographer output (JSON object) → map.json
 *   sieve serve <runDir> [--port <n>] [--no-open] [--detach] [--idle-exit <min>]
 *   sieve runs                   list runs of the current repo
 *   sieve inbox [--json] [--no-open]   PRs waiting for your review (UI, or JSON with --json)
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { Finding, RawFinding, RunMeta, RunState, Settings, Severity } from '../shared/types.ts';
import { SEVERITIES } from '../shared/types.ts';
import { loadSettings, SIEVE_HOME } from './lib/settings.ts';
import { inboxSettings, rememberCheckout } from './lib/inbox.ts';
import {
  parseInput,
  repoRootOf,
  ensureRepo,
  currentRepoSlug,
  fetchPr,
  fetchPrRefs,
  prDiff,
  ensureWorktree,
  excludeRuns,
  defaultBase,
  localDiff,
  requireGh,
} from './lib/source.ts';
import { parseDiff, anchorFor } from './lib/diff.ts';
import { discoverRules, isIgnored } from './lib/rules.ts';
import { loadReviewers } from './lib/reviewers.ts';
import { reviewerPrompt, validatorPrompt, validatorModel, diffStats, mapPrompt } from './lib/prompts.ts';
import { normalizeMap, parseMapOutput } from './lib/map.ts';
import { paths, readJson, writeJson, loadRun, parseJsonLoose } from './lib/run.ts';

export const SIEVE_ROOT = resolve(dirname(import.meta.path), '..');

function out(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function die(msg: string): never {
  process.stderr.write(`sieve: ${msg}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return await new Response(Bun.stdin.stream()).text();
}

function splitPatch(patch: string): { path: string; text: string }[] {
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  return parts.map((text) => ({ text, path: parseDiff(text)[0]?.path || '' }));
}

/** Stop a UI server left over from a previous review of the same run dir. */
function stopServer(runDir: string) {
  const info = readJson<{ pid?: number }>(paths(runDir).server, {});
  if (info.pid && info.pid !== process.pid) {
    try {
      process.kill(info.pid);
    } catch {}
  }
  rmSync(paths(runDir).server, { force: true });
}

function slug(s: string) {
  return (
    s
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'x'
  );
}

// ───────────────────────────── prepare ─────────────────────────────

async function prepare(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      lang: { type: 'string' },
      'comment-lang': { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      'min-severity': { type: 'string' },
      force: { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
  });
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const input = parseInput(positionals.join(' '), values.base);

  const overrides: Partial<Settings> = {};
  if (values.lang) overrides.reportLanguage = values.lang;
  if (values['comment-lang']) overrides.commentLanguage = values['comment-lang'];
  const minSeverity = values['min-severity'];
  if (minSeverity) {
    if (!SEVERITIES.includes(minSeverity as Severity)) die(`--min-severity must be one of: ${SEVERITIES.join(', ')}`);
    overrides.minSeverity = minSeverity as Severity;
  }
  const only = values.only
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const skip = values.skip
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let meta: RunMeta;
  let patch: string;

  if (input.kind === 'pr') {
    requireGh();
    const slugRepo = input.owner && input.repo ? { owner: input.owner, repo: input.repo } : currentRepoSlug(cwd);
    const pr = fetchPr(slugRepo.owner, slugRepo.repo, input.number);
    const { root, remote, cloned } = ensureRepo(cwd, slugRepo.owner, slugRepo.repo);
    if (!cloned) rememberCheckout(slugRepo.owner, slugRepo.repo, root);
    const id = `pr${pr.number}-${pr.headRefOid.slice(0, 7)}`;
    const runDir = join(root, '.sieve', 'runs', `${slugRepo.owner}-${slugRepo.repo}`.toLowerCase(), id);

    if (existsSync(paths(runDir).findings) && !values.force) {
      const findings = readJson<Finding[]>(paths(runDir).findings);
      return out({
        existing: true,
        runDir,
        title: pr.title,
        url: pr.url,
        findings: findings.filter((f) => !f.filtered).length,
        hint: 'This revision was already reviewed. Run `serve` to open it, or `prepare --force` to review again.',
      });
    }

    stopServer(runDir);
    excludeRuns(root);
    fetchPrRefs(root, remote, pr);
    const wt = paths(runDir).worktree;
    ensureWorktree(root, wt, pr.headRefOid);
    patch = prDiff(slugRepo.owner, slugRepo.repo, pr.number, root, pr.baseRefOid, pr.headRefOid);

    meta = {
      id,
      mode: 'pr',
      createdAt: new Date().toISOString(),
      repoRoot: root,
      worktree: wt,
      runDir,
      title: pr.title,
      body: pr.body || '',
      author: pr.author?.login,
      url: pr.url,
      owner: slugRepo.owner,
      repo: slugRepo.repo,
      number: pr.number,
      state: pr.state,
      isDraft: pr.isDraft,
      baseRef: pr.baseRefName,
      headRef: pr.headRefName,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      changedFiles: [],
      overrides,
    };
  } else {
    const root = repoRootOf(cwd);
    if (!root) die('Not inside a git repository. Run from your project, or pass a PR URL.');
    const base = input.base || defaultBase(root);
    const d = localDiff(root, base);
    patch = d.patch;
    const id = `local-${slug(d.branch)}`;
    const runDir = join(root, '.sieve', 'runs', 'local', id);
    if (existsSync(runDir)) {
      stopServer(runDir);
      rmSync(runDir, { recursive: true, force: true });
    }
    excludeRuns(root);
    meta = {
      id,
      mode: 'local',
      createdAt: new Date().toISOString(),
      repoRoot: root,
      worktree: root,
      runDir,
      title: `Local changes on ${d.branch} vs ${base}`,
      body: '',
      baseRef: base,
      headRef: d.branch,
      baseSha: d.baseSha,
      headSha: d.headSha,
      changedFiles: [],
      overrides,
    };
  }

  const settings = loadSettings(meta.repoRoot, overrides);

  // Drop ignored files (lockfiles, generated code…) from what the agents see.
  const kept = splitPatch(patch).filter((p) => p.path && !isIgnored(p.path, settings.ignore));
  patch = kept.map((p) => p.text).join('');
  const files = parseDiff(patch);
  meta.changedFiles = files.map((f) => f.path);

  const p = paths(meta.runDir);
  mkdirSync(meta.runDir, { recursive: true });
  rmSync(p.prompts, { recursive: true, force: true });
  for (const f of [p.candidates, p.findings, p.state, p.map]) rmSync(f, { force: true });
  writeFileSync(p.patch, patch);
  writeJson(p.diff, files);
  writeJson(p.meta, meta);

  const rules = discoverRules(meta.repoRoot, settings.rules, meta.changedFiles);
  writeJson(p.rules, rules);

  const reviewers = loadReviewers(SIEVE_ROOT, meta.repoRoot, settings, only, skip);
  mkdirSync(p.prompts, { recursive: true });
  const plan = reviewers.map((r) => {
    const file = join(p.prompts, `review-${r.name}.md`);
    writeFileSync(file, reviewerPrompt(SIEVE_ROOT, meta, settings, files, rules, r));
    return {
      name: r.name,
      model: r.model,
      description: r.description,
      prompt: file,
      tools: r.tools,
      validate: r.validate,
    };
  });
  writeJson(p.reviewers, plan);

  let map: { model: string; prompt: string } | undefined;
  if (settings.map.mode === 'always') {
    writeFileSync(p.mapPrompt, mapPrompt(SIEVE_ROOT, meta, settings, files));
    map = { model: settings.map.model, prompt: p.mapPrompt };
  }

  const stats = diffStats(files);
  let stop: string | undefined;
  if (!files.length) stop = 'Nothing to review: the diff is empty (after ignore filters).';
  else if (meta.mode === 'pr' && meta.state && meta.state !== 'OPEN' && !values.force)
    stop = `PR is ${meta.state.toLowerCase()}. Use --force to review anyway.`;

  out({
    runDir: meta.runDir,
    mode: meta.mode,
    title: meta.title,
    url: meta.url,
    state: meta.state,
    isDraft: meta.isDraft,
    files: files.length,
    additions: stats.additions,
    deletions: stats.deletions,
    reportLanguage: settings.reportLanguage,
    commentLanguage: settings.commentLanguage,
    mapMode: settings.map.mode,
    rules: rules.map((r) => r.path),
    reviewers: plan,
    ...(map ? { map } : {}),
    ...(stop ? { stop } : {}),
  });
}

// ───────────────────────────── candidates ─────────────────────────────

function normalizePath(file: string, meta: RunMeta): string | null {
  let f = String(file || '')
    .trim()
    .replace(/^\.\//, '');
  if (isAbsolute(f)) f = relative(meta.worktree, f);
  if (meta.changedFiles.includes(f)) return f;
  const bySuffix = meta.changedFiles.filter((c) => c.endsWith('/' + f) || f.endsWith('/' + c));
  return bySuffix.length === 1 ? bySuffix[0]! : null;
}

function sevRank(s: Severity) {
  return SEVERITIES.indexOf(s);
}

async function candidates(argv: string[]) {
  const runDir = resolve(argv[0] || die('usage: sieve candidates <runDir> < findings.json'));
  const { meta, files } = loadRun(runDir);
  const settings = loadSettings(meta.repoRoot, meta.overrides);
  const raw = parseJsonLoose(await readStdin());
  const list: RawFinding[] = Array.isArray(raw) ? raw : ((raw as { findings?: RawFinding[] }).findings ?? []);

  const dropped: { title?: string; reason: string }[] = [];
  const seen = new Set<string>();
  const kept: Finding[] = [];
  const minRank = sevRank(settings.minSeverity);

  for (const r of list) {
    const file = normalizePath(r.file, meta);
    if (!file) {
      dropped.push({ title: r.title, reason: `file not in diff: ${r.file}` });
      continue;
    }
    if (!r.title || !r.explanation) {
      dropped.push({ title: r.title, reason: 'missing title/explanation' });
      continue;
    }
    const severity: Severity = SEVERITIES.includes(r.severity) ? r.severity : 'minor';
    if (sevRank(severity) > minRank) {
      dropped.push({ title: r.title, reason: `below minSeverity (${severity})` });
      continue;
    }
    const line = Math.max(1, Math.floor(Number(r.line) || 1));
    const endLine = r.endLine && Number(r.endLine) > line ? Math.floor(Number(r.endLine)) : undefined;
    const key = `${file}:${line}:${r.title.toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      ...r,
      id: '',
      file,
      line,
      endLine,
      severity,
      category: r.category || 'bug',
      reviewers: r.reviewers?.length ? r.reviewers : [],
      anchor: anchorFor(files, file, line, endLine),
      inDiff: false,
      validation: { verdict: 'skipped' },
      filtered: false,
    });
  }

  kept.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
  kept.forEach((f, i) => {
    f.id = `f${i + 1}`;
    f.inDiff = !!f.anchor;
  });
  // Findings only from reviewers with `validate: false` were checked with tools the validator lacks.
  const noValidate = new Set(
    readJson<{ name: string; validate?: boolean }[]>(paths(runDir).reviewers, [])
      .filter((r) => r.validate === false)
      .map((r) => r.name),
  );
  for (const f of kept)
    if (f.reviewers.length && f.reviewers.every((n) => noValidate.has(n)))
      f.validation = { verdict: 'skipped', reason: 'checked by the reviewer, not validated' };
  writeJson(paths(runDir).candidates, kept);

  const validate = settings.validation.enabled
    ? kept
        .filter((f) => !f.validation.reason)
        .map((f) => {
          const file = join(paths(runDir).prompts, `validate-${f.id}.md`);
          writeFileSync(file, validatorPrompt(SIEVE_ROOT, meta, settings, files, f));
          return { id: f.id, model: validatorModel(settings, f), title: f.title, prompt: file };
        })
    : [];

  out({ count: kept.length, dropped, validation: settings.validation.enabled, validate });
}

// ───────────────────────────── finalize ─────────────────────────────

interface Verdict {
  id: string;
  verdict: 'valid' | 'invalid';
  confidence?: number;
  reason?: string;
  line?: number;
  endLine?: number;
}

async function finalize(argv: string[]) {
  const runDir = resolve(argv[0] || die('usage: sieve finalize <runDir> [< verdicts.json]'));
  const { meta, files } = loadRun(runDir);
  const settings = loadSettings(meta.repoRoot, meta.overrides);
  const cands = readJson<Finding[]>(paths(runDir).candidates);
  const raw = parseJsonLoose(await readStdin());
  const verdicts = new Map<string, Verdict>();
  for (const v of (Array.isArray(raw) ? raw : []) as Verdict[]) if (v && v.id) verdicts.set(v.id, v);

  for (const f of cands) {
    const v = verdicts.get(f.id);
    if (!v) {
      f.validation = { verdict: 'skipped', reason: f.validation?.reason };
      continue;
    }
    f.validation = {
      verdict: v.verdict === 'invalid' ? 'invalid' : 'valid',
      confidence: typeof v.confidence === 'number' ? v.confidence : undefined,
      reason: v.reason,
    };
    if (v.line && Number(v.line) > 0) {
      f.line = Math.floor(Number(v.line));
      f.endLine = v.endLine && Number(v.endLine) > f.line ? Math.floor(Number(v.endLine)) : undefined;
      f.anchor = anchorFor(files, f.file, f.line, f.endLine);
      f.inDiff = !!f.anchor;
    }
    f.filtered =
      f.validation.verdict === 'invalid' ||
      (f.validation.confidence !== undefined && f.validation.confidence < settings.validation.minConfidence);
  }
  writeJson(paths(runDir).findings, cands);

  const prev = readJson<RunState>(paths(runDir).state, { findings: {} });
  const state: RunState = { ...prev, findings: {} };
  for (const f of cands) state.findings[f.id] = prev.findings[f.id] || { status: 'open', messages: [] };
  writeJson(paths(runDir).state, state);

  const valid = cands.filter((f) => !f.filtered);
  out({
    runDir,
    findings: valid.length,
    filtered: cands.length - valid.length,
    bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, valid.filter((f) => f.severity === s).length])),
  });
}

// ───────────────────────────── map ─────────────────────────────

async function map(argv: string[]) {
  const runDir = resolve(argv[0] || die('usage: sieve map <runDir> < map.json'));
  const { meta, files } = loadRun(runDir);
  const settings = loadSettings(meta.repoRoot, meta.overrides);
  const m = normalizeMap(parseMapOutput(await readStdin()), meta, files, settings);
  writeJson(paths(runDir).map, m);
  out({ flows: m.flows.length, nodes: m.flows.reduce((n, f) => n + f.nodes.length, 0) });
}

// ───────────────────────────── serve / runs ─────────────────────────────

async function serve(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      detach: { type: 'boolean', default: false },
      'idle-exit': { type: 'string' },
    },
  });
  const runDir = resolve(positionals[0] || die('usage: sieve serve <runDir>'));
  if (!existsSync(paths(runDir).meta)) die(`Not a sieve run: ${runDir}`);
  if (!existsSync(paths(runDir).findings)) die(`Run is not finalized yet (no findings.json): ${runDir}`);
  // Reviews started from the inbox run headless: the inbox opens the UI when the user asks.
  if (process.env.SIEVE_HEADLESS) return out({ runDir, headless: true, hint: 'Started from the Sieve inbox: no UI.' });

  if (values.detach) {
    const flags = [
      ...(values.port ? ['--port', values.port] : []),
      ...(values['no-open'] ? ['--no-open'] : []),
      ...(values['idle-exit'] ? ['--idle-exit', values['idle-exit']] : []),
    ];
    const r = await detach(paths(runDir).server, join(runDir, 'server.log'), ['serve', runDir, ...flags], '/api/run');
    if (r.reused && !values['no-open']) openUrl(r.url);
    return out({ ...r, runDir });
  }
  const { startServer } = await import('../server/index.ts');
  await startServer({
    runDir,
    sieveRoot: SIEVE_ROOT,
    port: values.port ? +values.port : undefined,
    open: !values['no-open'],
    idleExitMin: values['idle-exit'] ? +values['idle-exit'] : undefined,
  });
}

async function alive(url: string, health: string): Promise<boolean> {
  try {
    const r = await fetch(new URL(health, url), { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function openUrl(url: string) {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {}
}

/**
 * Run `sieve <args>` as a background server (or reuse the one in `info`) and return its URL.
 * The server writes `{ url, pid }` to `info` once it listens.
 */
async function detach(info: string, log: string, args: string[], health: string) {
  const prev = readJson<{ url?: string }>(info, {});
  if (prev.url && (await alive(prev.url, health))) return { url: prev.url, reused: true };
  rmSync(info, { force: true });
  const { spawn } = await import('node:child_process');
  const { openSync } = await import('node:fs');
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [import.meta.path, ...args], { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();

  const deadline = Date.now() + 180_000; // first run installs deps and builds the UI
  while (Date.now() < deadline) {
    await Bun.sleep(300);
    const cur = readJson<{ url?: string }>(info, {});
    if (cur.url) return { url: cur.url, log };
    if (child.exitCode !== null) break;
  }
  die(`Server did not start. See ${log}`);
}

// ───────────────────────────── inbox ─────────────────────────────

const INBOX_OFF = 'The inbox is off. Turn it on in ~/.sieve/settings.json: { "inbox": { "enabled": true } }';

async function inbox(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
    },
  });
  const settings = inboxSettings();
  if (!settings.inbox.enabled) die(INBOX_OFF);
  requireGh();

  if (values.json) {
    const { inboxData } = await import('../server/inbox.ts');
    return out(await inboxData(settings, new Map()));
  }
  // One fixed port, so the inbox can be bookmarked.
  const port = Math.floor(Number(values.port ?? settings.inbox.port));
  if (!(port > 0 && port < 65536)) die(`Invalid inbox port: ${values.port ?? settings.inbox.port}`);
  if (values.serve) {
    const { startInboxServer } = await import('../server/inbox.ts');
    return void (await startInboxServer({ sieveRoot: SIEVE_ROOT, port, open: !values['no-open'] }));
  }
  const info = join(SIEVE_HOME, 'inbox.json');
  // The port setting changed: stop the inbox still running on the old one.
  const prev = readJson<{ url?: string; pid?: number }>(info, {});
  if (prev.url && prev.pid && new URL(prev.url).port !== String(port)) {
    try {
      process.kill(prev.pid);
    } catch {}
    rmSync(info, { force: true });
  }
  if (!(await alive(`http://127.0.0.1:${port}/`, '/api/inbox/ping'))) {
    try {
      Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() }).stop(true);
    } catch {
      die(`Port ${port} is taken by another program. Set "inbox.port" in ~/.sieve/settings.json.`);
    }
  }
  const r = await detach(
    info,
    join(SIEVE_HOME, 'inbox.log'),
    ['inbox', '--serve', '--port', String(port), ...(values['no-open'] ? ['--no-open'] : [])],
    '/api/inbox/ping',
  );
  if (r.reused && !values['no-open']) openUrl(r.url + 'inbox');
  out(r);
}

function runs() {
  const root = repoRootOf(process.cwd()) || die('Not inside a git repository.');
  const base = join(root, '.sieve', 'runs');
  if (!existsSync(base)) return out([]);
  const list: unknown[] = [];
  for (const group of readdirSync(base)) {
    for (const id of readdirSync(join(base, group))) {
      const dir = join(base, group, id);
      if (!existsSync(paths(dir).meta)) continue;
      const meta = readJson<RunMeta>(paths(dir).meta);
      const findings = readJson<Finding[]>(paths(dir).findings, []);
      list.push({
        runDir: dir,
        title: meta.title,
        url: meta.url,
        createdAt: meta.createdAt,
        findings: findings.filter((f) => !f.filtered).length,
      });
    }
  }
  out(list);
}

// ───────────────────────────── main ─────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'prepare':
      await prepare(rest);
      break;
    case 'candidates':
      await candidates(rest);
      break;
    case 'finalize':
      await finalize(rest);
      break;
    case 'map':
      await map(rest);
      break;
    case 'serve':
      await serve(rest);
      break;
    case 'runs':
      runs();
      break;
    case 'inbox':
      await inbox(rest);
      break;
    default:
      process.stdout.write(
        'usage: sieve <prepare|candidates|finalize|map|serve|runs|inbox> …\n' +
          '  prepare [PR url | owner/repo#n | n] [--base ref] [--lang l] [--comment-lang l] [--only a,b] [--skip a,b] [--min-severity s] [--force]\n' +
          '  candidates <runDir>   < findings JSON\n' +
          '  finalize <runDir>     < verdicts JSON\n' +
          '  map <runDir>          < cartographer JSON\n' +
          '  serve <runDir> [--port n] [--no-open] [--detach] [--idle-exit min]\n' +
          '  runs\n' +
          '  inbox [--json] [--port n] [--no-open]\n',
      );
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die((e as Error).message);
}
