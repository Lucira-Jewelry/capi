'use client';
import { useState, type FormEvent } from 'react';
import { Button, CopyField, Field, Input, Modal, Select, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import type { Connection, Meta } from '@/lib/types';
import { Disconnect } from './Disconnect';

export function GoogleDialog({ tenantId, conn, google, onClose, onSaved }: { tenantId: string; conn: Connection | undefined; google: Meta['google']; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [customer, setCustomer] = useState(conn?.customerId ?? '');
  const [login, setLogin] = useState(conn?.loginCustomerId ?? '');
  const [action, setAction] = useState(conn?.conversionActionId ?? '');
  const [token, setToken] = useState('');
  const [method, setMethod] = useState<'service_account' | 'oauth'>(conn?.authMethod ?? (google.serviceAccountEmail ? 'service_account' : 'oauth'));
  const viaSa = method === 'service_account';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      await api('PUT', `/tenants/${encodeURIComponent(tenantId)}/connections/google_ads`, {
        authMethod: method,
        customerId: customer,
        loginCustomerId: login,
        conversionActionId: action,
        ...(method === 'oauth' ? { refreshToken: token } : {}),
      });
      toast('Google Ads connected');
      onSaved();
      onClose();
    });
  };

  return (
    <Modal open wide title={conn ? 'Edit Google Ads connection' : 'Connect Google Ads'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">We upload sales as offline conversions to one conversion action.</p>
        <Field label="Customer ID" hint="The ad account that receives the conversions.">{(p) => <Input {...p} value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="123-456-7890" />}</Field>
        <Field label="Conversion action ID" hint="In Google Ads, create a conversion action of type “Import” (from clicks), then copy its ID.">
          {(p) => <Input {...p} value={action} onChange={(e) => setAction(e.target.value)} placeholder="Conversion action ID" />}
        </Field>
        <Field label="How should we get access?">
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'service_account' | 'oauth')}>
              <option value="service_account">Give our service account access (recommended)</option>
              <option value="oauth">Use a Google login (refresh token)</option>
            </Select>
          )}
        </Field>
        {viaSa ? (
          <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm">
            {google.serviceAccountEmail ? (
              <>
                <div>In Google Ads, go to Admin → Access and security and add this email as a user:</div>
                <CopyField value={google.serviceAccountEmail} />
                <div className="text-xs text-muted">Standard access is enough to upload conversions. If you manage their account, linking it to your manager account also works: put your manager ID under “Manager account” below.</div>
              </>
            ) : (
              <div>The server has no service account key yet (GOOGLE_SERVICE_ACCOUNT_JSON), so this method will not work until it is set. Use a Google login meanwhile.</div>
            )}
          </div>
        ) : (
          <Field label="Refresh token" hint={`From a Google user with access to the account. Get one with scripts/google-refresh-token.ts.${google.oauthConfigured ? '' : ' The OAuth client is not configured on the server yet.'}`}>
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={conn?.secretSet ? 'Saved: leave blank to keep' : 'OAuth refresh token'} />}
          </Field>
        )}
        <details className="rounded-lg border border-border px-3 py-2" open={Boolean(login)}>
          <summary className="cursor-pointer text-sm font-medium">Manager account (optional)</summary>
          <div className="mt-3">
            <Field label="Manager (MCC) ID" hint="Only if access is through a manager account.">{(p) => <Input {...p} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Manager account ID" />}</Field>
          </div>
        </details>
        <div className="flex items-center justify-between gap-2 pt-1">
          <div>{conn && <Disconnect tenantId={tenantId} kind="google_ads" onDone={() => { onSaved(); onClose(); }} />}</div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>{conn ? 'Save' : 'Connect'}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
