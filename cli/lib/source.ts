import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { sh, run, has } from './sh.ts';
import { SIEVE_HOME } from './settings.ts';

export type Input = { kind: 'pr'; owner?: string; repo?: string; number: number } | { kind: 'local'; base?: string };

/** Accepts a PR URL, "owner/repo#123", "#123", "123" or nothing (local diff). */
export function parseInput(arg: string | undefined, base?: string): Input {
  const a = (arg || '').trim();
  if (!a) return { kind: 'local', base };
  let m = a.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (m) return { kind: 'pr', owner: m[1], repo: m[2]!.replace(/\.git$/, ''), number: +m[3]! };
  m = a.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (m) return { kind: 'pr', owner: m[1], repo: m[2], number: +m[3]! };
  m = a.match(/^#?(\d+)$/);
  if (m) return { kind: 'pr', number: +m[1]! };
  throw new Error(
    `Can't understand "${a}". Pass a PR URL, owner/repo#123, a PR number, or nothing for the local diff.`,
  );
}

export function repoRootOf(cwd: string): string | null {
  const r = sh(['git', 'rev-parse', '--show-toplevel'], { cwd });
  return r.ok ? r.stdout.trim() : null;
}

interface Remote {
  name: string;
  owner: string;
  repo: string;
}

export function githubRemotes(repoRoot: string): Remote[] {
  const r = sh(['git', 'remote', '-v'], { cwd: repoRoot });
  if (!r.ok) return [];
  const out: Remote[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(
      /^(\S+)\s+(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\s+\(fetch\)/,
    );
    if (m) out.push({ name: m[1]!, owner: m[2]!, repo: m[3]! });
  }
  return out;
}

export function requireGh() {
  if (!has('gh'))
    throw new Error('GitHub CLI (gh) is required for PR reviews: https://cli.github.com — then run `gh auth login`.');
}

/** Find a local checkout of owner/repo: the current repo if it matches, otherwise a cached clone. */
export function ensureRepo(
  cwd: string,
  owner: string,
  repo: string,
): { root: string; remote: string; cloned: boolean } {
  const here = repoRootOf(cwd);
  if (here) {
    const rem = githubRemotes(here).find(
      (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase(),
    );
    if (rem) return { root: here, remote: rem.name, cloned: false };
  }
  const dir = join(SIEVE_HOME, 'repos', owner, repo);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), { recursive: true });
    run(['gh', 'repo', 'clone', `${owner}/${repo}`, dir, '--', '--filter=blob:none', '--no-checkout']);
  }
  return { root: dir, remote: 'origin', cloned: true };
}

export function currentRepoSlug(cwd: string): { owner: string; repo: string } {
  const root = repoRootOf(cwd);
  if (root) {
    const rems = githubRemotes(root);
    const pick = rems.find((r) => r.name === 'upstream') || rems.find((r) => r.name === 'origin') || rems[0];
    if (pick) return { owner: pick.owner, repo: pick.repo };
  }
  const r = sh(['gh', 'repo', 'view', '--json', 'owner,name', '-q', '.owner.login + "/" + .name'], { cwd });
  if (r.ok && r.stdout.includes('/')) {
    const [owner, repo] = r.stdout.trim().split('/');
    return { owner: owner!, repo: repo! };
  }
  throw new Error('Not inside a GitHub repository — pass a full PR URL instead of a number.');
}

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
}

export function fetchPr(owner: string, repo: string, n: number): PrInfo {
  const json = run([
    'gh',
    'pr',
    'view',
    String(n),
    '-R',
    `${owner}/${repo}`,
    '--json',
    'number,title,body,url,state,isDraft,author,baseRefName,headRefName,baseRefOid,headRefOid',
  ]);
  return JSON.parse(json);
}

/** Diff exactly as GitHub shows it; falls back to a local three-dot diff for huge PRs. */
export function prDiff(owner: string, repo: string, n: number, root: string, baseSha: string, headSha: string): string {
  const r = sh(['gh', 'pr', 'diff', String(n), '-R', `${owner}/${repo}`, '--color=never']);
  if (r.ok && r.stdout.trim()) return r.stdout;
  return run(['git', 'diff', '--no-color', '--no-ext-diff', `${baseSha}...${headSha}`], { cwd: root });
}

export function fetchPrRefs(root: string, remote: string, pr: PrInfo) {
  run(['git', 'fetch', '--quiet', remote, `+refs/pull/${pr.number}/head:refs/sieve/pr-${pr.number}`], { cwd: root });
  // Base commit is needed for blame/history agents and the local fallback diff.
  const b = sh(['git', 'cat-file', '-e', `${pr.baseRefOid}^{commit}`], { cwd: root });
  if (!b.ok) sh(['git', 'fetch', '--quiet', remote, pr.baseRefName], { cwd: root });
}

/** (Re)create a detached worktree at `sha`. */
export function ensureWorktree(root: string, dir: string, sha: string) {
  if (existsSync(dir)) {
    const head = sh(['git', 'rev-parse', 'HEAD'], { cwd: dir });
    if (head.ok && head.stdout.trim() === sha) return;
    sh(['git', 'worktree', 'remove', '--force', dir], { cwd: root });
  }
  sh(['git', 'worktree', 'prune'], { cwd: root });
  mkdirSync(dirname(dir), { recursive: true });
  run(['git', 'worktree', 'add', '--detach', '--force', dir, sha], { cwd: root });
}

/** Make sure `.sieve/runs/` never shows up in `git status`, without touching tracked files. */
export function excludeRuns(root: string) {
  const p = sh(['git', 'rev-parse', '--git-path', 'info/exclude'], { cwd: root });
  if (!p.ok) return;
  let file = p.stdout.trim();
  if (!isAbsolute(file)) file = resolve(root, file);
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!cur.split('\n').some((l) => l.trim() === '.sieve/runs/')) {
    appendFileSync(
      file,
      `${cur && !cur.endsWith('\n') ? '\n' : ''}# sieve\n.sieve/runs/\n.sieve/settings.local.json\n`,
    );
  }
}

export function defaultBase(root: string): string {
  const head = sh(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const c of [
    'origin/main',
    'origin/master',
    'origin/dev',
    'origin/develop',
    'main',
    'master',
    'dev',
    'develop',
  ]) {
    if (sh(['git', 'rev-parse', '--verify', '--quiet', c], { cwd: root }).ok) return c;
  }
  throw new Error('Could not detect the base branch. Pass it explicitly: --base <branch>');
}

/** Local diff: everything since the merge-base with `base`, including uncommitted and untracked files. */
export function localDiff(
  root: string,
  base: string,
): { patch: string; baseSha: string; headSha: string; branch: string } {
  const baseSha = run(['git', 'merge-base', base, 'HEAD'], { cwd: root });
  const headSha = run(['git', 'rev-parse', 'HEAD'], { cwd: root });
  const branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).stdout.trim() || 'HEAD';
  let patch = run(['git', 'diff', '--no-color', '--no-ext-diff', baseSha], { cwd: root });
  const untracked = sh(['git', 'ls-files', '--others', '--exclude-standard'], { cwd: root })
    .stdout.split('\n')
    .filter((f) => f && !f.startsWith('.sieve/'));
  for (const f of untracked) {
    const r = sh(['git', 'diff', '--no-color', '--no-index', '--', '/dev/null', f], { cwd: root });
    if (r.stdout) patch += (patch.endsWith('\n') || !patch ? '' : '\n') + r.stdout;
  }
  return { patch: patch.endsWith('\n') || !patch ? patch : patch + '\n', baseSha, headSha, branch };
}

/** All files known to git in `dir` (tracked + untracked-not-ignored). */
export function listFiles(dir: string): string[] {
  const r = sh(['git', 'ls-files', '-co', '--exclude-standard'], { cwd: dir });
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}
