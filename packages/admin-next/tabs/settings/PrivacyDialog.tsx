'use client';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';

export function PrivacyDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const r = await api<{ keys: number; personFound: boolean }>('POST', `/tenants/${encodeURIComponent(tenantId)}/consent/withdraw`, { phone, email });
      toast(r.personFound ? 'Recorded. Their website profile is marked as declined too.' : 'Recorded. No website profile was found; their sales will still be skipped.');
      onClose();
    });
  };

  return (
    <Modal open title="Customer privacy request" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">
          Their queued sales are skipped and future ones are never sent, under any phone or email we know belongs to them, even if the CRM keeps marking them as consenting. A later clear “yes” from the customer on the website lifts it.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone">{(p) => <Input {...p} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />}</Field>
          <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />}</Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>Record request</Button>
        </div>
      </form>
    </Modal>
  );
}
