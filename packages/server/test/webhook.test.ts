import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ZOHO_MAPPING, type IngestTenant, type ProcessResult } from '@datahash/ingest';
import { handleWebhook, parseWebhookBody } from '../src';

const tenant: IngestTenant = {
  tenantId: 'brand-a',
  consentPolicy: { mode: 'opt_in' },
  allowedChannels: ['store'],
  destinations: ['meta', 'google_ads'],
  defaultCountry: 'IN',
  sources: { zoho: DEFAULT_ZOHO_MAPPING },
};

const deal = {
  id: 'D1',
  Stage: 'Closed Won',
  Amount: '85000',
  Closing_Date: '2026-10-07',
  Sale_Channel: 'store',
  Contact_Name: { Mobile: '98765 43210', Email: 'priya@example.com' },
};

const processed: ProcessResult = { saleKey: 'k', duplicate: false, matchedPerson: false, deliveries: [] };

function setup(process = vi.fn(async () => processed)) {
  const log = vi.fn(async () => {});
  const deps = {
    getTenant: async (id: string) => (id === 'brand-a' ? tenant : null),
    verifySecret: async (_id: string, secret: string | undefined) => secret === 'topsecret',
    process,
    log,
  };
  return { process, log, deps };
}

const req = (over: Record<string, unknown> = {}) => ({
  tenantId: 'brand-a',
  source: 'zoho',
  secret: 'topsecret',
  body: JSON.stringify(deal),
  contentType: 'application/json',
  ...over,
});

describe('parseWebhookBody', () => {
  it('parses JSON and form-encoded bodies', () => {
    expect(parseWebhookBody('{"a":1}', 'application/json')).toEqual({ a: 1 });
    expect(parseWebhookBody('id=D1&Amount=5', 'application/x-www-form-urlencoded')).toEqual({ id: 'D1', Amount: '5' });
    expect(parseWebhookBody('{nope', 'application/json')).toBeNull();
  });
});

describe('handleWebhook', () => {
  it('rejects unknown tenants/sources and wrong or missing secrets', async () => {
    const { deps, process } = setup();
    expect((await handleWebhook(req({ tenantId: 'x' }), deps)).status).toBe(401); // unknown looks like bad secret
    expect((await handleWebhook(req({ source: 'shopify' }), deps)).status).toBe(404);
    expect((await handleWebhook(req({ secret: 'nope' }), deps)).status).toBe(401);
    expect((await handleWebhook(req({ secret: undefined }), deps)).status).toBe(401);
    expect((await handleWebhook(req({ secret: 'topsecretX' }), deps)).status).toBe(401);
    expect(process).not.toHaveBeenCalled();
  });

  it('rejects bodies that are not JSON or form data', async () => {
    const { deps } = setup();
    expect((await handleWebhook(req({ body: '{nope' }), deps)).status).toBe(400);
  });

  it('a brand without a Zoho mapping gets a clear 404 on the zoho endpoint', async () => {
    const { deps } = setup();
    deps.getTenant = async () => ({ ...tenant, sources: {} });
    expect((await handleWebhook(req(), deps)).status).toBe(404);
  });

  it('records a won deal', async () => {
    const { deps, process } = setup();
    const res = await handleWebhook(req(), deps);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ status: 'recorded', saleKey: 'k', deliveries: [] }]);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('reports duplicates', async () => {
    const { deps } = setup(vi.fn(async () => ({ ...processed, duplicate: true })));
    expect((await handleWebhook(req(), deps)).body.results).toEqual([
      { status: 'duplicate', saleKey: 'k', deliveries: [] },
    ]);
  });

  it('handles Zoho-style { data: [...] } batches with a mix of outcomes', async () => {
    const { deps, process } = setup();
    const body = JSON.stringify({ data: [deal, { ...deal, id: 'D2', Stage: 'Negotiation' }, { ...deal, id: 'D3', Amount: 'x' }] });
    const res = await handleWebhook(req({ body }), deps);
    expect(res.status).toBe(200);
    expect((res.body.results as Array<{ status: string; reason?: string }>).map((r) => r.reason ?? r.status)).toEqual([
      'recorded',
      'not_won',
      'invalid_amount',
    ]);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('accepts form-encoded Zoho payloads', async () => {
    const { deps, process } = setup();
    const form = new URLSearchParams({
      id: 'D9',
      Stage: 'Closed Won',
      Amount: '1,200',
      Closing_Date: '2026-10-07',
      Sale_Channel: 'In-Store',
      'Contact_Name.Mobile': '9876543210',
    }).toString();
    const res = await handleWebhook(req({ body: form, contentType: 'application/x-www-form-urlencoded' }), deps);
    expect(res.status).toBe(200);
    const sale = (process.mock.calls[0] as unknown as [IngestTenant, { eventId: string; phone: string; value: number }])[1];
    expect(sale).toMatchObject({ eventId: 'D9', phone: '9876543210', value: 1200 });
  });

  it('the generic endpoint takes the standard JSON', async () => {
    const { deps, process } = setup();
    const body = JSON.stringify({ eventId: 'w1', channel: 'whatsapp', occurredAt: '2026-10-07T10:00:00+05:30', phone: '9876543210' });
    const res = await handleWebhook(req({ source: 'generic', body }), deps);
    expect(res.status).toBe(200);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('logs a redacted copy: no plain phone or email', async () => {
    const { deps, log } = setup();
    await handleWebhook(req(), deps);
    const logged = JSON.stringify(log.mock.calls[0]);
    expect(logged).toContain('D1');
    expect(logged).not.toContain('98765');
    expect(logged).not.toContain('priya@example.com');
  });

  it('logs only the mapped fields: names, notes and other contacts in the record never reach the log', async () => {
    const { deps, log } = setup();
    const noisy = {
      ...deal,
      Description: 'Customer asked us to call her sister on 9111122222',
      Contact_Name: { ...deal.Contact_Name, Full_Name: 'Priya Sharma', Secondary_Email: 'sister@example.com' },
      customer: { email: 'other@example.com', address: '12 MG Road' },
    };
    await handleWebhook(req({ body: JSON.stringify(noisy) }), deps);
    const logged = JSON.stringify(log.mock.calls[0]);
    for (const leak of ['Priya', 'sister', '9111122222', 'MG Road', 'other@example.com', '98765', 'priya@example.com']) {
      expect(logged).not.toContain(leak);
    }
    expect(logged).toContain('D1'); // the deal ID and the mapped business fields are kept
    expect(logged).toContain('[redacted]'); // and the log shows a phone/email was present

    log.mockClear();
    const generic = JSON.stringify({ eventId: 'w1', channel: 'whatsapp', occurredAt: '2026-10-07T10:00:00+05:30', phone: '9876543210', name: 'Priya', notes: 'x@y.com' });
    await handleWebhook(req({ source: 'generic', body: generic }), deps);
    const g = JSON.stringify(log.mock.calls[0]);
    expect(g).not.toMatch(/Priya|x@y\.com|9876543210/);
    expect(g).toContain('w1');
  });

  it('a logging failure does not break ingestion', async () => {
    const { deps } = setup();
    deps.log = vi.fn(async () => {
      throw new Error('log down');
    });
    expect((await handleWebhook(req(), deps)).status).toBe(200);
  });

  it('a processing failure returns 500 so the sender retries', async () => {
    const { deps } = setup(vi.fn(async () => {
      throw new Error('db down');
    }));
    const res = await handleWebhook(req(), deps);
    expect(res.status).toBe(500);
    expect(res.body.results).toEqual([{ status: 'error' }]);
  });
});
