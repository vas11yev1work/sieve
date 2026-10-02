#!/usr/bin/env bun
/**
 * Sieve CLI — the deterministic half of the review pipeline.
 * The Claude Code skill (skills/review/SKILL.md) orchestrates the agents and calls these commands.
 *
 *   sieve prepare [PR url | owner/repo#n | n] [--base <ref>] [--lang <l>] [--comment-lang <l>] [--force]
 *   sieve candidates <runDir>    < merged reviewer findings (JSON array)
 *   sieve finalize <runDir>      < validator verdicts (JSON array, optional)
 *   sieve serve <runDir> [--port <n>] [--no-open]
 *   sieve runs                   list runs of the current repo
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname, isAbsolute, relative } from 'node:path'
import { parseArgs } from 'node:util'
import type { Finding, RawFinding, RunMeta, RunState, Settings, Severity } from '../shared/types.ts'
import { SEVERITIES } from '../shared/types.ts'
import { loadSettings } from './lib/settings.ts'
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
} from './lib/source.ts'
import { parseDiff, anchorFor } from './lib/diff.ts'
import { discoverRules, isIgnored } from './lib/rules.ts'
import { loadReviewers } from './lib/reviewers.ts'
import { reviewerPrompt, validatorPrompt, validatorModel, diffStats } from './lib/prompts.ts'
import { paths, readJson, writeJson, loadRun } from './lib/run.ts'

export const SIEVE_ROOT = resolve(dirname(import.meta.path), '..')

function out(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function die(msg: string): never {
  process.stderr.write(`sieve: ${msg}\n`)
  process.exit(1)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return await new Response(Bun.stdin.stream()).text()
}

/** Accept a JSON array, or text containing one (agents sometimes wrap output in prose/fences). */
function parseJsonLoose(text: string): unknown {
  const t = text.trim()
  if (!t) return []
  try {
    return JSON.parse(t)
  } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try {
      return JSON.parse(fence[1]!)
    } catch {}
  }
  const a = t.indexOf('[')
  const b = t.lastIndexOf(']')
  if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1))
  throw new Error('stdin is not valid JSON')
}

function splitPatch(patch: string): { path: string; text: string }[] {
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '))
  return parts.map((text) => ({ text, path: parseDiff(text)[0]?.path || '' }))
}

/** Stop a UI server left over from a previous review of the same run dir. */
function stopServer(runDir: string) {
  const info = readJson<{ pid?: number }>(paths(runDir).server, {})
  if (info.pid && info.pid !== process.pid) {
    try {
      process.kill(info.pid)
    } catch {}
  }
  rmSync(paths(runDir).server, { force: true })
}

function slug(s: string) {
  return (
    s
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'x'
  )
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
      force: { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
  })
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd()
  const input = parseInput(positionals.join(' '), values.base)

  const overrides: Partial<Settings> = {}
  if (values.lang) overrides.reportLanguage = values.lang
  if (values['comment-lang']) overrides.commentLanguage = values['comment-lang']

  let meta: RunMeta
  let patch: string

  if (input.kind === 'pr') {
    requireGh()
    const slugRepo = input.owner && input.repo ? { owner: input.owner, repo: input.repo } : currentRepoSlug(cwd)
    const pr = fetchPr(slugRepo.owner, slugRepo.repo, input.number)
    const { root, remote } = ensureRepo(cwd, slugRepo.owner, slugRepo.repo)
    const id = `pr${pr.number}-${pr.headRefOid.slice(0, 7)}`
    const runDir = join(root, '.sieve', 'runs', `${slugRepo.owner}-${slugRepo.repo}`.toLowerCase(), id)

    if (existsSync(paths(runDir).findings) && !values.force) {
      const findings = readJson<Finding[]>(paths(runDir).findings)
      return out({
        existing: true,
        runDir,
        title: pr.title,
        url: pr.url,
        findings: findings.filter((f) => !f.filtered).length,
        hint: 'This revision was already reviewed. Run `serve` to open it, or `prepare --force` to review again.',
      })
    }

    stopServer(runDir)
    excludeRuns(root)
    fetchPrRefs(root, remote, pr)
    const wt = paths(runDir).worktree
    ensureWorktree(root, wt, pr.headRefOid)
    patch = prDiff(slugRepo.owner, slugRepo.repo, pr.number, root, pr.baseRefOid, pr.headRefOid)

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
    }
  } else {
    const root = repoRootOf(cwd)
    if (!root) die('Not inside a git repository. Run from your project, or pass a PR URL.')
    const base = input.base || defaultBase(root)
    const d = localDiff(root, base)
    patch = d.patch
    const id = `local-${slug(d.branch)}`
    const runDir = join(root, '.sieve', 'runs', 'local', id)
    if (existsSync(runDir)) {
      stopServer(runDir)
      rmSync(runDir, { recursive: true, force: true })
    }
    excludeRuns(root)
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
    }
  }

  const settings = loadSettings(meta.repoRoot, overrides)

  // Drop ignored files (lockfiles, generated code…) from what the agents see.
  const kept = splitPatch(patch).filter((p) => p.path && !isIgnored(p.path, settings.ignore))
  patch = kept.map((p) => p.text).join('')
  const files = parseDiff(patch)
  meta.changedFiles = files.map((f) => f.path)

  const p = paths(meta.runDir)
  mkdirSync(meta.runDir, { recursive: true })
  rmSync(p.prompts, { recursive: true, force: true })
  for (const f of [p.candidates, p.findings, p.state]) rmSync(f, { force: true })
  writeFileSync(p.patch, patch)
  writeJson(p.diff, files)
  writeJson(p.meta, meta)

  const rules = discoverRules(meta.worktree, settings.rules, meta.changedFiles)
  writeJson(p.rules, rules)

  const reviewers = loadReviewers(SIEVE_ROOT, meta.repoRoot, settings)
  mkdirSync(p.prompts, { recursive: true })
  const plan = reviewers.map((r) => {
    const file = join(p.prompts, `review-${r.name}.md`)
    writeFileSync(file, reviewerPrompt(SIEVE_ROOT, meta, settings, files, rules, r))
    return { name: r.name, model: r.model, description: r.description, prompt: file }
  })

  const stats = diffStats(files)
  let stop: string | undefined
  if (!files.length) stop = 'Nothing to review: the diff is empty (after ignore filters).'
  else if (meta.mode === 'pr' && meta.state && meta.state !== 'OPEN' && !values.force)
    stop = `PR is ${meta.state.toLowerCase()}. Use --force to review anyway.`

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
    rules: rules.map((r) => r.path),
    reviewers: plan,
    ...(stop ? { stop } : {}),
  })
}

// ───────────────────────────── candidates ─────────────────────────────

function normalizePath(file: string, meta: RunMeta): string | null {
  let f = String(file || '')
    .trim()
    .replace(/^\.\//, '')
  if (isAbsolute(f)) f = relative(meta.worktree, f)
  if (meta.changedFiles.includes(f)) return f
  const bySuffix = meta.changedFiles.filter((c) => c.endsWith('/' + f) || f.endsWith('/' + c))
  return bySuffix.length === 1 ? bySuffix[0]! : null
}

function sevRank(s: Severity) {
  return SEVERITIES.indexOf(s)
}

async function candidates(argv: string[]) {
  const runDir = resolve(argv[0] || die('usage: sieve candidates <runDir> < findings.json'))
  const { meta, files } = loadRun(runDir)
  const settings = loadSettings(meta.repoRoot, meta.overrides)
  const raw = parseJsonLoose(await readStdin())
  const list: RawFinding[] = Array.isArray(raw) ? raw : ((raw as { findings?: RawFinding[] }).findings ?? [])

  const dropped: { title?: string; reason: string }[] = []
  const seen = new Set<string>()
  const kept: Finding[] = []
  const minRank = sevRank(settings.minSeverity)

  for (const r of list) {
    const file = normalizePath(r.file, meta)
    if (!file) {
      dropped.push({ title: r.title, reason: `file not in diff: ${r.file}` })
      continue
    }
    if (!r.title || !r.explanation) {
      dropped.push({ title: r.title, reason: 'missing title/explanation' })
      continue
    }
    const severity: Severity = SEVERITIES.includes(r.severity) ? r.severity : 'minor'
    if (sevRank(severity) > minRank) {
      dropped.push({ title: r.title, reason: `below minSeverity (${severity})` })
      continue
    }
    const line = Math.max(1, Math.floor(Number(r.line) || 1))
    const endLine = r.endLine && Number(r.endLine) > line ? Math.floor(Number(r.endLine)) : undefined
    const key = `${file}:${line}:${r.title.toLowerCase().trim()}`
    if (seen.has(key)) continue
    seen.add(key)
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
    })
  }

  kept.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line)
  kept.forEach((f, i) => {
    f.id = `f${i + 1}`
    f.inDiff = !!f.anchor
  })
  writeJson(paths(runDir).candidates, kept)

  const validate = settings.validation.enabled
    ? kept.map((f) => {
        const file = join(paths(runDir).prompts, `validate-${f.id}.md`)
        writeFileSync(file, validatorPrompt(SIEVE_ROOT, meta, settings, files, f))
        return { id: f.id, model: validatorModel(settings, f), title: f.title, prompt: file }
      })
    : []

  out({ count: kept.length, dropped, validation: settings.validation.enabled, validate })
}

// ───────────────────────────── finalize ─────────────────────────────

interface Verdict {
  id: string
  verdict: 'valid' | 'invalid'
  confidence?: number
  reason?: string
  line?: number
  endLine?: number
}

async function finalize(argv: string[]) {
  const runDir = resolve(argv[0] || die('usage: sieve finalize <runDir> [< verdicts.json]'))
  const { meta, files } = loadRun(runDir)
  const settings = loadSettings(meta.repoRoot, meta.overrides)
  const cands = readJson<Finding[]>(paths(runDir).candidates)
  const raw = parseJsonLoose(await readStdin())
  const verdicts = new Map<string, Verdict>()
  for (const v of (Array.isArray(raw) ? raw : []) as Verdict[]) if (v && v.id) verdicts.set(v.id, v)

  for (const f of cands) {
    const v = verdicts.get(f.id)
    if (!v) {
      f.validation = { verdict: 'skipped' }
      continue
    }
    f.validation = {
      verdict: v.verdict === 'invalid' ? 'invalid' : 'valid',
      confidence: typeof v.confidence === 'number' ? v.confidence : undefined,
      reason: v.reason,
    }
    if (v.line && Number(v.line) > 0) {
      f.line = Math.floor(Number(v.line))
      f.endLine = v.endLine && Number(v.endLine) > f.line ? Math.floor(Number(v.endLine)) : undefined
      f.anchor = anchorFor(files, f.file, f.line, f.endLine)
      f.inDiff = !!f.anchor
    }
    f.filtered =
      f.validation.verdict === 'invalid' ||
      (f.validation.confidence !== undefined && f.validation.confidence < settings.validation.minConfidence)
  }
  writeJson(paths(runDir).findings, cands)

  const prev = readJson<RunState>(paths(runDir).state, { findings: {} })
  const state: RunState = { ...prev, findings: {} }
  for (const f of cands) state.findings[f.id] = prev.findings[f.id] || { status: 'open', messages: [] }
  writeJson(paths(runDir).state, state)

  const valid = cands.filter((f) => !f.filtered)
  out({
    runDir,
    findings: valid.length,
    filtered: cands.length - valid.length,
    bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, valid.filter((f) => f.severity === s).length])),
  })
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
    },
  })
  const runDir = resolve(positionals[0] || die('usage: sieve serve <runDir>'))
  if (!existsSync(paths(runDir).meta)) die(`Not a sieve run: ${runDir}`)
  if (!existsSync(paths(runDir).findings)) die(`Run is not finalized yet (no findings.json): ${runDir}`)

  if (values.detach) return serveDetached(runDir, values.port, !values['no-open'])
  const { startServer } = await import('../server/index.ts')
  await startServer({
    runDir,
    sieveRoot: SIEVE_ROOT,
    port: values.port ? +values.port : undefined,
    open: !values['no-open'],
  })
}

async function alive(url: string): Promise<boolean> {
  try {
    const r = await fetch(new URL('/api/run', url), { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

function openUrl(url: string) {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' })
  } catch {}
}

/** Start the server in the background (or reuse a running one) and print its URL. */
async function serveDetached(runDir: string, port: string | undefined, open: boolean) {
  const info = paths(runDir).server
  const prev = readJson<{ url?: string }>(info, {})
  if (prev.url && (await alive(prev.url))) {
    if (open) openUrl(prev.url)
    return out({ url: prev.url, runDir, reused: true })
  }
  rmSync(info, { force: true })
  const { spawn } = await import('node:child_process')
  const { openSync } = await import('node:fs')
  const log = join(runDir, 'server.log')
  const fd = openSync(log, 'a')
  const args = [import.meta.path, 'serve', runDir, ...(port ? ['--port', port] : []), ...(open ? [] : ['--no-open'])]
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] })
  child.unref()

  const deadline = Date.now() + 180_000 // first run installs deps and builds the UI
  while (Date.now() < deadline) {
    await Bun.sleep(300)
    const cur = readJson<{ url?: string }>(info, {})
    if (cur.url) return out({ url: cur.url, runDir, log })
    if (child.exitCode !== null) break
  }
  die(`Server did not start. See ${log}`)
}

function runs() {
  const root = repoRootOf(process.cwd()) || die('Not inside a git repository.')
  const base = join(root, '.sieve', 'runs')
  if (!existsSync(base)) return out([])
  const list: unknown[] = []
  for (const group of readdirSync(base)) {
    for (const id of readdirSync(join(base, group))) {
      const dir = join(base, group, id)
      if (!existsSync(paths(dir).meta)) continue
      const meta = readJson<RunMeta>(paths(dir).meta)
      const findings = readJson<Finding[]>(paths(dir).findings, [])
      list.push({
        runDir: dir,
        title: meta.title,
        url: meta.url,
        createdAt: meta.createdAt,
        findings: findings.filter((f) => !f.filtered).length,
      })
    }
  }
  out(list)
}

// ───────────────────────────── main ─────────────────────────────

const [cmd, ...rest] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'prepare':
      await prepare(rest)
      break
    case 'candidates':
      await candidates(rest)
      break
    case 'finalize':
      await finalize(rest)
      break
    case 'serve':
      await serve(rest)
      break
    case 'runs':
      runs()
      break
    default:
      process.stdout.write(
        'usage: sieve <prepare|candidates|finalize|serve|runs> …\n' +
          '  prepare [PR url | owner/repo#n | n] [--base ref] [--lang l] [--comment-lang l] [--force]\n' +
          '  candidates <runDir>   < findings JSON\n' +
          '  finalize <runDir>     < verdicts JSON\n' +
          '  serve <runDir> [--port n] [--no-open]\n' +
          '  runs\n',
      )
      process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  die((e as Error).message)
}
