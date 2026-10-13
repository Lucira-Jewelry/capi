'use client';
import { useState } from 'react';
import { Badge, Button, Card, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import type { SiteKey } from '@/lib/types';
import type { TabProps } from './types';
import { AddSiteDialog } from './website/AddSiteDialog';
import { InstallDialog } from './website/InstallDialog';
import { SetupCheckDialog, type SetupCheck } from './website/SetupCheckDialog';
import { TrackingDialog } from './website/TrackingDialog';

export function Website({ id, view, reload }: TabProps) {
  const [adding, setAdding] = useState(false);
  const [installing, setInstalling] = useState<SiteKey | null>(null);
  const [tracking, setTracking] = useState<SiteKey | null>(null);
  const [checked, setChecked] = useState<SetupCheck | null>(null);
  const { busy, run } = useAction();
  const sites = view.siteKeys;

  const check = async (k: SiteKey) => {
    const r = await run(() => api<SetupCheck>('POST', `/tenants/${encodeURIComponent(id)}/site-keys/${k.key}/check`));
    if (r) setChecked(r);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Websites</h2>
        {sites.length > 0 && <Button variant="primary" onClick={() => setAdding(true)}>+ Add website</Button>}
      </div>

      {sites.length === 0 ? (
        <Card className="p-8 text-center">
          <h3 className="font-semibold">No website yet</h3>
          <p className="mt-1 text-sm text-muted">Add the website where customers visit. You will get one script to paste on it.</p>
          <div className="mt-4"><Button variant="primary" onClick={() => setAdding(true)}>+ Add website</Button></div>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted">A small script on the website saves which ad brought each visitor, so a later sale can be matched back to it.</p>
          {sites.map((k) => (
            <Card key={k.key} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="break-all font-semibold">{k.origins.length ? k.origins.join(', ') : 'Any site (development only)'}</span>
                    {k.trackingHost ? <Badge tone="ok">Own address</Badge> : <Badge>Shared address</Badge>}
                  </div>
                  <div className="mt-1 text-sm text-muted">{k.trackingHost ? `Tracking address: ${k.trackingHost}` : 'Using our shared tracking address. Works, but browsers treat it as third-party.'}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" onClick={() => setInstalling(k)}>Install script</Button>
                  <Button onClick={() => setTracking(k)}>{k.trackingHost ? 'Tracking address' : 'Set tracking address'}</Button>
                  {k.trackingHost && <Button disabled={busy} onClick={() => void check(k)}>Check setup</Button>}
                </div>
              </div>
            </Card>
          ))}
        </>
      )}

      <AddSiteDialog tenantId={id} open={adding} onClose={() => setAdding(false)} onAdded={reload} />
      <InstallDialog site={installing} onClose={() => setInstalling(null)} />
      <TrackingDialog tenantId={id} site={tracking} onClose={() => setTracking(null)} onSaved={reload} />
      <SetupCheckDialog result={checked} onClose={() => setChecked(null)} />
    </div>
  );
}
