import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import { ToastProvider } from '@/components/ui';
import { AuthProvider } from '@/lib/auth';
import type { Meta, Tenant, TenantView } from '@/lib/types';

type Handler = (body: unknown) => unknown;

/** Replaces fetch. Keys are "METHOD /path" (without /admin/api); a handler may return { __status, error, message } to fail. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace('/admin/api', '');
      const key = `${init?.method ?? 'GET'} ${path}`;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body });
      const handler = routes[key] ?? routes[key.split('?')[0]!];
      if (!handler) return new Response(JSON.stringify({ error: 'unmocked', message: `no mock for ${key}` }), { status: 500 });
      const out = handler(body) as { __status?: number } | undefined;
      const status = out?.__status ?? 200;
      return new Response(JSON.stringify(out ?? {}), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

export const tenant: Tenant = {
  tenantId: 'b1',
  name: 'Brand One',
  status: 'active',
  consentPolicy: { mode: 'opt_in' },
  allowedChannels: ['store', 'online'],
  destinations: ['meta', 'google_ads'],
  defaultCountry: 'IN',
  retentionDays: 90,
  sources: {},
  createdAt: '2026-10-01T00:00:00.000Z',
};

export const meta: Meta = {
  channels: ['store', 'online', 'whatsapp', 'web_lead'],
  destinations: ['meta', 'google_ads'],
  countries: ['IN', 'US'],
  importColumns: ['phone', 'amount'],
  importTemplate: 'phone,amount\n',
  defaultZohoMapping: { dealId: 'id', amount: 'Amount', occurredAt: 'Closing_Date', phone: 'Phone', channel: 'Channel', storeChannelValues: ['Store'] },
  google: { oauthConfigured: false },
};

export const tenantView = (over: Partial<TenantView> = {}): TenantView => ({
  tenant,
  siteKeys: [],
  connections: [],
  webhooks: { zoho: 'https://c/zoho', generic: 'https://c/generic' },
  ...over,
});

export function renderWithApp(ui: ReactElement) {
  return render(
    <AuthProvider>
      <ToastProvider>{ui}</ToastProvider>
    </AuthProvider>,
  );
}
