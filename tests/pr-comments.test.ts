import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDiff } from '../cli/lib/diff.ts';
import { parsePrComments } from '../cli/lib/threads.ts';
import type { Finding } from '../shared/types.ts';

describe('parsePrComments', () => {
  const gql = (pr: object) => ({ data: { repository: { pullRequest: pr } } });

  test('flattens threads, review bodies and conversation comments', () => {
    const out = parsePrComments(
      gql({
        reviewThreads: {
          nodes: [
            {
              isResolved: true,
              path: 'a.ts',
              line: null,
              originalLine: 7,
              comments: {
                nodes: [
                  { url: 'u1', body: 'null check', author: { login: 'kate' } },
                  { url: 'u2', body: 'fixed', author: { login: 'bob' } },
                ],
              },
            },
          ],
        },
        reviews: { nodes: [{ url: 'u3', body: 'Outside the diff: …', author: { login: 'kate' } }] },
        comments: { nodes: [{ url: 'u4', body: 'LGTM', author: null }] },
      }),
    );
    expect(out).toEqual([
      {
        url: 'u1',
        author: 'kate',
        body: 'null check',
        file: 'a.ts',
        line: 7,
        resolved: true,
        replies: [{ author: 'bob', body: 'fixed' }],
      },
      { url: 'u3', author: 'kate', body: 'Outside the diff: …' },
      { url: 'u4', author: 'ghost', body: 'LGTM' },
    ]);
  });

  test('skips empty review bodies (an approval without text) and broken responses', () => {
    expect(parsePrComments(gql({ reviews: { nodes: [{ url: 'u', body: '  ', author: { login: 'x' } }] } }))).toEqual(
      [],
    );
    expect(parsePrComments({ errors: [{ message: 'nope' }] })).toEqual([]);
  });
});

describe('candidates → finalize with duplicateOf', () => {
  const CLI = resolve(import.meta.dir, '..', 'cli', 'sieve.ts');
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n x\n+y\n+z\n';
  const finding = (title: string, duplicateOf?: string) => ({
    file: 'a.ts',
    line: 2,
    severity: 'major',
    category: 'bug',
    title,
    explanation: 'because',
    reviewers: ['r'],
    ...(duplicateOf ? { duplicateOf } : {}),
  });

  function runCli(args: string[], input: string, home: string) {
    const p = Bun.spawnSync(['bun', CLI, ...args], {
      stdin: new TextEncoder().encode(input),
      env: { ...process.env, SIEVE_HOME: home },
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return JSON.parse(p.stdout.toString());
  }

  test('a known duplicate is filtered with its link and not validated; an unknown URL is ignored', () => {
    const home = mkdtempSync(join(tmpdir(), 'sieve-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'sieve-run-'));
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        mode: 'pr',
        repoRoot: dir,
        worktree: dir,
        runDir: dir,
        changedFiles: ['a.ts'],
        title: 'T',
        body: '',
        baseRef: 'main',
        headRef: 'f',
        baseSha: '0000000000',
        headSha: '1111111111',
      }),
    );
    mkdirSync(join(dir, 'prompts'));
    writeFileSync(join(dir, 'diff.json'), JSON.stringify(parseDiff(patch)));
    writeFileSync(join(dir, 'pr-comments.json'), JSON.stringify([{ url: 'https://gh/c1', author: 'k', body: 'b' }]));

    const c = runCli(
      ['candidates', dir],
      JSON.stringify({
        findings: [finding('dup', 'https://gh/c1'), finding('made-up link', 'https://gh/none'), finding('new')],
      }),
      home,
    );
    expect(c.count).toBe(3);
    expect(c.validate.map((v: { title: string }) => v.title).sort()).toEqual(['made-up link', 'new']);

    runCli(['finalize', dir], '[]', home);
    const out = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')) as Finding[];
    const byTitle = Object.fromEntries(out.map((f) => [f.title, f]));
    expect(byTitle.dup.filtered).toBe(true);
    expect(byTitle.dup.validation).toEqual({ verdict: 'duplicate', duplicateOf: 'https://gh/c1' });
    expect(byTitle['made-up link'].filtered).toBe(false);
    expect(byTitle['made-up link'].duplicateOf).toBeUndefined();
    expect(byTitle.new.filtered).toBe(false);
  });
});
