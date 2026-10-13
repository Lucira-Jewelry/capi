'use client';
import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Switch, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { DEST_LABEL, type Connection, type Meta, type MetaTestResult } from '@/lib/types';
import { GoogleDialog } from './connections/GoogleDialog';
import { MetaDialog } from './connections/MetaDialog';
import { TestEventDialog } from './connections/TestEventDialog';
import type { TabProps } from './types';

export function AdAccounts({ id, view, meta, reload }: TabProps) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Ad accounts</h2>
        <p className="text-sm text-muted">Sales are sent to the accounts you connect here. Each platform has its own switch.</p>
      </div>
      {(['meta', 'google_ads'] as const).map((kind) => (
        <PlatformRow key={kind} id={id} kind={kind} conn={view.connections.find((c) => c.kind === kind)} chosen={view.tenant.destinations.includes(kind)} google={meta.google} reload={reload} />
      ))}
    </div>
  );
}

function PlatformRow({ id, kind, conn, chosen, google, reload }: { id: string; kind: 'meta' | 'google_ads'; conn: Connection | undefined; chosen: boolean; google: Meta['google']; reload: () => Promise<void> }) {
  const toast = useToast();
  const name = DEST_LABEL[kind]!;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);
  const check = useAction();
  const test = useAction();
  const [testResult, setTestResult] = useState<MetaTestResult | null>(null);
  const on = conn?.enabled !== false;

  const set = async (enabled: boolean) => {
    setAsking(false);
    setBusy(true);
    try {
      await api('POST', `/tenants/${encodeURIComponent(id)}/connections/${kind}/enabled`, { enabled });
      toast(enabled ? `${name} is on` : `${name} is off: new sales are held back`);
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong', true);
    } finally {
      setBusy(false);
    }
  };

  const status = !conn ? <Badge>Not connected</Badge> : conn.status === 'error' ? <Badge tone="bad">Needs attention</Badge> : !on ? <Badge tone="warn">Sending off</Badge> : conn.testEventCode ? <Badge tone="warn">Test mode</Badge> : <Badge tone="ok">Connected</Badge>;
  const detail = !conn ? kind === 'meta' ? 'Needs a dataset ID and an access token.' : 'Needs the account ID and a conversion action.' : kind === 'meta' ? `Dataset ${conn.datasetId ?? ''}${conn.testEventCode ? ` · events are sent with test code ${conn.testEventCode}` : ''}` : `Customer ${conn.customerId ?? ''}`;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5"><span className="font-semibold">{name}</span>{status}</div>
          <div className="mt-1 text-sm text-muted">{detail}</div>
          {kind === 'meta' && conn && !conn.testEventCode && <div className="mt-1 text-xs text-muted">To check the setup safely, add a Test event code (Edit), then send a test event.</div>}
          {!chosen && <div className="mt-1 text-xs text-warn">Not chosen for this brand: new sales are not queued for {name}. Add it in Settings.</div>}
        </div>
        <div className="flex items-center gap-2">
          {conn && <Switch on={on} busy={busy} label={`Sending to ${name}`} onChange={(next) => (next ? void set(true) : setAsking(true))} />}
          {kind === 'meta' && conn && (
            <Button
              disabled={test.busy || !conn.testEventCode}
              title={conn.testEventCode ? 'Sends one made-up purchase to Test Events' : 'Add a test event code first (Edit)'}
              onClick={() =>
                void test.run(async () => {
                  setTestResult(await api<MetaTestResult>('POST', `/tenants/${encodeURIComponent(id)}/connections/meta/test-event`));
                  await reload(); // a rejected token marks the connection as needing attention
                })
              }
            >
              {test.busy ? 'Sending…' : 'Send test event'}
            </Button>
          )}
          {kind === 'google_ads' && conn && (
            <Button
              disabled={check.busy}
              onClick={() =>
                void check.run(async () => {
                  const r = await api<{ ok: boolean; message: string }>('POST', `/tenants/${encodeURIComponent(id)}/connections/google_ads/check`);
                  toast(r.message, !r.ok);
                })
              }
            >
              Check connection
            </Button>
          )}
          <Button variant={!conn || conn.status === 'error' ? 'primary' : 'default'} onClick={() => setEditing(true)}>{conn ? 'Edit' : 'Connect'}</Button>
        </div>
      </div>
      {conn?.status === 'error' && (
        <p className="mt-3 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
          {conn.lastError ?? 'Unknown error'}.{' '}
          {kind === 'meta' ? 'Save a new token, then resend the failed sales from the Sales tab.' : 'Fix the access, press Check connection, then resend the failed sales from the Sales tab.'}
        </p>
      )}
      <TestEventDialog result={testResult} onClose={() => setTestResult(null)} />
      {editing && kind === 'meta' && <MetaDialog tenantId={id} conn={conn} onClose={() => setEditing(false)} onSaved={() => void reload()} />}
      {editing && kind === 'google_ads' && <GoogleDialog tenantId={id} conn={conn} google={google} onClose={() => setEditing(false)} onSaved={() => void reload()} />}
      <ConfirmDialog
        open={asking}
        title={`Stop sending to ${name}?`}
        message="New sales will wait in the queue and are not lost. They are sent when you switch it back on."
        confirmLabel="Switch off"
        onConfirm={() => void set(false)}
        onCancel={() => setAsking(false)}
      />
    </Card>
  );
}
