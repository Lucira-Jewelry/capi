'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Skeleton, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { CHANNEL_LABEL, DEST_LABEL, type SaleSummary } from '@/lib/types';
import { saleMatches, presetFromParams, STATUS_FILTERS, type SaleStatusFilter } from './sales/filters';
import { fmtDate, fmtMoney, relTime } from './sales/format';
import { ImportDialog } from './sales/ImportDialog';
import { SaleDialog } from './sales/SaleDialog';
import { StatusBadge } from './sales/StatusBadge';
import type { DispatchResult } from './sales/types';
import type { TabProps } from './types';

const LIMIT = 100;

export function Sales({ id, view, meta, reload }: TabProps) {
  const toast = useToast();
  // The Overview can open this tab on exactly the sales behind a count (?filter=…&dest=…); see presetFromParams.
  const preset = presetFromParams(useSearchParams());
  const [status, setStatus] = useState<SaleStatusFilter>(preset.status);
  const [dest, setDest] = useState(preset.dest);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<SaleSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [shownCount, setShownCount] = useState(25);

  const sales = useApi<{ sales: SaleSummary[] }>(`/tenants/${encodeURIComponent(id)}/sales?limit=${LIMIT}`);
  const all = sales.data?.sales ?? [];
  const dispatch = useAction();

  const sending = view.sending;
  const blocked = Boolean(sending && !sending.allowed);

  const sendNow = () =>
    dispatch.run(async () => {
      const r = await api<DispatchResult>('POST', `/tenants/${encodeURIComponent(id)}/dispatch`);
      toast(
        r.blocked && r.blockedReason && !r.considered
          ? r.blockedReason
          : r.suspended
            ? 'This brand is suspended: nothing was sent.'
            : r.considered === 0
              ? 'Nothing was waiting.'
              : `Sent ${r.sent}, will retry ${r.retried}, failed ${r.failed}${r.notConnected ? `, waiting for a connection: ${r.notConnected}` : ''}${r.withdrawn ? `, skipped because the customer withdrew consent: ${r.withdrawn}` : ''}.`,
      );
      await sales.reload();
    });

  const base = all.filter((s) => saleMatches(s, 'all', dest, query));
  const count = (st: SaleStatusFilter) => (st === 'all' ? base.length : all.filter((s) => saleMatches(s, st, dest, query)).length);
  const matching = all.filter((s) => saleMatches(s, status, dest, query));
  const shown = matching.slice(0, shownCount);
  const clear = () => {
    setStatus('all');
    setDest('');
    setQuery('');
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Recent sales</h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setImporting(true)}>Import sales</Button>
          <Button onClick={() => void sales.reload()} disabled={sales.loading}>Refresh</Button>
          <Button variant="primary" onClick={() => void sendNow()} disabled={blocked || dispatch.busy} title={blocked ? (sending?.reason ?? '') : sending?.destinations ? `This server only sends to: ${sending.destinations.join(', ')}.` : undefined}>
            Send waiting sales now
          </Button>
        </div>
      </div>

      {/* The server can be set not to send: say so, and do not offer the button. */}
      {blocked && <div role="status" className="rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">{sending?.reason ?? 'Sending is switched off on this server.'}</div>}
      {sales.error && <p role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">{sales.error}</p>}
      {sales.loading && !sales.data && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>}

      {sales.data && all.length === 0 && (
        <Card className="p-8 text-center">
          <h3 className="font-semibold">No sales yet</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">Sales appear here when your CRM reports a won deal. If some are missing from the CRM, you can import them from a file.</p>
          <Button variant="primary" className="mt-4" onClick={() => setImporting(true)}>Import sales</Button>
        </Card>
      )}

      {all.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Filter sales by what happened" className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5">
                {STATUS_FILTERS.map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={status === key} onClick={() => { setStatus(key); setShownCount(25); }} className={`rounded-md px-3 py-1 text-sm ${status === key ? 'bg-accent text-accent-contrast' : 'text-muted hover:text-text'}`}>
                    {label} <span className="tabular-nums opacity-70">{count(key)}</span>
                  </button>
                ))}
              </div>
              {dest && (
                <button type="button" title="Show all platforms" onClick={() => setDest('')} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-sm hover:opacity-80">
                  Only {DEST_LABEL[dest] ?? dest} <span aria-hidden>✕</span>
                </button>
              )}
            </div>
            <input type="search" aria-label="Search sales" placeholder="Search sale ID or store" autoComplete="off" spellCheck={false} value={query} onChange={(e) => { setQuery(e.target.value); setShownCount(25); }} className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm sm:w-64" />
          </div>

          {matching.length === 0 ? (
            <Card className="p-8 text-center">
              <h3 className="font-semibold">No sales match</h3>
              <p className="mt-1 text-sm text-muted">Nothing fits the filters you chose.</p>
              <Button className="mt-4" onClick={clear}>Clear filters</Button>
            </Card>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    {['Sale date', 'Sale', 'Channel', 'Value', 'Website visit', 'Sent to', ''].map((t) => (
                      <th key={t} scope="col" className={`px-4 py-2.5 font-medium ${t === 'Value' ? 'text-right' : ''}`}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => {
                    const ds = dest ? s.deliveries.filter((d) => d.destination === dest) : s.deliveries;
                    return (
                      <tr key={s.saleKey} className="border-b border-border last:border-0">
                        <td className="whitespace-nowrap px-4 py-3 text-xs"><time dateTime={new Date(s.sale.occurredAt).toISOString()} title={fmtDate(s.sale.occurredAt)}>{relTime(s.sale.occurredAt)}</time></td>
                        <td className="px-4 py-3"><div className="font-mono text-xs">{s.sale.eventId}</div>{s.sale.storeName && <div className="text-xs text-muted">{s.sale.storeName}</div>}</td>
                        <td className="px-4 py-3">{CHANNEL_LABEL[s.sale.channel] ?? s.sale.channel}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(s.sale.value, s.sale.currency)}</td>
                        <td className="px-4 py-3">{s.sale.personId ? <Badge tone="ok">linked</Badge> : <Badge>not linked</Badge>}</td>
                        <td className="px-4 py-3">
                          <div className="space-y-1">
                            {ds.map((d) => (
                              <div key={d.destination} className="flex items-center gap-2"><span className="text-xs">{DEST_LABEL[d.destination] ?? d.destination}</span><StatusBadge status={d.status} /></div>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right"><button type="button" className="text-xs text-accent underline" onClick={() => setOpen(s)}>Details</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
          {matching.length > shown.length && (
            <div className="flex justify-center"><Button onClick={() => setShownCount((n) => n + 25)}>Show more ({matching.length - shown.length} left)</Button></div>
          )}
          {all.length >= LIMIT && <p className="text-xs text-muted">Showing the latest {LIMIT} sales.</p>}
        </>
      )}

      {open && <SaleDialog tenantId={id} sale={open} onClose={() => setOpen(null)} onChanged={async () => { await sales.reload(); }} />}
      {importing && (
        <ImportDialog
          tenantId={id}
          columns={meta.importColumns}
          template={meta.importTemplate}
          optIn={view.tenant.consentPolicy.mode === 'opt_in'}
          onClose={() => setImporting(false)}
          onImported={() => { void reload(); void sales.reload(); }}
        />
      )}
    </div>
  );
}
