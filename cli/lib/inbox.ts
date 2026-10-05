/**
 * Inbox: open PRs waiting for your review (GitHub search) joined with the Sieve runs found on disk.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  Finding,
  FindingStatus,
  InboxBucket,
  InboxPr,
  InboxRun,
  InboxSettings,
  RunMeta,
  RunState,
  Severity,
} from '../../shared/types.ts';
import { SEVERITIES } from '../../shared/types.ts';
import { paths, readJson, writeJson } from './run.ts';
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

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft createdAt updatedAt additions deletions changedFiles
    headRefOid headRefName baseRefName reviewDecision mergeable
    author { login }
    repository { name owner { login } }
    labels(first: 8) { nodes { name color } }
    reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } } }
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
export function parsePrs(data: any, viewer: string): Omit<InboxPr, 'runs' | 'bucket' | 'checkout'>[] {
  const me = viewer.toLowerCase();
  const out = new Map<string, Omit<InboxPr, 'runs' | 'bucket' | 'checkout'>>();
  const rows = [
    ...(data.requested?.nodes || []).map((n: any) => [n, true] as const),
    ...(data.reviewed?.nodes || []).map((n: any) => [n, false] as const),
  ];
  for (const [n, requested] of rows) {
    if (!n?.url || out.has(n.url)) continue;
    const reqs = (n.reviewRequests?.nodes || []).map((r: any) => r.requestedReviewer).filter(Boolean);
    const direct = reqs.some((r: any) => r.__typename === 'User' && r.login?.toLowerCase() === me);
    const teams = reqs.filter((r: any) => r.__typename === 'Team').map((r: any) => `${r.organization.login}/${r.slug}`);

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
      teams,
      decision: n.reviewDecision || null,
      approvals: states.filter((s) => s === 'APPROVED').length,
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

/** Runs of one PR in every place Sieve may have put them, newest first. */
export function localRuns(pr: Pick<InboxPr, 'owner' | 'repo' | 'number' | 'headSha'>, checkout?: string): InboxRun[] {
  const roots = new Set([checkout, join(SIEVE_HOME, 'repos', pr.owner, pr.repo)].filter(Boolean) as string[]);
  const out: InboxRun[] = [];
  for (const root of roots) {
    const dir = join(root, '.sieve', 'runs', key(pr.owner, pr.repo).replace('/', '-'));
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir)) {
      if (!id.startsWith(`pr${pr.number}-`)) continue;
      const r = summarizeRun(join(dir, id), pr.headSha);
      if (r) out.push(r);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Which group of the inbox a PR belongs to. */
export function bucketOf(pr: Pick<InboxPr, 'requested' | 'runs' | 'job'>): InboxBucket {
  if (pr.job && (pr.job.state === 'queued' || pr.job.state === 'running')) return 'reviewing';
  if (!pr.requested) return 'reviewed';
  const cur = pr.runs.find((r) => r.onHead);
  if (!cur) return 'new';
  if (cur.reviews.length || (cur.status.open === 0 && cur.unpublished === 0)) return 'done';
  return 'triage';
}
