// Display formatting. Pure, no DOM access.

/** Group digits so sat amounts are readable: 12345 -> "12,345". */
export function formatSats(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  return Number(n).toLocaleString('en-US');
}

/** sat/vB with one decimal, none from 100 up. */
export function formatRate(r: number | null | undefined): string {
  if (r === null || r === undefined || Number.isNaN(r)) return '–';
  return r >= 100 ? r.toFixed(0) : r.toFixed(1);
}

/** "just now", "4 min", "2 h 5 min", "3 d". */
export function formatAge(secs: number): string {
  if (secs < 60) return secs < 5 ? 'just now' : `${secs} s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Shorten a txid or id for display: first 10 and last 8 characters. */
export function shortId(id: string | null | undefined): string {
  return id && id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id || '';
}

export function isTxid(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}
