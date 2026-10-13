import { Card } from '@/components/ui';
import { DEST_LABEL, type Stats, type TenantView } from '@/lib/types';
import { LinkButton } from './LinkButton';
import { salesHref, tabHref } from './links';

interface Item {
  tone: 'bad' | 'warn';
  text: string;
  label?: string;
  href?: string;
}

/**
 * Things that need a person right now, found from what the console already knows: a connection that stopped working,
 * sales that failed or were rejected after being accepted, and sending being held back. Gone when there is nothing to do.
 */
export function AttentionCard({ id, view, stats }: { id: string; view: TenantView; stats: Stats }) {
  const items: Item[] = [];
  for (const conn of view.connections) {
    if (conn.status !== 'error') continue;
    const name = DEST_LABEL[conn.kind] ?? conn.kind;
    items.push({ tone: 'bad', text: `${name} stopped accepting sales: ${(conn.lastError ?? 'unknown error').slice(0, 140)}`, label: 'Fix connection', href: tabHref(id, 'connections') });
  }
  for (const d of view.tenant.destinations) {
    const failed = stats.deliveries[d]?.failed ?? 0;
    const rejected = (stats.processing?.[d]?.rejected ?? 0) + (stats.processing?.[d]?.partial ?? 0);
    const name = DEST_LABEL[d] ?? d;
    const href = salesHref(id, { status: 'attention', dest: d });
    if (failed > 0) items.push({ tone: 'bad', text: `${failed} ${failed === 1 ? 'sale' : 'sales'} could not be sent to ${name}.`, label: 'Review', href });
    if (rejected > 0) items.push({ tone: 'bad', text: `${name} accepted ${rejected} ${rejected === 1 ? 'sale' : 'sales'} but then rejected ${rejected === 1 ? 'it' : 'them'}.`, label: 'Review', href });
  }
  if (view.sending && !view.sending.allowed) items.push({ tone: 'warn', text: view.sending.reason ?? 'Sending is switched off on this server.' });
  if (items.length === 0) return null;

  return (
    <Card className="p-5">
      <section aria-label="Needs attention">
        <h2 className="text-base font-semibold">{items.length === 1 ? 'Needs attention' : `Needs attention (${items.length})`}</h2>
        <ul className="mt-3 space-y-2">
          {items.map((i) => (
            <li key={i.text} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm ${i.tone === 'bad' ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn'}`}>
              <span>{i.text}</span>
              {i.href && <LinkButton href={i.href}>{i.label ?? 'Open'}</LinkButton>}
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}
