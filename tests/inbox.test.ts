import { describe, expect, test } from 'bun:test';
import { applyInboxState, parsePrs, scopeQuery, turnOf } from '../cli/lib/inbox.ts';
import { DEFAULT_SETTINGS } from '../cli/lib/settings.ts';
import { runUsage, trackJob } from '../server/inbox.ts';
import type { InboxJob, InboxRun } from '../shared/types.ts';
import { progress } from '../ui/src/inbox/track.ts';

describe('turnOf', () => {
  const mine = (state: string, onHead: boolean) => ({ state, at: '', onHead });
  const run = (onHead: boolean, open: number, published = 0) =>
    ({
      onHead,
      status: { open, accepted: 0, rejected: 0 },
      unpublished: 0,
      reviews: published ? [{ at: '', count: published }] : [],
    }) as unknown as InboxRun;
  const pr = (o: Partial<Parameters<typeof turnOf>[0]>) => ({
    requested: null,
    runs: [],
    decision: null,
    approvals: 0,
    mergeable: 'MERGEABLE' as const,
    ...o,
  });
  const turn = (o: Partial<Parameters<typeof turnOf>[0]>) => turnOf(pr(o));

  test('your turn: requested now — first time, again, or via your team', () => {
    expect(turn({ requested: 'me' })).toEqual({ turn: 'me', why: 'requested' });
    expect(turn({ requested: 'me', myReview: mine('CHANGES_REQUESTED', false) })).toEqual({
      turn: 'me',
      why: 'rerequested',
    });
    expect(turn({ requested: 'team' })).toEqual({ turn: 'me', why: 'team' });
  });

  test('asked of you but approved by someone else: a group of its own; Sieve findings still come first', () => {
    expect(turn({ requested: 'me', approvals: 1 })).toEqual({ turn: 'others', why: 'requested' });
    expect(turn({ requested: 'me', decision: 'APPROVED' })?.turn).toBe('others');
    expect(turn({ requested: 'team', approvals: 1 })).toEqual({ turn: 'others', why: 'team' });
    expect(turn({ requested: 'me', approvals: 1, runs: [run(true, 2)] })).toEqual({ turn: 'me', why: 'findings' });
  });

  test("merge conflicts are the author's turn, even when you are requested or findings wait", () => {
    expect(turn({ requested: 'me', mergeable: 'CONFLICTING' })).toEqual({ turn: 'author', why: 'conflicts' });
    expect(turn({ myReview: mine('APPROVED', true), mergeable: 'CONFLICTING', runs: [run(true, 2)] })?.turn).toBe(
      'author',
    );
    expect(turn({ mergeable: 'CONFLICTING' })).toBeNull();
  });

  test("new commits without a new request stay the author's turn", () => {
    expect(turn({ myReview: mine('CHANGES_REQUESTED', false) })).toEqual({ turn: 'author', why: 'changes' });
    expect(turn({ myReview: mine('COMMENTED', true) })).toEqual({ turn: 'author', why: 'commented' });
    expect(turn({ myReview: mine('DISMISSED', true) })).toEqual({ turn: 'author', why: 'dismissed' });
  });

  test('done: you approved, or only your team is asked and it is approved', () => {
    expect(turn({ myReview: mine('APPROVED', false) })).toEqual({ turn: 'done', why: 'approved' });
    expect(turn({ requested: 'team', decision: 'APPROVED' })).toEqual({ turn: 'done', why: 'enough' });
    expect(turn({ requested: 'team', myReview: mine('APPROVED', true) })).toEqual({ turn: 'done', why: 'approved' });
  });

  test('findings waiting on the current head make it yours; published or older ones do not', () => {
    expect(turn({ myReview: mine('APPROVED', true), runs: [run(true, 2)] })).toEqual({ turn: 'me', why: 'findings' });
    expect(turn({ myReview: mine('APPROVED', true), runs: [run(true, 2, 1)] })?.turn).toBe('done');
    expect(turn({ myReview: mine('APPROVED', false), runs: [run(false, 2)] })?.turn).toBe('done');
  });

  test('a running review wins; nothing to show without a request or a review', () => {
    const job = { state: 'running' } as InboxJob;
    expect(turn({ myReview: mine('APPROVED', true), job })).toEqual({ turn: 'sieve', why: 'job' });
    expect(turn({})).toBeNull();
  });
});

describe('applyInboxState', () => {
  const prs = [
    { url: 'a', headSha: 'h1' },
    { url: 'b', headSha: 'h2' },
    { url: 'c', headSha: 'h3' },
    { url: 'd', headSha: 'h4' },
  ];
  test('snoozed until the head moves', () => {
    const r = applyInboxState(prs, { snoozed: { a: 'h1', b: 'old' } });
    expect(r.shown.map((p) => p.url)).toEqual(['b', 'c', 'd']);
    expect(r.snoozed).toEqual(['a']);
    expect(r.expired).toEqual(['b']);
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
              timelineItems: {
                nodes: [
                  { createdAt: '2026-01-02T00:00:00Z', requestedReviewer: { __typename: 'User', login: 'me' } },
                  { createdAt: '2026-01-03T00:00:00Z', requestedReviewer: { __typename: 'User', login: 'bob' } },
                  { createdAt: '2026-01-01T00:00:00Z', requestedReviewer: { __typename: 'User', login: 'me' } },
                ],
              },
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
    // your newest request; another reviewer's later one does not count
    expect(rows[0]!.requestedAt).toBe('2026-01-02T00:00:00Z');
    expect(rows[2]!.requestedAt).toBeUndefined();
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

  test('background agents: done and usage come with the task notification', () => {
    const job: InboxJob = { url: 'u', state: 'running', phase: 'prepare', agents: [], queuedAt: '' };
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    job.startedAt = at(0);
    job.phaseAt = { prepare: at(0) };
    trackJob(
      job,
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Sieve: rules' } }] },
      },
      at(10),
    );
    trackJob(job, {
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: { status: 'async_launched' },
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'launched' }] },
    });
    expect(job.agents[0]!.done).toBe(false);
    trackJob(job, {
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 't1',
      usage: { total_tokens: 1200, tool_uses: 7, duration_ms: 30000 },
    });
    expect(job.agents[0]).toMatchObject({ done: true, usage: { tokens: 1200, toolUses: 7, durationMs: 30000 } });

    job.finishedAt = at(60);
    const u = runUsage(
      job,
      {
        total_cost_usd: 1.5,
        modelUsage: {
          a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
          b: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
        },
      },
      500,
    );
    expect(u).toEqual({
      durationMs: 60000,
      phases: { prepare: 10000, review: 50000 },
      orchestrator: 500,
      agents: [{ name: 'rules', phase: 'review', tokens: 1200, toolUses: 7, durationMs: 30000 }],
      total: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 },
      costUsd: 1.5,
    });
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
