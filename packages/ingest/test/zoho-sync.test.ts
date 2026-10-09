import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ZOHO_MAPPING as M, syncZohoWonDeals, ZohoClient, type IngestTenant, type IncomingSale } from '../src';

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('ZohoClient', () => {
  const cfg = { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt' };

  it('refreshes the access token once and reuses it until it expires', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/oauth/v2/token')) return json({ access_token: 'AT', expires_in: 3600 });
      return json({ data: [{ id: '1' }], info: { more_records: false } });
    });
    const client = new ZohoClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    const query = { fields: ['id'], stageField: 'Stage', wonStages: ['Closed Won'], since: new Date('2026-10-06T00:00:00Z') };

    for await (const _ of client.fetchWonDeals(query)) void _;
    for await (const _ of client.fetchWonDeals(query)) void _;
    const tokenCalls = () => fetchImpl.mock.calls.filter(([u]) => String(u).includes('/oauth/v2/token')).length;
    expect(tokenCalls()).toBe(1);

    clock = 3600 * 1000; // past expiry
    for await (const _ of client.fetchWonDeals(query)) void _;
    expect(tokenCalls()).toBe(2);
  });

  it('sends a COQL query with the stage filter, uses the India hosts and the Zoho token header', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth') ? json({ access_token: 'AT', expires_in: 3600 }) : json({ data: [], info: {} }),
    );
    const client = new ZohoClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    for await (const _ of client.fetchWonDeals({
      fields: ['id', 'Amount'],
      stageField: 'Stage',
      wonStages: ["Closed Won", "Won's"],
      since: new Date('2026-10-06T00:00:00Z'),
    })) void _;

    const [tokenUrl] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(tokenUrl).toContain('https://accounts.zoho.in/oauth/v2/token');
    const [apiUrl, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(apiUrl).toBe('https://www.zohoapis.in/crm/v6/coql');
    expect((init.headers as Record<string, string>).authorization).toBe('Zoho-oauthtoken AT');
    const query = JSON.parse(init.body as string).select_query as string;
    expect(query).toContain('select id, Amount from Deals');
    expect(query).toContain("Stage in ('Closed Won', 'Won\\'s')");
    expect(query).toContain("Modified_Time >= '2026-10-06T00:00:00.000+00:00'");
    expect(query).toContain('limit 0, 200');
  });

  it('follows pages and treats 204 as empty', async () => {
    const pages = [
      json({ data: [{ id: 'a' }, { id: 'b' }], info: { more_records: true } }),
      json({ data: [{ id: 'c' }], info: { more_records: false } }),
    ];
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth') ? json({ access_token: 'AT', expires_in: 3600 }) : pages.shift()!,
    );
    const client = new ZohoClient({ ...cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    const ids: string[] = [];
    for await (const r of client.fetchWonDeals({ fields: ['id'], stageField: 'Stage', wonStages: ['Closed Won'], since: new Date() })) {
      ids.push(r.id as string);
    }
    expect(ids).toEqual(['a', 'b', 'c']);
    const second = (fetchImpl.mock.calls[2] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(second.body as string).select_query).toContain('limit 200, 200');

    const empty = new ZohoClient({
      ...cfg,
      fetchImpl: (async (u: string | URL | Request) =>
        String(u).includes('oauth') ? json({ access_token: 'AT' }) : ({ ok: true, status: 204 } as Response)) as unknown as typeof fetch,
    });
    const none: unknown[] = [];
    for await (const r of empty.fetchWonDeals({ fields: ['id'], stageField: 'Stage', wonStages: [], since: new Date() })) none.push(r);
    expect(none).toEqual([]);
  });

  it('throws on API errors', async () => {
    const client = new ZohoClient({ ...cfg, fetchImpl: (async () => json({}, 401)) as unknown as typeof fetch });
    await expect(client.accessToken()).rejects.toThrow('zoho_token_http_401');
  });
});

describe('syncZohoWonDeals', () => {
  const tenant: IngestTenant = {
    tenantId: 't',
    consentPolicy: { mode: 'opt_in' },
    allowedChannels: ['store'],
    destinations: ['meta'],
    defaultCountry: 'IN',
    sources: { zoho: M },
  };
  const good = (id: string) => ({
    id,
    Stage: 'Closed Won',
    Amount: '1000',
    Closing_Date: '2026-10-07',
    Sale_Channel: 'store',
    Contact_Name: { Mobile: '9876543210' },
  });

  it('runs fetched deals through the pipeline and counts new, duplicate and rejected ones', async () => {
    const seen = new Set<string>(['dup']);
    const recordSale = vi.fn(async (sale: { eventId: string }) => {
      const duplicate = seen.has(sale.eventId);
      seen.add(sale.eventId);
      return { saleKey: sale.eventId, duplicate };
    });
    const client = {
      async *fetchWonDeals() {
        yield good('new-1');
        yield good('dup');
        yield { ...good('bad'), Amount: 'tbd' };
        yield { ...good('boom') };
      },
    };
    const deps = {
      store: { lookupForSale: vi.fn(async () => null), isSuppressed: vi.fn(async () => false) },
      sales: {
        recordSale: vi.fn(async (sale: { eventId: string }, ...rest: unknown[]) => {
          if (sale.eventId === 'boom') throw new Error('db down');
          return recordSale(sale, ...(rest as []));
        }),
      },
    };
    const summary = await syncZohoWonDeals({
      client,
      tenant,
      since: new Date('2026-10-06'),
      deps: deps as never,
    });
    expect(summary).toEqual({ fetched: 4, newSales: 1, duplicates: 1, rejected: { invalid_amount: 1 }, errors: 1 });
  });

  it('needs a Zoho mapping', async () => {
    const noZoho: IngestTenant = { ...tenant, sources: {} };
    await expect(
      syncZohoWonDeals({ client: { async *fetchWonDeals() {} }, tenant: noZoho, since: new Date(), deps: {} as never }),
    ).rejects.toThrow('tenant_has_no_zoho_mapping');
  });
});

// keep the type import used
export type _Unused = IncomingSale;
