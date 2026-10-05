/**
 * `bun run dev` — UI development against a ready-made run.
 *
 * Builds `.sieve/runs/dev` from `examples/dev-run` (a fake PR on a real commit of this repo,
 * so the diff and the code are real), pushes the findings through `candidates` + `finalize`,
 * then starts the API on :4545 and the Vite dev server that proxies to it.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunMeta } from '../shared/types.ts';
import { parseDiff } from './lib/diff.ts';
import { paths, readJson, writeJson } from './lib/run.ts';
import { run } from './lib/sh.ts';
import { ensureWorktree, excludeRuns } from './lib/source.ts';

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'examples', 'dev-run');
const RUN = join(ROOT, '.sieve', 'runs', 'dev');
const PORT = 4545;

const fx = readJson<Omit<RunMeta, 'id' | 'mode' | 'createdAt' | 'repoRoot' | 'worktree' | 'runDir' | 'changedFiles'>>(
  join(FIXTURE, 'run.json'),
);
const p = paths(RUN);

// Fresh run every time; keep the worktree, it is slow to recreate.
mkdirSync(RUN, { recursive: true });
for (const f of readdirSync(RUN)) if (f !== 'wt') rmSync(join(RUN, f), { recursive: true, force: true });
excludeRuns(ROOT);
ensureWorktree(ROOT, p.worktree, fx.headSha);

const patch = run(['git', 'diff', '--no-color', fx.baseSha, fx.headSha], { cwd: ROOT });
const files = parseDiff(patch);
writeFileSync(p.patch, patch);
writeJson(p.diff, files);
// repoRoot = the run dir: settings, learned.md and rules stay inside it, never in this repo.
const meta: RunMeta = {
  ...fx,
  id: 'dev',
  mode: 'local',
  createdAt: new Date().toISOString(),
  repoRoot: RUN,
  worktree: p.worktree,
  runDir: RUN,
  changedFiles: files.map((f) => f.path),
  overrides: { minSeverity: 'nit' },
};
writeJson(p.meta, meta);
copyFileSync(join(FIXTURE, 'CLAUDE.md'), join(RUN, 'CLAUDE.md'));
writeJson(p.rules, [{ path: 'CLAUDE.md', scope: '' }]);
copyFileSync(join(FIXTURE, 'map.json'), p.map);
copyFileSync(join(FIXTURE, 'state.json'), p.state);
mkdirSync(p.prompts, { recursive: true });

const cli = join(ROOT, 'cli', 'sieve.ts');
const pipe = (cmd: string, input: string) =>
  run(['bun', cli, cmd, RUN], { cwd: ROOT, input: readFileSync(join(FIXTURE, input), 'utf8') });
pipe('candidates', 'findings.json');
pipe('finalize', 'verdicts.json');

const procs = [
  Bun.spawn(['bun', cli, 'serve', RUN, '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    stdout: 'ignore',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'run', 'dev:ui'], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, SIEVE_API: `http://127.0.0.1:${PORT}` },
  }),
];
const stop = () => {
  for (const pr of procs) pr.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race(procs.map((pr) => pr.exited));
stop();
