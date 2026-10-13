'use client';
import { useState, type FormEvent } from 'react';
import { Button, ConfirmDialog, Field, Input, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';

interface EraseResult {
  persons: number;
  sales: number;
  deliveriesCancelled: number;
  contactDetails?: number;
}

export function EraseDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [asking, setAsking] = useState(false);
  const who = phone.trim() || email.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!who) {
      toast('Give a phone number or an email.', true);
      return;
    }
    setAsking(true); // the second question: nothing is erased until it is answered
  };

  const erase = async () => {
    setAsking(false);
    await run(async () => {
      const r = await api<EraseResult>('POST', `/tenants/${encodeURIComponent(tenantId)}/customers/erase`, { phone, email });
      const parts = [
        r.persons ? `${r.persons} website ${r.persons === 1 ? 'profile' : 'profiles'} deleted` : '',
        r.sales ? `${r.sales} ${r.sales === 1 ? 'sale' : 'sales'} made anonymous` : '',
        r.deliveriesCancelled ? `${r.deliveriesCancelled} queued ${r.deliveriesCancelled === 1 ? 'send' : 'sends'} cancelled` : '',
      ].filter(Boolean);
      const linked = (r.contactDetails ?? 0) > 1 ? ` Nothing will be sent for any of the ${r.contactDetails} phone numbers and emails linked to them.` : '';
      toast(parts.length ? `Erased: ${parts.join(', ')}.${linked}` : `Nothing was stored for them. Nothing will be sent for them from now on.${linked}`);
      onClose();
    });
  };

  return (
    <>
      <Modal open title="Erase a customer" onClose={onClose}>
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted">
            Deletes their website profile and clicks, removes their phone and email details from past sales, and cancels anything not yet sent. Nothing more is ever sent for any phone or email we know belongs to them (found through their sales and visits). This cannot be undone.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone">{(p) => <Input {...p} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />}</Field>
            <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />}</Field>
          </div>
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">Data already sent to Meta or Google is not removed by this. It has to be deleted in those platforms.</div>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={busy}>Erase customer data</Button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog open={asking} title="Erase this customer?" message={`${who}: their data will be deleted for good.`} confirmLabel="Erase" danger onConfirm={() => void erase()} onCancel={() => setAsking(false)} />
    </>
  );
}
