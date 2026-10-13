'use client';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { More, csvToList } from './util';

export function AddSiteDialog({ tenantId, open, onClose, onAdded }: { tenantId: string; open: boolean; onClose: () => void; onAdded: () => Promise<void> }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [origins, setOrigins] = useState('');
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const done = await run(async () => {
      await api('POST', `/tenants/${encodeURIComponent(tenantId)}/site-keys`, { origins: csvToList(origins), label, trackingHost: host });
      return true;
    });
    if (done) {
      toast('Website added');
      setOrigins('');
      setLabel('');
      setHost('');
      onClose();
      await onAdded();
    }
  };

  return (
    <Modal open={open} title="Add website" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Only these websites will be allowed to send us data.</p>
        <Field label="Website address" hint="For several, separate them with commas.">
          {(p) => <Input {...p} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://www.brand.com" />}
        </Field>
        <More summary="Optional: name and tracking address">
          <Field label="Name">{(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Main site" />}</Field>
          <Field label="Tracking address" hint="The brand’s own address like track.brand.com. You can add it later.">
            {(p) => <Input {...p} value={host} onChange={(e) => setHost(e.target.value)} placeholder="track.brand.com" />}
          </Field>
        </More>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>Add website</Button>
        </div>
      </form>
    </Modal>
  );
}
