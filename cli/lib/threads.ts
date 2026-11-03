/**
 * Comments already on the PR, so a review doesn't repeat what someone (or an earlier Sieve run) said.
 * The orchestrator reads them when it merges the reviewers' findings and marks the repeats.
 */
import type { PrComment } from '../../shared/types.ts';
import { sh } from './sh.ts';

const EXCERPT = 1500;

const QUERY = `query($owner: String!, $repo: String!, $n: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $n) {
      reviewThreads(first: 100) {
        nodes {
          isResolved path line originalLine
          comments(first: 10) { nodes { url body author { login } } }
        }
      }
      reviews(last: 50) { nodes { url body author { login } } }
      comments(last: 50) { nodes { url body author { login } } }
    }
  }
}`;

/** Every comment of a PR; [] when GitHub can't be asked (no gh, no network). */
export function fetchPrComments(owner: string, repo: string, n: number): PrComment[] {
  const r = sh([
    'gh',
    'api',
    'graphql',
    '-f',
    `query=${QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `repo=${repo}`,
    '-F',
    `n=${n}`,
  ]);
  if (!r.ok) return [];
  try {
    return parsePrComments(JSON.parse(r.stdout));
  } catch {
    return [];
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped GraphQL response */
export function parsePrComments(data: any): PrComment[] {
  const pr = data?.data?.repository?.pullRequest;
  if (!pr) return [];
  const out: PrComment[] = [];
  const text = (c: any) => ({ author: c.author?.login || 'ghost', body: String(c.body || '').slice(0, EXCERPT) });

  for (const t of pr.reviewThreads?.nodes || []) {
    const [first, ...replies] = t?.comments?.nodes || [];
    if (!first?.url) continue;
    out.push({
      url: first.url,
      ...text(first),
      // Outdated threads have no current line: their original one is still the best hint.
      file: t.path,
      line: t.line ?? t.originalLine ?? undefined,
      resolved: !!t.isResolved,
      replies: replies.map(text),
    });
  }
  // A review body and a PR conversation comment hold remarks outside the diff, e.g. a published Sieve review.
  for (const c of [...(pr.reviews?.nodes || []), ...(pr.comments?.nodes || [])]) {
    if (c?.url && String(c.body || '').trim()) out.push({ url: c.url, ...text(c) });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
