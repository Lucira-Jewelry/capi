'use client';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import type { Connection } from '@/lib/types';
import { Disconnect } from './Disconnect';

export function MetaDialog({ tenantId, conn, onClose, onSaved }: { tenantId: string; conn: Connection | undefined; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [dataset, setDataset] = useState(conn?.datasetId ?? '');
  const [token, setToken] = useState('');
  const [test, setTest] = useState(conn?.testEventCode ?? '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      await api('PUT', `/tenants/${encodeURIComponent(tenantId)}/connections/meta`, { datasetId: dataset, testEventCode: test, accessToken: token });
      toast('Meta connected');
      onSaved();
      onClose();
    });
  };

  return (
    <Modal open title={conn ? 'Edit Meta connection' : 'Connect Meta'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">In Meta Events Manager, open your dataset, then Settings → Conversions API.</p>
        <Field label="Dataset ID">{(p) => <Input {...p} value={dataset} onChange={(e) => setDataset(e.target.value)} placeholder="1234567890123456" />}</Field>
        <Field label="Access token" hint="Stored encrypted and never shown again.">
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={conn ? 'Saved: leave blank to keep' : 'Paste the access token'} />}
        </Field>
        <details className="rounded-lg border border-border px-3 py-2" open={Boolean(test)}>
          <summary className="cursor-pointer text-sm font-medium">Testing first? Add a test event code</summary>
          <div className="mt-3">
            <Field label="Test event code" hint="While set, events are sent with this test code, so Meta treats them as tests. Clear it to go live.">
              {(p) => <Input {...p} value={test} onChange={(e) => setTest(e.target.value)} placeholder="TEST12345" />}
            </Field>
          </div>
        </details>
        <div className="flex items-center justify-between gap-2 pt-1">
          <div>{conn && <Disconnect tenantId={tenantId} kind="meta" onDone={() => { onSaved(); onClose(); }} />}</div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>{conn ? 'Save' : 'Connect'}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
