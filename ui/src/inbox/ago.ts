import type { InboxPr } from '../../../shared/types';
import { uiLang } from '../i18n';

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 days ago", "just now" — in the UI language. */
export function ago(iso: string, now = Date.now()): string {
  const s = (Date.parse(iso) - now) / 1000;
  const f = new Intl.RelativeTimeFormat(uiLang.value, { numeric: 'auto' });
  for (const [unit, sec] of STEPS) if (Math.abs(s) >= sec) return f.format(Math.round(s / sec), unit);
  return f.format(0, 'minute');
}

/** How long since `iso`, short: "2d", "5 ч". */
export function since(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  const [unit, sec]: [string, number] = s >= 86400 ? ['day', 86400] : s >= 3600 ? ['hour', 3600] : ['minute', 60];
  return new Intl.NumberFormat(uiLang.value, { style: 'unit', unit, unitDisplay: 'narrow' }).format(
    Math.max(1, Math.floor(s / sec)),
  );
}

/** How long something took, short: "45 s", "6 min", "1 h 5 min". */
export function dur(ms: number): string {
  const f = (n: number, unit: string) =>
    new Intl.NumberFormat(uiLang.value, { style: 'unit', unit, unitDisplay: 'short' }).format(n);
  const s = Math.round(ms / 1000);
  if (s < 60) return f(s, 'second');
  const m = Math.round(s / 60);
  return m < 60 ? f(m, 'minute') : `${f(Math.floor(m / 60), 'hour')} ${f(m % 60, 'minute')}`;
}

/** "174K", "93,4 млн" — token counts in the UI language. */
export const tok = (n: number) =>
  new Intl.NumberFormat(uiLang.value, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** "17 Nov, 14:12" in the UI language. */
export function when(iso: string): string {
  return new Date(iso).toLocaleString(uiLang.value, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Since when the PR waits on whoever's turn it is: you or the author. None while Sieve runs or once done. */
export function waitFrom(p: InboxPr): string | undefined {
  if (p.turn === 'author') return p.myReview?.at;
  if (p.turn !== 'me' && p.turn !== 'others') return undefined;
  if (p.why === 'findings') return p.runs.find((r) => r.onHead)?.createdAt;
  return p.requestedAt ?? p.createdAt;
}
