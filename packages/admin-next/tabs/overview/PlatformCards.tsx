import Link from 'next/link';
import { Card } from '@/components/ui';
import { DEST_LABEL, SKIP_LABEL, type Stats } from '@/lib/types';
import { salesHref, type SaleStatusFilter } from './links';

const TONE = { ok: 'bg-ok-bg text-ok', warn: 'bg-warn-bg text-warn', bad: 'bg-bad-bg text-bad', neutral: 'bg-surface-2 text-muted' } as const;

/** A count that opens the Sales tab showing exactly those sales. */
function ChipLink({ id, dest, status, tone, children }: { id: string; dest: string; status: SaleStatusFilter; tone: keyof typeof TONE; children: string }) {
  return (
    <Link href={salesHref(id, { status, dest })} title="Show these sales" className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium hover:opacity-80 ${TONE[tone]}`}>
      {children}
    </Link>
  );
}

/** What Google did with requests it accepted: processed, still processing, or rejected afterwards. */
function ProcessingChips({ p }: { p: Record<string, number> | undefined }) {
  if (!p) return null;
  const chips: Array<[string, keyof typeof TONE, string]> = [
    ['success', 'ok', 'processed'],
    ['processing', 'warn', 'being processed'],
    ['partial', 'bad', 'partly rejected'],
    ['rejected', 'bad', 'rejected'],
    ['unknown', 'neutral', 'no result'],
  ];
  const shown = chips.filter(([k]) => (p[k] ?? 0) > 0);
  if (shown.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted">Accepted by the platform:</span>
      {shown.map(([k, tone, label]) => <span key={k} className={`rounded-full px-2.5 py-0.5 font-medium ${TONE[tone]}`}>{`${p[k]} ${label}`}</span>)}
    </div>
  );
}

export function PlatformCard({ id, dest, stats }: { id: string; dest: string; stats: Stats }) {
  const by = stats.deliveries[dest] ?? {};
  const waiting = (by.pending ?? 0) + (by.sending ?? 0) + (by.retry ?? 0);
  return (
    <Card className="p-5">
      <h3 className="font-semibold">{DEST_LABEL[dest] ?? dest}</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <ChipLink id={id} dest={dest} status="sent" tone="ok">{`${by.sent ?? 0} sent`}</ChipLink>
        <ChipLink id={id} dest={dest} status="waiting" tone="warn">{`${waiting} waiting`}</ChipLink>
        <ChipLink id={id} dest={dest} status="attention" tone="bad">{`${by.failed ?? 0} failed`}</ChipLink>
        <ChipLink id={id} dest={dest} status="skipped" tone="neutral">{`${by.skipped ?? 0} skipped`}</ChipLink>
      </div>
      <ProcessingChips p={stats.processing?.[dest]} />
    </Card>
  );
}

export function SkipTable({ stats }: { stats: Stats }) {
  const rows = Object.entries(stats.skipReasons).flatMap(([dest, reasons]) => Object.entries(reasons).map(([reason, n]) => [dest, reason, n] as const));
  if (rows.length === 0) return <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">Nothing was skipped in this period.</p>;
  return (
    <Card className="overflow-x-auto p-5">
      <h3 className="font-semibold">Why sales were not sent</h3>
      <table className="mt-3 w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr>{['Destination', 'Reason', 'Sales'].map((x) => <th key={x} scope="col" className="py-1.5 pr-4 font-medium">{x}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(([d, r, n]) => (
            <tr key={`${d}-${r}`} className="border-t border-border">
              <td className="py-2 pr-4">{DEST_LABEL[d] ?? d}</td>
              <td className="py-2 pr-4">{SKIP_LABEL[r] ?? r}</td>
              <td className="py-2 tabular-nums">{n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
