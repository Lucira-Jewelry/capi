'use client';
import { useState } from 'react';
import { Button, Card, Field, Input, Select, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { CHANNEL_LABEL, DEST_LABEL } from '@/lib/types';
import { EraseDialog } from './settings/EraseDialog';
import { PrivacyDialog } from './settings/PrivacyDialog';
import type { TabProps } from './types';

function CheckGroup({ legend, options, labels, selected, onChange }: { legend: string; options: string[]; labels: Record<string, string>; selected: string[]; onChange: (next: string[]) => void }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
        {options.map((o) => (
          <label key={o} className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(o)} onChange={(e) => onChange(e.target.checked ? [...selected, o] : selected.filter((x) => x !== o))} />
            {labels[o] ?? o}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Settings({ id, view, meta, reload }: TabProps) {
  const t = view.tenant;
  const toast = useToast();
  const { busy, run } = useAction();
  const [name, setName] = useState(t.name);
  const [consent, setConsent] = useState(t.consentPolicy.mode);
  const [country, setCountry] = useState(t.defaultCountry);
  const [channels, setChannels] = useState(t.allowedChannels);
  const [dests, setDests] = useState(t.destinations);
  const [retention, setRetention] = useState(String(t.retentionDays));
  const [status, setStatus] = useState(t.status);
  const [dialog, setDialog] = useState<'privacy' | 'erase' | null>(null);

  // Save is only offered when something changed, and the page says so, so there is never a doubt whether it was saved.
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const changed =
    name !== t.name || consent !== t.consentPolicy.mode || country !== t.defaultCountry || !same(channels, t.allowedChannels) || !same(dests, t.destinations) || Number(retention) !== t.retentionDays || status !== t.status;

  const save = () =>
    run(async () => {
      await api('PATCH', `/tenants/${encodeURIComponent(id)}`, {
        name,
        consentMode: consent,
        defaultCountry: country,
        allowedChannels: channels,
        destinations: dests,
        retentionDays: Number(retention),
        status,
      });
      toast('Settings saved');
      await reload();
    });

  return (
    <div className="space-y-4">
      <Card className="space-y-5 p-5">
        <h2 className="text-lg font-semibold">Settings</h2>
        <Field label="Brand name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <CheckGroup legend="Send sales to" options={meta.destinations} labels={DEST_LABEL} selected={dests} onChange={setDests} />
        <div>
          <CheckGroup legend="Report these sales channels" options={meta.channels} labels={CHANNEL_LABEL} selected={channels} onChange={setChannels} />
          <p className="mt-1.5 text-xs text-muted">Leave “Online” off if the store platform already reports online sales to the ad platforms.</p>
        </div>
        <Field label="Consent policy">
          {(p) => (
            <Select {...p} value={consent} onChange={(e) => setConsent(e.target.value as 'opt_in' | 'opt_out')}>
              <option value="opt_in">Opt-in: only share data customers agreed to</option>
              <option value="opt_out">Opt-out: share unless the customer declined</option>
            </Select>
          )}
        </Field>
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone numbers without a country code are from">
                {(p) => <Select {...p} value={country} onChange={(e) => setCountry(e.target.value)}>{meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}
              </Field>
              <Field label="Keep customer data for (days)">{(p) => <Input {...p} type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} />}</Field>
            </div>
            <Field label="Status">
              {(p) => (
                <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'suspended')}>
                  <option value="active">Active</option>
                  <option value="suspended">Paused: refuse the script and webhook</option>
                </Select>
              )}
            </Field>
          </div>
        </details>
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!changed || busy} onClick={() => void save()}>Save settings</Button>
          <span className="text-sm text-muted" aria-live="polite">{changed ? 'You have unsaved changes.' : ''}</span>
        </div>
      </Card>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="font-semibold">Customer privacy request</div>
          <div className="text-sm text-muted">A customer asked you to stop using their data for advertising.</div>
        </div>
        <Button onClick={() => setDialog('privacy')}>Record a request</Button>
      </Card>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="font-semibold">Erase a customer</div>
          <div className="text-sm text-muted">A customer asked for their data to be deleted.</div>
        </div>
        <Button variant="danger" onClick={() => setDialog('erase')}>Erase…</Button>
      </Card>

      {dialog === 'privacy' && <PrivacyDialog tenantId={id} onClose={() => setDialog(null)} />}
      {dialog === 'erase' && <EraseDialog tenantId={id} onClose={() => setDialog(null)} />}
    </div>
  );
}
