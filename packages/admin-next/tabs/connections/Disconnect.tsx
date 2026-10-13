'use client';
import { useState } from 'react';
import { Button, ConfirmDialog, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { DEST_LABEL } from '@/lib/types';

/** Removes the saved connection after a question. Sales wait until it is connected again. */
export function Disconnect({ tenantId, kind, onDone }: { tenantId: string; kind: 'meta' | 'google_ads'; onDone: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [asking, setAsking] = useState(false);
  const name = DEST_LABEL[kind] ?? kind;
  return (
    <>
      <Button variant="danger" onClick={() => setAsking(true)} disabled={busy}>Disconnect</Button>
      <ConfirmDialog
        open={asking}
        title={`Disconnect ${name}?`}
        message="Sales will wait until it is connected again."
        confirmLabel="Disconnect"
        danger
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void run(async () => {
            await api('DELETE', `/tenants/${encodeURIComponent(tenantId)}/connections/${kind}`);
            toast('Disconnected');
            onDone();
          });
        }}
      />
    </>
  );
}
