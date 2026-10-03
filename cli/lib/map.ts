/**
 * PR map ("how it works"): parse and normalize the cartographer's output, link review findings to nodes.
 * Pure functions shared by the CLI (`sieve map`) and the server (on-demand builds).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  Finding,
  MapChange,
  MapEdge,
  MapEdgeKind,
  MapFlow,
  MapNode,
  ParsedFile,
  PrMap,
  RunMeta,
  Settings,
} from '../../shared/types.ts';
import { MAP_NODE_KINDS } from '../../shared/types.ts';
import { parseJsonLoose } from './run.ts';

export const MAX_FLOWS = 6;
export const MAX_NODES = 20;
const MAX_RISKS = 5;
const CHANGES: MapChange[] = ['added', 'modified', 'removed', 'unchanged'];
const EDGE_KINDS: MapEdgeKind[] = ['call', 'event', 'data', 'async', 'navigation'];
/** Findings this close to a node's line range still belong to it. */
const LINK_SLACK = 3;

export function parseMapOutput(text: string): unknown {
  const raw = parseJsonLoose(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('map output is not a JSON object');
  return raw;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const int = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
};
/** Safe for URL hashes and thread keys (`map:<flow>:<node>`). */
const slug = (v: unknown) =>
  str(v)
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function unique(id: string, seen: Set<string>): string {
  let out = id;
  for (let i = 2; seen.has(out); i++) out = `${id}-${i}`;
  seen.add(out);
  return out;
}

/** Repo-relative path inside the worktree: a changed file or any existing file. */
function resolveFile(file: unknown, meta: RunMeta): string | undefined {
  let f = str(file).replace(/^\.\//, '');
  if (!f) return undefined;
  if (isAbsolute(f)) f = relative(meta.worktree, f);
  const abs = resolve(meta.worktree, f);
  if (abs !== meta.worktree && !abs.startsWith(meta.worktree + sep)) return undefined;
  f = relative(meta.worktree, abs);
  if (meta.changedFiles.includes(f)) return f;
  if (existsSync(abs) && statSync(abs).isFile()) return f;
  const bySuffix = meta.changedFiles.filter((c) => c.endsWith('/' + f));
  return bySuffix.length === 1 ? bySuffix[0] : undefined;
}

/** New-file line numbers added by the diff, per file. */
function addedLines(files: ParsedFile[]): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>();
  for (const f of files) {
    const s = new Set<number>();
    for (const h of f.hunks) for (const l of h.lines) if (l.type === 'add' && l.new !== undefined) s.add(l.new);
    m.set(f.path, s);
  }
  return m;
}

export function normalizeMap(raw: unknown, meta: RunMeta, files: ParsedFile[], settings: Settings): PrMap {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ov = (r.overview && typeof r.overview === 'object' ? r.overview : {}) as Record<string, unknown>;
  const added = addedLines(files);
  const lineCount = new Map<string, number>();
  const linesOf = (f: string) => {
    if (!lineCount.has(f)) {
      const abs = join(meta.worktree, f);
      lineCount.set(f, existsSync(abs) ? readFileSync(abs, 'utf8').split('\n').length : 0);
    }
    return lineCount.get(f)!;
  };

  const flowIds = new Set<string>();
  const flows: MapFlow[] = [];
  for (const [fi, rf] of (Array.isArray(r.flows) ? r.flows : []).entries()) {
    if (!rf || typeof rf !== 'object') continue;
    const fr = rf as Record<string, unknown>;
    const ids = new Set<string>();
    const nodes: MapNode[] = [];
    for (const [ni, rn] of (Array.isArray(fr.nodes) ? fr.nodes : []).entries()) {
      if (!rn || typeof rn !== 'object') continue;
      const n = rn as Record<string, unknown>;
      const node: MapNode = {
        id: unique(slug(n.id) || `n${ni + 1}`, ids),
        kind: MAP_NODE_KINDS.includes(n.kind as never) ? (n.kind as MapNode['kind']) : 'other',
        label: str(n.label) || str(n.symbol) || `#${ni + 1}`,
        summary: str(n.summary),
        change: CHANGES.includes(n.change as MapChange) ? (n.change as MapChange) : 'unchanged',
      };
      const file = resolveFile(n.file, meta);
      if (file) {
        node.file = file;
        const total = linesOf(file);
        const clamp = (x: number) => (total ? Math.min(x, total) : x);
        const line = int(n.line);
        if (line) {
          node.line = clamp(line);
          const end = int(n.endLine);
          if (end && clamp(end) > node.line) node.endLine = clamp(end);
        }
      }
      if (str(n.symbol)) node.symbol = str(n.symbol);
      // Trust the diff over the agent.
      const fileAdded = node.file ? added.get(node.file) : undefined;
      if (node.file && !fileAdded) node.change = 'unchanged';
      else if (node.change === 'unchanged' && fileAdded && node.line) {
        for (let x = node.line; x <= (node.endLine ?? node.line); x++)
          if (fileAdded.has(x)) {
            node.change = 'modified';
            break;
          }
      }
      if (node.change !== 'unchanged' && str(n.changeSummary)) node.changeSummary = str(n.changeSummary);
      nodes.push(node);
      if (nodes.length >= MAX_NODES) break;
    }
    if (!nodes.length) continue;

    // Duplicate ids were renamed above; an edge that names a duplicate points at the first one.
    const seenEdges = new Set<string>();
    const edges: MapEdge[] = [];
    for (const re of Array.isArray(fr.edges) ? fr.edges : []) {
      if (!re || typeof re !== 'object') continue;
      const e = re as Record<string, unknown>;
      const from = slug(e.from);
      const to = slug(e.to);
      if (from === to || !ids.has(from) || !ids.has(to) || seenEdges.has(`${from}>${to}`)) continue;
      seenEdges.add(`${from}>${to}`);
      const edge: MapEdge = { from, to };
      if (str(e.label)) edge.label = str(e.label);
      if (EDGE_KINDS.includes(e.kind as MapEdgeKind)) edge.kind = e.kind as MapEdgeKind;
      edges.push(edge);
    }

    flows.push({
      id: unique(slug(fr.id) || `flow-${fi + 1}`, flowIds),
      title: str(fr.title) || `Flow ${fi + 1}`,
      description: str(fr.description),
      trigger: str(fr.trigger),
      nodes,
      edges,
    });
  }

  // Flows that touch the change first (stable sort keeps the agent's order otherwise).
  const changed = (f: MapFlow) => f.nodes.some((n) => n.change !== 'unchanged');
  flows.sort((a, b) => Number(changed(b)) - Number(changed(a)));

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    model: settings.map.model,
    overview: {
      summary: str(ov.summary),
      areas: strList(ov.areas),
      risks: strList(ov.risks).slice(0, MAX_RISKS),
    },
    flows: flows.slice(0, MAX_FLOWS),
  };
}

/** A copy of the map with `findingIds` on the nodes each finding falls into. */
export function linkFindings(map: PrMap, findings: Finding[]): PrMap {
  const live = findings.filter((f) => !f.filtered);
  return {
    ...map,
    flows: map.flows.map((flow) => ({
      ...flow,
      nodes: flow.nodes.map((n) => {
        const { findingIds: _, ...node } = n;
        if (!n.file || !n.line) return node;
        const a = n.line - LINK_SLACK;
        const b = (n.endLine ?? n.line) + LINK_SLACK;
        const ids = live.filter((f) => f.file === n.file && (f.endLine ?? f.line) >= a && f.line <= b).map((f) => f.id);
        return ids.length ? { ...node, findingIds: ids } : node;
      }),
    })),
  };
}
