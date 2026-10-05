import { describe, expect, test } from 'bun:test';
import { bucketOf, parsePrs, scopeQuery } from '../cli/lib/inbox.ts';
import { DEFAULT_SETTINGS } from '../cli/lib/settings.ts';
import { trackJob } from '../server/inbox.ts';
import type { InboxJob } from '../shared/types.ts';
import { progress } from '../ui/src/inbox/track.ts';

describe('bucketOf', () => {
  const mine = (state: string, onHead: boolean) => ({ state, at: '', onHead });

  test('needs you: requested, or new commits after your review', () => {
    expect(bucketOf({ requested: 'me' })).toBe('review');
    expect(bucketOf({ requested: 'team' })).toBe('review');
    expect(bucketOf({ requested: null, myReview: mine('APPROVED', false) })).toBe('review');
    expect(bucketOf({ requested: null, myReview: mine('COMMENTED', false) })).toBe('review');
    // personally requested again on the same head
    expect(bucketOf({ requested: 'me', myReview: mine('COMMENTED', true) })).toBe('review');
    // your review on the current head was dismissed
    expect(bucketOf({ requested: null, myReview: mine('DISMISSED', true) })).toBe('review');
  });

  test('hidden: you already reviewed the current head', () => {
    expect(bucketOf({ requested: null, myReview: mine('APPROVED', true) })).toBeNull();
    expect(bucketOf({ requested: null, myReview: mine('CHANGES_REQUESTED', true) })).toBeNull();
    expect(bucketOf({ requested: 'team', myReview: mine('APPROVED', true) })).toBeNull();
    expect(bucketOf({ requested: null })).toBeNull();
  });

  test('a running review wins', () => {
    const job = { state: 'running' } as InboxJob;
    expect(bucketOf({ requested: null, myReview: mine('APPROVED', true), job })).toBe('reviewing');
  });
});

describe('scopeQuery', () => {
  test('qualifiers', () => {
    const s = { ...DEFAULT_SETTINGS.inbox, repos: ['a/b'], owners: ['acme'], excludeRepos: ['acme/old'] };
    expect(scopeQuery(s)).toBe('is:pr is:open archived:false draft:false repo:a/b user:acme -repo:acme/old');
  });
});

describe('parsePrs', () => {
  const pr = (url: string, extra: object = {}) => ({
    url,
    number: 1,
    title: 't',
    headRefOid: 'head',
    repository: { name: 'web', owner: { login: 'acme' } },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
    ...extra,
  });

  test('why it is here, reviews, threads', () => {
    const rows = parsePrs(
      {
        requested: {
          nodes: [
            pr('u1', {
              reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'Me' } }] },
              reviews: {
                nodes: [
                  { author: { login: 'bob' }, state: 'APPROVED', commit: { oid: 'head' } },
                  { author: { login: 'bob' }, state: 'COMMENTED', commit: { oid: 'head' } },
                  { author: { login: 'ann' }, state: 'APPROVED', commit: { oid: 'old' } },
                  { author: { login: 'me' }, state: 'CHANGES_REQUESTED', commit: { oid: 'old' } },
                ],
              },
            }),
            pr('u2', {
              reviewRequests: {
                nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'fe', organization: { login: 'acme' } } }],
              },
            }),
          ],
        },
        // u1 is also in "reviewed": the requested row wins
        reviewed: { nodes: [pr('u1'), pr('u3')] },
      },
      'me',
    );
    expect(rows.map((r) => [r.url, r.requested])).toEqual([
      ['u1', 'me'],
      ['u2', 'team'],
      ['u3', null],
    ]);
    // bob: a later COMMENTED keeps the approval; ann approved before newer commits → not counted
    expect(rows[0]!.approvals).toBe(1);
    expect(rows[0]!.myReview).toMatchObject({ state: 'CHANGES_REQUESTED', onHead: false });
    expect(rows[1]!.teams).toEqual(['acme/fe']);
    expect(rows[0]!.threads).toEqual({ total: 2, unresolved: 1 });
    expect(rows[0]!.ci).toBe('FAILURE');
  });
});

describe('trackJob', () => {
  test('phases and agents from the orchestrator stream', () => {
    const job: InboxJob = { url: 'u', state: 'running', phase: 'prepare', agents: [], queuedAt: '' };
    const use = (id: string, name: string, input: object, parent: string | null = null) =>
      trackJob(job, {
        type: 'assistant',
        parent_tool_use_id: parent,
        message: { content: [{ type: 'tool_use', id, name, input }] },
      });
    const done = (id: string, content = '') =>
      trackJob(job, {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
      });

    use('b1', 'Bash', { command: 'bun "/s/cli/sieve.ts" prepare 12' });
    done('b1', '{\n  "runDir": "/repo/.sieve/runs/a-b/pr12-abc",\n  "mode": "pr"\n}');
    expect(job.runDir).toBe('/repo/.sieve/runs/a-b/pr12-abc');
    use('t1', 'Agent', { description: 'Sieve: rules' });
    use('t2', 'Task', { description: 'Sieve: bugs-diff' });
    use('x', 'Agent', { description: 'nested' }, 't1'); // a subagent's own call
    expect(job.phase).toBe('review');
    expect(job.agents.map((a) => a.name)).toEqual(['rules', 'bugs-diff']);
    done('t1');
    expect(job.agents.filter((a) => a.done).length).toBe(1);
    use('b2', 'Bash', { command: 'bun "/s/cli/sieve.ts" candidates "/r" <<\'SIEVE_JSON\'' });
    use('v1', 'Agent', { description: 'Sieve: validate f1' });
    expect(job.phase).toBe('validate');
    expect(job.agents.at(-1)).toMatchObject({ name: 'f1', phase: 'validate' });
    use('b3', 'Bash', { command: 'bun "/s/cli/sieve.ts" finalize "/r"' });
    expect(job.phase).toBe('finalize');
  });
});

describe('progress ring', () => {
  const job = (phase: InboxJob['phase'], agents: [string, boolean][] = []): InboxJob => ({
    url: 'u',
    state: 'running',
    phase,
    queuedAt: '',
    agents: agents.map(([p, done], k) => ({ id: `a${k}`, name: 'x', phase: p as 'review', done })),
  });

  test('moves forward through the stages', () => {
    const r = [
      progress(job('queued')),
      progress(job('prepare')),
      progress(
        job('review', [
          ['review', true],
          ['review', false],
        ]),
      ),
      progress(
        job('review', [
          ['review', true],
          ['review', true],
        ]),
      ),
      progress(
        job('validate', [
          ['review', true],
          ['validate', true],
          ['validate', false],
        ]),
      ),
      progress(job('finalize')),
      progress(job('done')),
    ];
    expect(r).toEqual([...r].sort((a, b) => a - b));
    expect(r[0]).toBe(0);
    expect(r.at(-1)).toBe(1);
    // reviewers half done → half of the reviewers' slice
    expect(r[2]).toBeCloseTo(0.375);
  });
});
