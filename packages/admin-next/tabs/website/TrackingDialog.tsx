'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Input, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import type { SiteKey } from '@/lib/types';
import { DnsBlock } from './DnsBlock';

export function TrackingDialog({ tenantId, site, onClose, onSaved }: { tenantId: string; site: SiteKey | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [host, setHost] = useState('');
  useEffect(() => setHost(site?.trackingHost ?? ''), [site]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!site) return;
    const done = await run(async () => {
      await api('PATCH', `/tenants/${encodeURIComponent(tenantId)}/site-keys/${site.key}`, { trackingHost: host });
      return true;
    });
    if (done) {
      toast('Tracking address saved');
      onClose();
      await onSaved();
    }
  };

  return (
    <Modal open={site !== null} title="Tracking address" onClose={onClose} wide>
      {site && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted">Optional. The brand’s own address (like track.brand.com) makes browsers treat our tracking as part of the brand’s site, so it lasts longer.</p>
          <Field label="Address" hint="Clear it to go back to the shared address.">
            {(p) => <Input {...p} value={host} onChange={(e) => setHost(e.target.value)} placeholder="track.brand.com" />}
          </Field>
          {site.trackingHost && <DnsBlock site={site} />}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>Save address</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
