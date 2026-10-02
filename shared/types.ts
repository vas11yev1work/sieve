// Types shared by the CLI, the server and the UI.

export type Severity = 'critical' | 'major' | 'minor' | 'nit'

export const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'nit']

/** A finding as returned by a reviewer agent. */
export interface RawFinding {
  file: string
  line: number
  endLine?: number
  severity: Severity
  /** e.g. "bug", "rules", "security", "performance", "history" */
  category: string
  /** The project rule that is violated, if any. */
  rule?: { path: string; quote: string }
  title: string
  explanation: string
  /** Proposed fix (prose or code). */
  suggestion?: string
  /** 0..1 — the reviewer's own confidence. */
  confidence?: number
  /** Filled by the orchestrator when it merges duplicates. */
  reviewers?: string[]
}

export interface Validation {
  verdict: 'valid' | 'invalid' | 'skipped'
  confidence?: number
  reason?: string
}

export interface Finding extends RawFinding {
  id: string
  reviewers: string[]
  /** true when GitHub accepts an inline comment for this location. */
  inDiff: boolean
  /** Where an inline comment will be anchored (RIGHT side, new-file line numbers). */
  anchor: { line: number; startLine?: number } | null
  validation: Validation
  /** true when validation rejected it — shown in a separate tab. */
  filtered: boolean
}

export interface RunMeta {
  id: string
  mode: 'pr' | 'local'
  createdAt: string
  repoRoot: string
  /** Directory the agents read code from (PR worktree or repo root). */
  worktree: string
  runDir: string
  title: string
  body: string
  author?: string
  url?: string
  owner?: string
  repo?: string
  number?: number
  state?: string
  isDraft?: boolean
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  changedFiles: string[]
  /** Settings passed as CLI flags for this run (e.g. --lang ru). */
  overrides?: Partial<Settings>
}

export interface RuleFile {
  path: string
  /** Directory the rule applies to ("" = whole repo). */
  scope: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
  kind?: 'chat' | 'comment'
}

export type FindingStatus = 'open' | 'accepted' | 'rejected'

export interface FindingState {
  status: FindingStatus
  comment?: string
  rejectReason?: string
  sessionId?: string
  messages: ChatMessage[]
  published?: { at: string; url?: string }
}

export interface RunState {
  findings: Record<string, FindingState>
  settings?: { reportLanguage?: string; commentLanguage?: string }
  reviews?: { at: string; url?: string; count: number }[]
}

export interface ReviewerSettings {
  enabled?: boolean
  model?: 'haiku' | 'sonnet' | 'opus' | string
}

export interface Settings {
  /** Language of findings, explanations and the chat. */
  reportLanguage: string
  /** Language of comments published to the PR. */
  commentLanguage: string
  /** Extra instructions for the tone/format of published comments. */
  commentStyle: string
  /** Glob patterns (relative to repo root) of files that contain review rules. */
  rules: string[]
  /** Enable/disable or re-model reviewers by name. */
  reviewers: Record<string, ReviewerSettings>
  validation: { enabled: boolean; model: string; minConfidence: number }
  /** Reviewer findings below this severity are dropped. */
  minSeverity: Severity
  chat: { model: string; tools: string[] }
  server: { port: number; open: boolean }
  /** Glob patterns of files to exclude from review (lockfiles, generated code…). */
  ignore: string[]
}

export interface ParsedDiffLine {
  type: 'add' | 'del' | 'ctx'
  old?: number
  new?: number
  text: string
}

export interface ParsedHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ParsedDiffLine[]
}

export interface ParsedFile {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  binary: boolean
  hunks: ParsedHunk[]
}
