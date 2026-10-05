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
