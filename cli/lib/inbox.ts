/**
 * Inbox: open PRs waiting for your review (GitHub search) joined with the Sieve runs found on disk.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  Finding,
  FindingStatus,
  InboxPr,
  InboxRun,
  InboxSettings,
  InboxTurn,
  InboxWhy,
  RunMeta,
  RunState,
  Severity,
} from '../../shared/types.ts';
import { SEVERITIES } from '../../shared/types.ts';
import { paths, readJson, repoRunsDir, writeJson } from './run.ts';
import { loadSettings, SIEVE_HOME } from './settings.ts';

/** Global settings only: the inbox spans repos, a repo's settings must not change it. */
export function inboxSettings() {
  const s = loadSettings();
  if (process.env.SIEVE_INBOX_FORCE) s.inbox.enabled = true; // `bun run dev`
  return s;
}

const CHECKOUTS = () => join(SIEVE_HOME, 'checkouts.json');
const key = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** Remember where a repo is checked out locally, so the inbox finds its runs and reviews from there. */
export function rememberCheckout(owner: string, repo: string, root: string) {
  const all = readJson<Record<string, string>>(CHECKOUTS(), {});
  if (all[key(owner, repo)] === root) return;
  all[key(owner, repo)] = root;
  writeJson(CHECKOUTS(), all);
}

/** Local checkout for owner/repo: settings first, then the ones Sieve has seen. */
export function checkoutOf(s: InboxSettings, owner: string, repo: string): string | undefined {
  const k = key(owner, repo);
  const set = Object.entries(s.checkouts).find(([r]) => r.toLowerCase() === k)?.[1];
  const dir = set
    ? resolve(set.replace(/^~(?=$|\/)/, homedir()))
    : readJson<Record<string, string>>(CHECKOUTS(), {})[k];
  return dir && existsSync(join(dir, '.git')) ? dir : undefined;
}

// ───────────── GitHub ─────────────

/** Search query (without the "why it is here" qualifier) shared by both searches. */
export function scopeQuery(s: InboxSettings): string {
  return [
    'is:pr is:open archived:false',
    s.includeDrafts ? '' : 'draft:false',
    ...s.repos.map((r) => `repo:${r}`),
    ...s.owners.map((o) => `user:${o}`),
    ...s.excludeRepos.map((r) => `-repo:${r}`),
  ]
    .filter(Boolean)
    .join(' ');
}

const REVIEWER = '__typename ... on User { login } ... on Team { slug organization { login } }';
const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft createdAt updatedAt additions deletions changedFiles
    headRefOid headRefName baseRefName reviewDecision mergeable
    author { login }
    repository { name owner { login } }
    labels(first: 8) { nodes { name color } }
    reviewRequests(first: 30) { nodes { requestedReviewer { ${REVIEWER} } } }
    timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ${REVIEWER} } } } }
    reviews(last: 50) { nodes { author { login } state submittedAt commit { oid } } }
    reviewThreads(first: 100) { nodes { isResolved } }
    comments { totalCount }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`;

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped GraphQL response */
export function inboxQuery(s: InboxSettings): { query: string; requested: string; reviewed: string } {
  const scope = scopeQuery(s);
  const requested = `${scope} ${s.requested === 'me' ? 'user-review-requested:@me' : 'review-requested:@me'}`;
  const reviewed = `${scope} reviewed-by:@me -author:@me`;
  const search = (alias: string, q: string) =>
    `${alias}: search(query: ${JSON.stringify(q)}, type: ISSUE, first: 50) { nodes { ${PR_FIELDS} } }`;
  const query = `query { viewer { login } ${search('requested', requested)} ${
    s.showReviewed ? search('reviewed', reviewed) : ''
  } }`;
  return { query, requested, reviewed };
}

/** Turn the GraphQL answer into inbox rows (without local state yet). */
export function parsePrs(data: any, viewer: string): Omit<InboxPr, 'runs' | 'turn' | 'why' | 'checkout'>[] {
  const me = viewer.toLowerCase();
  const out = new Map<string, Omit<InboxPr, 'runs' | 'turn' | 'why' | 'checkout'>>();
  const rows = [
    ...(data.requested?.nodes || []).map((n: any) => [n, true] as const),
    ...(data.reviewed?.nodes || []).map((n: any) => [n, false] as const),
  ];
  for (const [n, requested] of rows) {
    if (!n?.url || out.has(n.url)) continue;
    const reqs = (n.reviewRequests?.nodes || []).map((r: any) => r.requestedReviewer).filter(Boolean);
    const direct = reqs.some((r: any) => r.__typename === 'User' && r.login?.toLowerCase() === me);
    const teams = reqs.filter((r: any) => r.__typename === 'Team').map((r: any) => `${r.organization.login}/${r.slug}`);
    const isOurs = (r: any) =>
      r?.__typename === 'User'
        ? r.login?.toLowerCase() === me
        : r?.__typename === 'Team' && teams.includes(`${r.organization?.login}/${r.slug}`);
    // The newest request still standing (you or one of your requested teams): how long it waits for you.
    const requestedAt: string | undefined = (n.timelineItems?.nodes || [])
      .filter((e: any) => e?.createdAt && isOurs(e.requestedReviewer))
      .map((e: any) => e.createdAt as string)
      .sort()
      .at(-1);

    // Latest opinion per reviewer (a later COMMENTED does not cancel an approval).
    const latest = new Map<string, { state: string; at: string; sha?: string }>();
    let mine: { state: string; at: string; sha?: string } | undefined;
    for (const r of n.reviews?.nodes || []) {
      const login = r.author?.login?.toLowerCase();
      if (!login || r.state === 'PENDING') continue;
      const rv = { state: r.state, at: r.submittedAt, sha: r.commit?.oid };
      if (login === me) mine = rv;
      else if (r.state !== 'COMMENTED') latest.set(login, rv);
    }
    const states = [...latest.values()].map((r) => r.state);
    const threads = n.reviewThreads?.nodes || [];

    out.set(n.url, {
      url: n.url,
      owner: n.repository.owner.login,
      repo: n.repository.name,
      number: n.number,
      title: n.title,
      author: n.author?.login || 'ghost',
      isDraft: !!n.isDraft,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      headSha: n.headRefOid,
      headRef: n.headRefName,
      baseRef: n.baseRefName,
      additions: n.additions,
      deletions: n.deletions,
      changedFiles: n.changedFiles,
      labels: (n.labels?.nodes || []).map((l: any) => ({ name: l.name, color: l.color })),
      requested: !requested ? null : direct ? 'me' : 'team',
      ...(requested && requestedAt ? { requestedAt } : {}),
      teams,
      decision: n.reviewDecision || null,
      // An approval given before newer commits does not count: those commits were not approved.
      approvals: [...latest.values()].filter((r) => r.state === 'APPROVED' && r.sha === n.headRefOid).length,
      changesRequested: states.filter((s) => s === 'CHANGES_REQUESTED').length,
      myReview: mine && { ...mine, onHead: mine.sha === n.headRefOid },
      ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
      mergeable: n.mergeable || 'UNKNOWN',
      threads: { total: threads.length, unresolved: threads.filter((t: any) => !t.isResolved).length },
      comments: n.comments?.totalCount || 0,
    });
  }
  return [...out.values()];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchInbox(s: InboxSettings) {
  const q = inboxQuery(s);
  const proc = Bun.spawn(['gh', 'api', 'graphql', '-f', `query=${q.query}`], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // GraphQL can answer with partial data + errors (e.g. an org behind SSO): keep the data.
  const json = stdout.trim() ? JSON.parse(stdout) : {};
  if (!json.data) throw new Error((json.errors?.[0]?.message || stderr || `gh exited with code ${code}`).trim());
  const viewer: string = json.data.viewer.login;
  return { viewer, query: q.requested, prs: parsePrs(json.data, viewer), warning: json.errors?.[0]?.message };
}

// ───────────── Local runs ─────────────

function pidAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function summarizeRun(runDir: string, headSha: string): InboxRun | null {
  const p = paths(runDir);
  if (!existsSync(p.findings)) return null; // not finalized (still running, or failed)
  const meta = readJson<RunMeta>(p.meta);
  const findings = readJson<Finding[]>(p.findings, []);
  const state = readJson<RunState>(p.state, { findings: {} });
  const server = readJson<{ url?: string; pid?: number }>(p.server, {});
  const bySev = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const status: Record<FindingStatus, number> = { open: 0, accepted: 0, rejected: 0 };
  let unpublished = 0;
  for (const f of findings) {
    if (f.filtered) continue;
    bySev[f.severity]++;
    const st = state.findings[f.id];
    status[st?.status || 'open']++;
    if (st?.status === 'accepted' && st.comment?.trim() && !st.published) unpublished++;
  }
  return {
    runDir,
    headSha: meta.headSha,
    createdAt: meta.createdAt,
    onHead: meta.headSha === headSha,
    findings: bySev,
    filtered: findings.filter((f) => f.filtered).length,
    status,
    unpublished,
    reviews: state.reviews || [],
    map: existsSync(p.map),
    url: pidAlive(server.pid) ? server.url : undefined,
  };
}

/** Runs of one PR, newest first. */
export function localRuns(pr: Pick<InboxPr, 'owner' | 'repo' | 'number' | 'headSha'>): InboxRun[] {
  const dir = repoRunsDir(pr.owner, pr.repo);
  if (!existsSync(dir)) return [];
  const out: InboxRun[] = [];
  for (const id of readdirSync(dir)) {
    if (!id.startsWith(`pr${pr.number}-`)) continue;
    const r = summarizeRun(join(dir, id), pr.headSha);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Findings of the run on the current head still wait for you: to go through, or to publish. */
export function pendingRun(runs: InboxRun[]): InboxRun | undefined {
  return runs.find((r) => r.onHead && !r.reviews.length && (r.status.open > 0 || r.unpublished > 0));
}

/**
 * Whose turn it is, and why; null = not shown. The first rule that matches wins:
 * - Sieve: a review is queued or running.
 * - you: findings of a run on the current head wait for you; or a review is requested from you or your team
 *   right now (the first request, or the author asked again with "Re-request review").
 * - the author: your last review asks for changes or comments, or it was dismissed, and nobody asked you again —
 *   new commits alone do not make it your turn.
 * - done: you approved and nobody asked you again; or only your team is asked and the PR is approved already.
 */
export function turnOf(
  pr: Pick<InboxPr, 'requested' | 'myReview' | 'job' | 'runs' | 'decision' | 'approvals' | 'mergeable'>,
): { turn: InboxTurn; why: InboxWhy } | null {
  if (pr.job && (pr.job.state === 'queued' || pr.job.state === 'running')) return { turn: 'sieve', why: 'job' };
  // Conflicts first: the author's fix brings new commits, whatever else waits on this one.
  if (pr.mergeable === 'CONFLICTING' && (pr.requested || pr.myReview)) return { turn: 'author', why: 'conflicts' };
  if (pendingRun(pr.runs)) return { turn: 'me', why: 'findings' };
  // Still asked of you, but someone else approved: a group of its own, below your turn.
  const asked = pr.decision === 'APPROVED' || pr.approvals > 0 ? 'others' : 'me';
  if (pr.requested === 'me') return { turn: asked, why: pr.myReview ? 'rerequested' : 'requested' };
  // ponytail: a team request standing after your own review is taken as the old one (GitHub keeps it when a
  // member reviews); a team re-request looks the same. Track ReviewRequestedEvent times if that matters.
  if (pr.requested === 'team' && !pr.myReview) {
    return pr.decision === 'APPROVED' ? { turn: 'done', why: 'enough' } : { turn: asked, why: 'team' };
  }
  switch (pr.myReview?.state) {
    case 'APPROVED':
      return { turn: 'done', why: 'approved' };
    case 'CHANGES_REQUESTED':
      return { turn: 'author', why: 'changes' };
    case 'COMMENTED':
      return { turn: 'author', why: 'commented' };
    case 'DISMISSED':
      return { turn: 'author', why: 'dismissed' };
  }
  return null;
}

// ───────────── Snoozed ─────────────

const STATE = () => join(SIEVE_HOME, 'inbox-state.json');

/** PRs snoozed until the head moves: url → head sha at snooze time. */
export interface InboxState {
  snoozed: Record<string, string>;
}

export function loadInboxState(): InboxState {
  const s = readJson<Partial<InboxState>>(STATE(), {});
  return { snoozed: s.snoozed || {} };
}

export function saveInboxState(s: InboxState) {
  writeJson(STATE(), s);
}

/**
 * Split PRs into shown / snoozed. A snooze ends by itself when new commits arrive;
 * `expired` lists those, so the caller can drop them from the file.
 */
export function applyInboxState<T extends Pick<InboxPr, 'url' | 'headSha'>>(prs: T[], s: InboxState) {
  const shown: T[] = [];
  const snoozed: string[] = [];
  const expired: string[] = [];
  for (const p of prs) {
    if (s.snoozed[p.url] === p.headSha) snoozed.push(p.url);
    else {
      if (s.snoozed[p.url]) expired.push(p.url);
      shown.push(p);
    }
  }
  return { shown, snoozed, expired };
}
