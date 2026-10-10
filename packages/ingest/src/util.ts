/** Read a field by name, or by dotted path ("Contact_Name.Mobile"). A flat key with dots wins (COQL style). */
export function getPath(record: unknown, path: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const obj = record as Record<string, unknown>;
  if (path in obj) return obj[path];
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object') return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

/** "85000", "85,000.50", "₹ 85,000", "Rs. 1,20,000" -> number. Returns null if nothing numeric. */
export function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = asString(v);
  if (!s) return null;
  // Drop thousands separators, then take the first number in the text so prefixes like "Rs." or "₹" are ignored.
  const match = /-?\d+(?:\.\d+)?/.exec(s.replace(/,/g, ''));
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is the date at the start of an ISO date/timestamp a real day? `new Date('2026-02-30')` quietly becomes 2 March, so
 * the calendar is checked on its own. Text that does not start with an ISO date is not judged here.
 */
export function hasRealCalendarDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return true;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Full timestamps are used as they are. Date-only values (Zoho Closing_Date) get a fixed time of day
 * in the given offset so the sale does not slip to the previous day in UTC.
 */
export function parseDate(v: unknown, dateOnlyOffset = '+05:30'): Date | null {
  const s = asString(v);
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00${dateOnlyOffset}` : s;
  if (!hasRealCalendarDay(iso)) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Copy of the record with the values at the given paths replaced, so logs hold no plain phone or email. */
export function redactRecord<T>(record: T, paths: string[]): T {
  const copy = JSON.parse(JSON.stringify(record ?? null)) as T;
  if (!copy || typeof copy !== 'object') return copy;
  for (const path of paths) {
    const obj = copy as Record<string, unknown>;
    if (path in obj) {
      obj[path] = '[redacted]';
      continue;
    }
    const parts = path.split('.');
    let cur: unknown = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[parts[i]!] : undefined;
    }
    const last = parts[parts.length - 1]!;
    if (cur && typeof cur === 'object' && last in (cur as Record<string, unknown>)) {
      (cur as Record<string, unknown>)[last] = '[redacted]';
    }
  }
  return copy;
}
