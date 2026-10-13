'use client';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Card, ConfirmDialog, CopyField, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import type { TabProps } from './types';
import { MappingDialog } from './crm/MappingDialog';
import { More, StepTitle } from './website/util';

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-contrast">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <StepTitle>{title}</StepTitle>
        {children}
      </div>
    </li>
  );
}

export function Crm({ id, view, meta, reload }: TabProps) {
  const mapped = Boolean(view.tenant.sources.zoho);
  const [mapping, setMapping] = useState(false);
  const [asking, setAsking] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, run } = useAction();

  const rotate = async () => {
    setAsking(false);
    const r = await run(() => api<{ webhookSecret: string }>('POST', `/tenants/${encodeURIComponent(id)}/webhook-secret/rotate`));
    if (r) setSecret(r.webhookSecret);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Zoho CRM</h2>
      <Card className="p-5">
        <ol className="space-y-5">
          <Step n={1} title="Copy this webhook address">
            <p className="text-sm text-muted">In Zoho, create a workflow rule that calls it when a deal is marked Won. Include the contact’s phone and email in what it sends.</p>
            <CopyField value={view.webhooks.zoho} />
          </Step>
          <Step n={2} title="Add this header to the rule">
            <CopyField value="x-webhook-secret: <the secret shown when the brand was created>" />
            <p className="text-sm text-muted">Lost the secret? Create a new one under “Other systems and security”.</p>
          </Step>
          <Step n={3} title="Tell us which Zoho fields to read">
            <div className="flex items-center gap-3">
              {mapped ? <Badge tone="ok">Saved</Badge> : <Badge>Not set up</Badge>}
              <Button variant={mapped ? 'default' : 'primary'} onClick={() => setMapping(true)}>{mapped ? 'Edit field mapping' : 'Set up field mapping'}</Button>
            </div>
          </Step>
        </ol>
      </Card>

      <More summary="Other systems and security">
        <p className="text-sm text-muted">Any other system can post the standard JSON to this address instead:</p>
        <CopyField value={view.webhooks.generic} />
        {secret && (
          <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
            <strong className="text-sm">New webhook secret (shown once)</strong>
            <CopyField value={secret} />
            <div className="text-xs text-muted">Update the x-webhook-secret header in the Zoho workflow now.</div>
          </div>
        )}
        <div><Button disabled={busy} onClick={() => setAsking(true)}>Create a new secret</Button></div>
      </More>

      <MappingDialog tenantId={id} open={mapping} current={view.tenant.sources.zoho} usual={meta.defaultZohoMapping} onClose={() => setMapping(false)} onSaved={reload} />
      <ConfirmDialog open={asking} title="Create a new webhook secret?" message="The old one stops working immediately, so update it in Zoho right away." confirmLabel="Create new secret" danger onConfirm={() => void rotate()} onCancel={() => setAsking(false)} />
    </div>
  );
}
