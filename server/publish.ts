import type { Finding, RunMeta, RunState } from '../shared/types.ts';
import { sh } from '../cli/lib/sh.ts';

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

export interface ReviewPlan {
  payload: {
    commit_id: string;
    event: ReviewEvent;
    body: string;
    comments: { path: string; line: number; side: 'RIGHT'; start_line?: number; start_side?: 'RIGHT'; body: string }[];
  };
  ids: string[];
  inline: number;
  general: number;
}

export function lineLink(meta: RunMeta, f: Finding): string {
  const a = f.line;
  const b = f.endLine || f.line;
  const range = b > a ? `L${a}-L${b}` : `L${a}`;
  return `https://github.com/${meta.owner}/${meta.repo}/blob/${meta.headSha}/${f.file}#${range}`;
}

/** Accepted findings with a comment that were not published yet. */
export function publishable(findings: Finding[], state: RunState): Finding[] {
  return findings.filter((f) => {
    const s = state.findings[f.id];
    return s && s.status === 'accepted' && s.comment?.trim() && !s.published;
  });
}

export function buildReview(
  meta: RunMeta,
  findings: Finding[],
  state: RunState,
  opts: { summary?: string; event?: ReviewEvent; allGeneral?: boolean } = {},
): ReviewPlan {
  const items = publishable(findings, state);
  const comments: ReviewPlan['payload']['comments'] = [];
  const general: string[] = [];

  for (const f of items) {
    const body = state.findings[f.id]!.comment!.trim();
    if (f.anchor && !opts.allGeneral) {
      const c: ReviewPlan['payload']['comments'][number] = { path: f.file, line: f.anchor.line, side: 'RIGHT', body };
      if (f.anchor.startLine && f.anchor.startLine < f.anchor.line) {
        c.start_line = f.anchor.startLine;
        c.start_side = 'RIGHT';
      }
      comments.push(c);
    } else {
      // Suggestion blocks only work inline.
      const clean = body.replace(/```suggestion[\s\S]*?```/g, '').trim();
      general.push(`**[\`${f.file}:${f.line}\`](${lineLink(meta, f)})**\n\n${clean}`);
    }
  }

  const parts = [opts.summary?.trim(), ...general].filter(Boolean) as string[];
  return {
    payload: {
      commit_id: meta.headSha,
      event: opts.event || 'COMMENT',
      body: parts.join('\n\n---\n\n'),
      comments,
    },
    ids: items.map((f) => f.id),
    inline: comments.length,
    general: general.length,
  };
}

export function postReview(
  meta: RunMeta,
  plan: ReviewPlan,
): { ok: true; url?: string } | { ok: false; error: string; status?: number } {
  if (!plan.payload.comments.length && !plan.payload.body && plan.payload.event === 'COMMENT') {
    return { ok: false, error: 'Nothing to publish.' };
  }
  const r = sh(
    ['gh', 'api', '-X', 'POST', `repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/reviews`, '--input', '-'],
    { input: JSON.stringify(plan.payload) },
  );
  if (!r.ok) {
    let msg = r.stderr.trim() || r.stdout.trim();
    try {
      const j = JSON.parse(r.stdout);
      msg = [j.message, ...(j.errors || []).map((e: unknown) => (typeof e === 'string' ? e : JSON.stringify(e)))].join(
        ' — ',
      );
    } catch {}
    const status = Number((r.stderr.match(/HTTP (\d{3})/) || [])[1]) || undefined;
    return { ok: false, error: msg, status };
  }
  try {
    const j = JSON.parse(r.stdout);
    return { ok: true, url: j.html_url };
  } catch {
    return { ok: true };
  }
}

/** Markdown export for local runs (or to paste somewhere by hand). */
export function exportMarkdown(meta: RunMeta, findings: Finding[], state: RunState): string {
  const items = findings.filter((f) => state.findings[f.id]?.status === 'accepted' && state.findings[f.id]?.comment);
  const lines = [`# ${meta.title}`, ''];
  for (const f of items) {
    lines.push(
      `### \`${f.file}:${f.line}${f.endLine ? `-${f.endLine}` : ''}\``,
      '',
      state.findings[f.id]!.comment!.trim(),
      '',
    );
  }
  return lines.join('\n');
}
