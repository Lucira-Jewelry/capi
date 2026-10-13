'use client';
import { useState } from 'react';
import { Button, ConfirmDialog, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { CHANNEL_LABEL, DEST_LABEL, SKIP_LABEL, type SaleSummary } from '@/lib/types';
import { fmtDate, fmtMoney } from './format';
import { StatusBadge } from './StatusBadge';
import type { DeliveryOf } from './filters';
import type { PreviewResult } from './types';

/** Everything about one sale: where it was sent, the full reasons, and Preview and Resend. */
export function SaleDialog({ tenantId, sale, onClose, onChanged }: { tenantId: string; sale: SaleSummary; onClose: () => void; onChanged: () => Promise<void> }) {
  const s = sale.sale;
  return (
    <Modal open title={`Sale ${s.eventId}`} onClose={onClose} wide>
      <p className="-mt-2 mb-4 text-sm text-muted">
        {CHANNEL_LABEL[s.channel] ?? s.channel} · {fmtMoney(s.value, s.currency)} · {fmtDate(s.occurredAt)} · {s.personId ? 'linked to an earlier website visit' : 'no website visit linked'}
      </p>
      <div className="space-y-3">
        {sale.deliveries.length === 0 && <p className="text-sm text-muted">Not queued for any platform.</p>}
        {sale.deliveries.map((d) => (
          <DeliveryRow
            key={d.destination}
            tenantId={tenantId}
            saleKey={sale.saleKey}
            d={d}
            onResent={async () => {
              onClose();
              await onChanged();
            }}
          />
        ))}
      </div>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

const PROCESSING: Record<string, [string, string]> = {
  processing: ['Accepted, Google is still processing it', 'text-warn'],
  success: ['Processed by Google', 'text-ok'],
  partial: ['Partly rejected by Google: ', 'text-bad'],
  rejected: ['Rejected by Google: ', 'text-bad'],
  unknown: ['Google gave no result within 24 hours', 'text-muted'],
};

function DeliveryRow({ tenantId, saleKey, d, onResent }: { tenantId: string; saleKey: string; d: DeliveryOf; onResent: () => Promise<void> }) {
  const toast = useToast();
  const resend = useAction();
  const preview = useAction();
  const [asking, setAsking] = useState(false);
  const [shown, setShown] = useState<PreviewResult | null>(null);

  const name = DEST_LABEL[d.destination] ?? d.destination;
  const detail = d.status === 'skipped' ? SKIP_LABEL[d.skipReason ?? ''] ?? d.skipReason : d.status === 'retry' && d.nextRetryAt ? `Next try ${fmtDate(d.nextRetryAt)}. ${d.lastError ?? ''}` : (d.lastError ?? d.response);
  const waiting = d.lastError?.startsWith('not_connected') ?? false;
  const processing = d.status === 'sent' && d.processingStatus ? PROCESSING[d.processingStatus] : undefined;
  const reason = (d.processingDetail ?? '').replace(/^rejected: /, '');

  const send = async () => {
    setAsking(false);
    const ok = await resend.run(async () => {
      await api('POST', `/tenants/${encodeURIComponent(tenantId)}/sales/${saleKey}/deliveries/${d.destination}/resend`);
      return true;
    });
    if (ok) {
      toast('Queued to send again. Use “Send waiting sales now” or wait for the next run.');
      await onResent();
    }
  };

  const showPreview = async () => {
    const r = await preview.run(() => api<PreviewResult>('GET', `/tenants/${encodeURIComponent(tenantId)}/sales/${saleKey}/deliveries/${d.destination}/preview`));
    if (r) setShown(r);
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2.5">
        <strong className="text-sm">{name}</strong>
        <StatusBadge status={d.status} title={detail} />
      </div>
      {d.status === 'skipped' && detail && <div className="mt-1.5 text-xs text-muted">{detail}</div>}
      {(d.status === 'failed' || d.status === 'retry') && d.lastError && (
        <div className={`mt-1.5 text-xs ${waiting ? 'text-warn' : 'text-bad'}`}>{waiting ? 'Waiting: connect this account under Ad accounts and it will send automatically.' : d.lastError.slice(0, 300)}</div>
      )}
      {processing && (
        <div className={`mt-1.5 text-xs ${processing[1]}`}>
          {processing[0]}
          {d.processingStatus === 'partial' || d.processingStatus === 'rejected' ? reason : ''}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {d.status !== 'skipped' && (
          <Button onClick={showPreview} disabled={preview.busy} className="h-8 text-xs">
            Preview what is sent
          </Button>
        )}
        {(d.status === 'failed' || d.status === 'retry' || d.status === 'sent') && (
          <Button onClick={() => (d.status === 'sent' ? setAsking(true) : void send())} disabled={resend.busy} className="h-8 text-xs">
            Send again
          </Button>
        )}
      </div>
      {/* Escape in a dialog opened from here must close only that dialog, not the sale dialog behind it. */}
      <div onKeyDown={(e) => e.stopPropagation()}>
      <ConfirmDialog open={asking} title="Send a sale that was already sent?" message="It reuses the same event ID, so the platform should not count it twice." confirmLabel="Send again" onConfirm={() => void send()} onCancel={() => setAsking(false)} />
      {shown && <PreviewDialog name={name} r={shown} onClose={() => setShown(null)} />}
      </div>
    </div>
  );
}

/** What would be sent for a delivery: built by the real sender code, nothing is sent, no secrets. */
function PreviewDialog({ name, r, onClose }: { name: string; r: PreviewResult; onClose: () => void }) {
  return (
    <Modal open title={`What would be sent to ${name}`} onClose={onClose} wide>
      <div className="space-y-3">
        {r.error && <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{r.error}</p>}
        {(r.notes ?? []).map((n) => (
          <p key={n} className="text-xs text-muted">{n}</p>
        ))}
        {r.url && (
          <p className="text-xs">
            POST <span className="font-mono break-all">{r.url}</span>
          </p>
        )}
        {r.body !== undefined && r.body !== null && <pre className="max-h-96 overflow-auto rounded-lg bg-surface-2 p-3 text-xs">{JSON.stringify(r.body, null, 2)}</pre>}
        <p className="text-xs text-muted">Nothing was sent. Contact details appear only as hashes, and no access tokens are included.</p>
      </div>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
