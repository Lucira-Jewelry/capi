'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, CopyField, Field, Input, Modal, Select, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { CHANNEL_LABEL, DEST_LABEL, type Meta, type TenantView } from '@/lib/types';
import { InstallOptions } from './InstallOptions';

type Created = TenantView & { siteKey: string; webhookSecret: string };

const csvToList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function Checks({ legend, options, labels, value, onChange }: { legend: string; options: string[]; labels: Record<string, string>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
        {options.map((o) => (
          <label key={o} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(o)} onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))} className="h-4 w-4 accent-[var(--accent)]" />
            {labels[o] ?? o}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function NewBrandDialog({ open, meta, onClose, onOpenBrand }: { open: boolean; meta: Meta; onClose: (created: boolean) => void; onOpenBrand: (id: string) => void }) {
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [trackingHost, setTrackingHost] = useState('');
  const [consent, setConsent] = useState('opt_in');
  const [country, setCountry] = useState('IN');
  const [retention, setRetention] = useState('90');
  const [channels, setChannels] = useState(['store', 'whatsapp']);
  const [dests, setDests] = useState(['meta', 'google_ads']);
  const [zoho, setZoho] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const { busy, run } = useAction();
  const formRef = useRef<HTMLFormElement>(null);
  const focusName = () => formRef.current?.querySelector<HTMLInputElement>('input')?.focus();

  // Start typing straight away (after the dialog has put focus on its first control).
  useEffect(() => {
    if (!open || created) return;
    const t = setTimeout(focusName, 0);
    return () => clearTimeout(t);
  }, [open, created]);

  const reset = () => {
    setName(''); setOrigins(''); setTrackingHost(''); setError(null); setCreated(null);
  };
  const close = () => {
    const wasCreated = Boolean(created);
    reset();
    onClose(wasCreated);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    await run(async () => {
      try {
        setCreated(
          await api<Created>('POST', '/tenants', {
            name,
            origins: csvToList(origins),
            trackingHost,
            consentMode: consent,
            defaultCountry: country,
            allowedChannels: channels,
            destinations: dests,
            retentionDays: Number(retention),
            zoho,
          }),
        );
      } catch (err) {
        // Shown in the form, next to what needs fixing, and the cursor goes back to the first field.
        setError(err instanceof Error ? err.message : 'Could not create the brand.');
        focusName();
      }
    });
  };

  if (created) {
    return (
      <Modal open={open} title={`${created.tenant.name} is ready`} onClose={close} wide>
        <div className="space-y-4">
          <div className="space-y-1.5 rounded-lg border border-border bg-surface-2 p-3">
            <div className="text-sm font-medium">Webhook secret (shown once)</div>
            <CopyField value={created.webhookSecret} />
            <p className="text-xs text-muted">Send it as the x-webhook-secret header from your CRM. If you lose it, rotate it from the CRM tab.</p>
          </div>
          <p className="text-sm">Put the script on the website:</p>
          {created.siteKeys[0] && <InstallOptions snippet={created.siteKeys[0].snippet} gtmSnippet={created.siteKeys[0].gtmSnippet} />}
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => { const id = created.tenant.tenantId; reset(); onOpenBrand(id); }}>Open brand</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} title="New brand" onClose={close} wide>
      <form ref={formRef} onSubmit={submit} className="space-y-4">
        {error && <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p>}
        <Field label="Brand name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Jewels" />}</Field>
        <Field label="Website address(es)" hint="Where the website script will run, separated by commas. Only these sites can send data.">
          {(p) => <Input {...p} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://www.acme.com" />}
        </Field>
        <Field label="Tracking address" hint="The brand's own address that will point at us, for example track.acme.com. Can be added later; leave empty to start with the shared address.">
          {(p) => <Input {...p} value={trackingHost} onChange={(e) => setTrackingHost(e.target.value)} placeholder="track.acme.com (optional)" />}
        </Field>
        <Field label="Consent policy">
          {(p) => (
            <Select {...p} value={consent} onChange={(e) => setConsent(e.target.value)}>
              <option value="opt_in">Opt-in: only share data customers agreed to (recommended)</option>
              <option value="opt_out">Opt-out: share unless the customer declined</option>
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone numbers without a country code are from">
            {(p) => <Select {...p} value={country} onChange={(e) => setCountry(e.target.value)}>{meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}
          </Field>
          <Field label="Keep customer data for (days)">
            {(p) => <Input {...p} type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} />}
          </Field>
        </div>
        <div>
          <Checks legend="Report these sales channels" options={meta.channels} labels={CHANNEL_LABEL} value={channels} onChange={setChannels} />
          <p className="mt-1 text-xs text-muted">Leave &quot;Online&quot; off if the store platform already reports online sales to the ad platforms, to avoid double counting.</p>
        </div>
        <Checks legend="Send to" options={meta.destinations} labels={DEST_LABEL} value={dests} onChange={setDests} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={zoho} onChange={(e) => setZoho(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          Connect Zoho CRM (start from the usual field names)
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>Create brand</Button>
        </div>
      </form>
    </Modal>
  );
}
