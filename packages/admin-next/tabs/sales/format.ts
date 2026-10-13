export function fmtDate(v: string | Date | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtMoney(value: number | undefined, currency = 'INR'): string {
  if (value === undefined) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** "3 hours ago" for the table; the full date goes in the tooltip. */
export function relTime(v: string | Date, now = Date.now()): string {
  const d = new Date(v).getTime();
  if (Number.isNaN(d)) return '';
  const sec = Math.round((d - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, s] of steps) if (Math.abs(sec) >= s) return rtf.format(Math.round(sec / s), unit);
  return rtf.format(sec, 'second');
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
