import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, Store } from '@datahash/store';
import { processSale, type IngestTenant } from '@datahash/ingest';
import { clearGoogleTokenCache, dispatchDue, MAX_ATTEMPTS, RETRY_DELAYS_MIN } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
const box = new SecretBox(SecretBox.generateKey());

afterAll(async () => {
  if (emulator) await db.terminate();
});

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let clock = new Date();
const now = () => clock;
const advance = (min: number) => {
  clock = new Date(clock.getTime() + min * 60_000);
};

function setup() {
  const tenantId = `disp-${randomUUID()}`;
  const store = new Store(db, { tenantId });
  const sales = new SalesRepo(db, { tenantId });
  const connections = new ConnectionsRepo(db, box, tenantId);
  const tenant: IngestTenant = {
    tenantId,
    consentPolicy: { mode: 'opt_in' },
    allowedChannels: ['store'],
    destinations: ['meta', 'google_ads'],
    defaultCountry: 'IN',
    sources: {},
  };
  return { tenantId, store, sales, connections, tenant };
}

async function recordStoreSale(s: ReturnType<typeof setup>, eventId = 'deal-1') {
  return processSale(
    {
      source: 'zoho',
      eventId,
      eventName: 'Purchase',
      channel: 'store',
      occurredAt: new Date(clock.getTime() - 3_600_000),
      value: 85000,
      currency: 'INR',
      phone: '9876543210',
      email: 'priya@example.com',
      consent: true,
    },
    s.tenant,
    { store: s.store, sales: s.sales, now },
  );
}

const app = { clientId: 'cid', clientSecret: 'cs' };

describe.skipIf(!emulator)('dispatchDue (Firestore emulator, fake Meta/Google)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
  });

  function fakePlatforms(handlers: { meta?: () => Response; google?: () => Response } = {}) {
    return vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('graph.facebook.com')) return (handlers.meta ?? (() => json({ events_received: 1 })))();
      if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'AT', expires_in: 3600 });
      return (handlers.google ?? (() => json({ requestId: 'REQ-1' })))();
    });
  }

  async function connectBoth(s: ReturnType<typeof setup>) {
    await s.connections.set('meta', { datasetId: '999' }, 'META-TOKEN');
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77' }, 'G-REFRESH');
  }

  it('sends a pending sale to both platforms, using the click found from the website visit', async () => {
    const s = setup();
    await connectBoth(s);
    await s.store.identify({
      phone: '9876543210',
      consent: { ads: true },
      touches: [{ clickedAt: new Date(clock.getTime() - 5 * 86_400_000), gclid: 'G-click', fbclid: 'F-click' }],
      now: clock,
    });
    const { saleKey } = await recordStoreSale(s);

    const fetchImpl = fakePlatforms();
    const summary = await dispatchDue({ ...s, google: app, http: { fetchImpl: fetchImpl as never }, now });
    expect(summary).toMatchObject({ considered: 2, sent: 2, failed: 0, retried: 0 });

    const metaCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('graph.facebook.com')) as unknown as [string, RequestInit];
    const metaEvent = JSON.parse(metaCall[1].body as string).data[0];
    expect(metaEvent).toMatchObject({ event_id: 'deal-1', action_source: 'physical_store' });
    expect(metaEvent.user_data.fbc).toMatch(/\.F-click$/);

    const googleCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('datamanager.googleapis.com')) as unknown as [string, RequestInit];
    expect(JSON.parse(googleCall[1].body as string).events[0]).toMatchObject({ adIdentifiers: { gclid: 'G-click' }, transactionId: 'deal-1', eventSource: 'IN_STORE' });

    const deliveries = await s.sales.getDeliveries(saleKey);
    expect(deliveries.every((d) => d.status === 'sent' && d.attempts === 1 && d.sentAt)).toBe(true);
    expect(await s.sales.listDueDeliveries(now())).toEqual([]);
  });

  it('is safe to run twice: nothing is sent again', async () => {
    const s = setup();
    await connectBoth(s);
    await recordStoreSale(s);
    const fetchImpl = fakePlatforms();
    await dispatchDue({ ...s, google: app, http: { fetchImpl: fetchImpl as never }, now });
    const calls = fetchImpl.mock.calls.length;
    const again = await dispatchDue({ ...s, google: app, http: { fetchImpl: fetchImpl as never }, now });
    expect(again.considered).toBe(0);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('two workers at once: only one sends each delivery', async () => {
    const s = setup();
    await connectBoth(s);
    await recordStoreSale(s);
    const fetchImpl = fakePlatforms();
    const run = () => dispatchDue({ ...s, google: app, http: { fetchImpl: fetchImpl as never }, now });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.sent + b.sent).toBe(2);
    expect(a.lostClaim + b.lostClaim).toBeGreaterThanOrEqual(0);
    const metaCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes('graph.facebook.com')).length;
    expect(metaCalls).toBe(1);
  });

  it('retries a temporary failure on a schedule, then succeeds', async () => {
    const s = setup();
    await connectBoth(s);
    const { saleKey } = await recordStoreSale(s);
    let metaOk = false;
    const fetchImpl = fakePlatforms({
      meta: () => (metaOk ? json({ events_received: 1 }) : json({ error: { code: 4, message: 'rate limit' } }, 400)),
    });
    const deps = { ...s, google: app, http: { fetchImpl: fetchImpl as never }, now };

    expect(await dispatchDue(deps)).toMatchObject({ sent: 1, retried: 1 });
    const meta1 = (await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'meta')!;
    expect(meta1).toMatchObject({ status: 'retry', attempts: 1 });
    expect(meta1.lastError).toContain('rate limit');

    expect((await dispatchDue(deps)).considered).toBe(0); // not due yet
    advance(RETRY_DELAYS_MIN[0]! + 0.1);
    metaOk = true;
    expect(await dispatchDue(deps)).toMatchObject({ sent: 1 });
    const meta2 = (await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'meta')!;
    expect(meta2).toMatchObject({ status: 'sent', attempts: 2 });
    expect(meta2.lastError).toBeUndefined();
  });

  it('gives up after the last retry and says why', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'META-TOKEN');
    const { saleKey } = await recordStoreSale(s);
    const fetchImpl = fakePlatforms({ meta: () => json({ error: { message: 'down' } }, 503) });
    const deps = { ...s, http: { fetchImpl: fetchImpl as never }, now };

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await dispatchDue(deps);
      advance(24 * 60);
    }
    const meta = (await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'meta')!;
    expect(meta.status).toBe('failed');
    expect(meta.attempts).toBe(MAX_ATTEMPTS);
    expect(meta.lastError).toContain('gave up after');
  });

  it('a rejected token fails the delivery and flags the connection for the admin; resending after a fix works', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'OLD-TOKEN');
    const { saleKey } = await recordStoreSale(s);

    const bad = fakePlatforms({ meta: () => json({ error: { code: 190, message: 'Invalid OAuth access token' } }, 400) });
    await dispatchDue({ ...s, http: { fetchImpl: bad as never }, now });
    expect((await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'meta')?.status).toBe('failed');
    expect(await s.connections.get('meta')).toMatchObject({ status: 'error' });

    await s.connections.set('meta', { datasetId: '999' }, 'NEW-TOKEN'); // admin reconnects: status resets to active
    expect(await s.connections.get('meta')).toMatchObject({ status: 'active' });
    expect(await s.sales.resetDelivery(saleKey, 'meta', now())).toBe(true);

    const good = fakePlatforms();
    await dispatchDue({ ...s, http: { fetchImpl: good as never }, now });
    expect((await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'meta')?.status).toBe('sent');
    const used = good.mock.calls.find(([u]) => String(u).includes('graph.facebook.com'))![0];
    expect(String(used)).toContain('NEW-TOKEN');
  });

  it('waits without using up attempts while a brand has not connected an account', async () => {
    const s = setup();
    const { saleKey } = await recordStoreSale(s);
    const fetchImpl = fakePlatforms();
    const deps = { ...s, google: app, http: { fetchImpl: fetchImpl as never }, now };

    expect(await dispatchDue(deps)).toMatchObject({ notConnected: 2, sent: 0, failed: 0 });
    for (let i = 0; i < 10; i++) {
      advance(16);
      await dispatchDue(deps);
    }
    const deliveries = await s.sales.getDeliveries(saleKey);
    expect(deliveries.every((d) => d.status === 'retry' && d.lastError?.startsWith('not_connected'))).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    await connectBoth(s);
    advance(16);
    expect(await dispatchDue(deps)).toMatchObject({ sent: 2 });
  });

  it('fails a delivery that aged out of the platform window while it waited', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'META-TOKEN');
    const { saleKey } = await recordStoreSale(s);
    advance(70 * 24 * 60); // 70 days later: past Meta's offline window
    const fetchImpl = fakePlatforms();
    await dispatchDue({ ...s, http: { fetchImpl: fetchImpl as never }, now });
    const meta = (await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'meta')!;
    expect(meta.status).toBe('failed');
    expect(meta.lastError).toContain('too_old');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a token that cannot be decrypted (key changed) fails that delivery clearly instead of crashing the run', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'META-TOKEN');
    const { saleKey } = await recordStoreSale(s);
    const otherKey = new ConnectionsRepo(db, new SecretBox(SecretBox.generateKey()), s.tenantId);
    const fetchImpl = fakePlatforms();
    const summary = await dispatchDue({ ...s, connections: otherKey, http: { fetchImpl: fetchImpl as never }, now });
    expect(summary.failed).toBeGreaterThan(0);
    const meta = (await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'meta')!;
    expect(meta.status).toBe('failed');
    expect(meta.lastError).toContain('secret_unreadable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a missing Google OAuth client clearly', async () => {
    const s = setup();
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77' }, 'RT');
    const { saleKey } = await recordStoreSale(s);
    await dispatchDue({ ...s, http: { fetchImpl: fakePlatforms() as never }, now });
    const g = (await s.sales.getDeliveries(saleKey)).find((d) => d.destination === 'google_ads')!;
    expect(g.status).toBe('failed');
    expect(g.lastError).toContain('google_oauth_client_not_configured');
  });
});
