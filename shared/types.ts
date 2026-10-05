// Types shared by the CLI, the server and the UI.

export type Severity = 'critical' | 'major' | 'minor' | 'nit';

export const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'nit'];

/** A finding as returned by a reviewer agent. */
export interface RawFinding {
  file: string;
  line: number;
  endLine?: number;
  severity: Severity;
  /** e.g. "bug", "rules", "security", "performance", "history" */
  category: string;
  /** The project rule that is violated, if any. */
  rule?: { path: string; quote: string };
  title: string;
  explanation: string;
  /** Proposed fix (prose or code). */
  suggestion?: string;
  /** 0..1 — the reviewer's own confidence. */
  confidence?: number;
  /** Filled by the orchestrator when it merges duplicates. */
  reviewers?: string[];
}

export interface Validation {
  verdict: 'valid' | 'invalid' | 'skipped';
  confidence?: number;
  reason?: string;
}

export interface Finding extends RawFinding {
  id: string;
  reviewers: string[];
  /** true when GitHub accepts an inline comment for this location. */
  inDiff: boolean;
  /** Where an inline comment will be anchored (RIGHT side, new-file line numbers). */
  anchor: { line: number; startLine?: number } | null;
  validation: Validation;
  /** true when validation rejected it — shown in a separate tab. */
  filtered: boolean;
}

export interface RunMeta {
  id: string;
  mode: 'pr' | 'local';
  createdAt: string;
  repoRoot: string;
  /** Directory the agents read code from (PR worktree or repo root). */
  worktree: string;
  runDir: string;
  title: string;
  body: string;
  author?: string;
  url?: string;
  owner?: string;
  repo?: string;
  number?: number;
  state?: string;
  isDraft?: boolean;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  /** Settings passed as CLI flags for this run (e.g. --lang ru). */
  overrides?: Partial<Settings>;
}

export interface RuleFile {
  path: string;
  /** Directory the rule applies to ("" = whole repo). */
  scope: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  kind?: 'chat' | 'comment';
}

export type FindingStatus = 'open' | 'accepted' | 'rejected';

export interface FindingState {
  status: FindingStatus;
  comment?: string;
  rejectReason?: string;
  sessionId?: string;
  messages: ChatMessage[];
  published?: { at: string; url?: string };
}

/** A chat thread that is not tied to a finding (e.g. a map node: `map:<flowId>:<nodeId>`). */
export interface ChatThread {
  sessionId?: string;
  messages: ChatMessage[];
}

export interface RunState {
  findings: Record<string, FindingState>;
  threads?: Record<string, ChatThread>;
  settings?: { reportLanguage?: string; commentLanguage?: string };
  reviews?: { at: string; url?: string; count: number }[];
}

export interface ReviewerSettings {
  enabled?: boolean;
  model?: 'haiku' | 'sonnet' | 'opus' | string;
}

export interface Settings {
  /** Language of findings, explanations and the chat. */
  reportLanguage: string;
  /** Language of comments published to the PR. */
  commentLanguage: string;
  /** Extra instructions for the tone/format of published comments. */
  commentStyle: string;
  /** Glob patterns (relative to repo root) of files that contain review rules. */
  rules: string[];
  /** Enable/disable or re-model reviewers by name. */
  reviewers: Record<string, ReviewerSettings>;
  validation: { enabled: boolean; model: string; minConfidence: number };
  /** Reviewer findings below this severity are dropped. */
  minSeverity: Severity;
  chat: { model: string; tools: string[] };
  server: { port: number; open: boolean };
  /** PR map ("how it works" tab): when to build it and with which model. */
  map: { mode: 'on-demand' | 'always' | 'off'; model: string };
  /** Glob patterns of files to exclude from review (lockfiles, generated code…). */
  ignore: string[];
  /** PRs waiting for your review, across repos. Read from ~/.sieve/settings.json only. */
  inbox: InboxSettings;
}

export interface InboxSettings {
  enabled: boolean;
  /** Fixed port of the inbox page, so it can be bookmarked. */
  port: number;
  /** "me" = requested from you personally; "me-or-team" = also via a team you are in. */
  requested: 'me' | 'me-or-team';
  /** "owner/repo"; empty = all repos. */
  repos: string[];
  /** Users / orgs; empty = all. */
  owners: string[];
  excludeRepos: string[];
  includeDrafts: boolean;
  /** Also list open PRs you reviewed before that no longer request you. */
  showReviewed: boolean;
  /** "owner/repo" → local checkout to run reviews from (its rules, gitignored ones included). */
  checkouts: Record<string, string>;
}

// ───────────── Inbox ─────────────

export type InboxBucket = 'reviewing' | 'new' | 'triage' | 'done' | 'reviewed';

/** A Sieve run of one PR found on disk. */
export interface InboxRun {
  runDir: string;
  headSha: string;
  createdAt: string;
  /** Run is on the PR's current head. */
  onHead: boolean;
  /** Not filtered out by validation, by severity. */
  findings: Record<Severity, number>;
  filtered: number;
  status: Record<FindingStatus, number>;
  /** Accepted, with a comment, not published yet. */
  unpublished: number;
  reviews: { at: string; url?: string; count: number }[];
  map: boolean;
  /** URL of its UI server when one is running. */
  url?: string;
}

export interface InboxAgent {
  id: string;
  name: string;
  phase: 'review' | 'validate' | 'map';
  done: boolean;
}

export interface InboxJob {
  url: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  phase: 'queued' | 'prepare' | 'review' | 'validate' | 'finalize' | 'done';
  agents: InboxAgent[];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  runDir?: string;
  log?: string;
}

export interface InboxPr {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: { name: string; color: string }[];
  /** Why it is in the inbox: requested from you, from your team, or you reviewed it before. */
  requested: 'me' | 'team' | null;
  teams: string[];
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  approvals: number;
  changesRequested: number;
  myReview?: { state: string; at: string; sha?: string; onHead: boolean };
  ci: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  threads: { total: number; unresolved: number };
  comments: number;
  /** Local checkout reviews run from (otherwise a clone in ~/.sieve/repos). */
  checkout?: string;
  /** Newest first. */
  runs: InboxRun[];
  job?: InboxJob;
  bucket: InboxBucket;
}

export interface InboxData {
  enabled: boolean;
  viewer?: string;
  query?: string;
  fetchedAt?: string;
  error?: string;
  reportLanguage: string;
  commentLanguage: string;
  prs: InboxPr[];
}

export interface ParsedDiffLine {
  type: 'add' | 'del' | 'ctx';
  old?: number;
  new?: number;
  text: string;
}

export interface ParsedHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ParsedDiffLine[];
}

export interface ParsedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  hunks: ParsedHunk[];
}

// ───────────── PR map ─────────────

export type MapNodeKind =
  'entry' | 'component' | 'composable' | 'store' | 'service' | 'api' | 'router' | 'util' | 'external' | 'other';

export const MAP_NODE_KINDS: MapNodeKind[] = [
  'entry',
  'component',
  'composable',
  'store',
  'service',
  'api',
  'router',
  'util',
  'external',
  'other',
];

export type MapChange = 'added' | 'modified' | 'removed' | 'unchanged';

export interface MapNode {
  /** Unique within its flow. */
  id: string;
  kind: MapNodeKind;
  /** "ProductCard → click 'Add to cart'", "useCart().addItem" */
  label: string;
  /** Path relative to the repo root. */
  file?: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  /** What happens at this step, 1–2 sentences. */
  summary: string;
  change: MapChange;
  /** What the PR changed here (when change != unchanged). */
  changeSummary?: string;
  /** Filled by the server when the map is served; agents never write it. */
  findingIds?: string[];
}

export type MapEdgeKind = 'call' | 'event' | 'data' | 'async' | 'navigation';

export interface MapEdge {
  from: string;
  to: string;
  /** "emit('add')", "await addToCart mutation" */
  label?: string;
  kind?: MapEdgeKind;
}

export interface MapFlow {
  /** slug */
  id: string;
  title: string;
  description: string;
  /** What starts the flow. */
  trigger: string;
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface PrMap {
  version: 1;
  createdAt: string;
  model: string;
  overview: {
    /** 2–4 sentences: what the PR does and why. */
    summary: string;
    /** "Cart UI", "Cart store", "GraphQL: cart mutations" */
    areas: string[];
    /** 0–5 short architectural risks (not line-level bugs). */
    risks: string[];
  };
  flows: MapFlow[];
}

export type MapStatus =
  | { state: 'none' }
  | { state: 'building'; startedAt: string; progress?: string }
  | { state: 'ready'; map: PrMap }
  | { state: 'error'; error: string };
