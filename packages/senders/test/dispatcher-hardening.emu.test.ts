import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, Store } from '@datahash/store';
import { processSale, type IngestTenant } from '@datahash/ingest';
import { clearGoogleTokenCache, dispatchDue, MAX_ATTEMPTS, MAX_CLAIMS, NOT_CONNECTED_RETRY_MIN, sendBlockReason, type SendPolicy } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
const box = new SecretBox(SecretBox.generateKey());

afterAll(async () => {
  if (emulator) await db.terminate();
});

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body }) as unknown as Response;

let clock = new Date();
const now = () => clock;
const advance = (min: number) => {
  clock = new Date(clock.getTime() + min * 60_000);
};

function setup() {
  const tenantId = `dh-${randomUUID()}`;
  const store = new Store(db, { tenantId });
  const sales = new SalesRepo(db, { tenantId });
  const connections = new ConnectionsRepo(db, box, tenantId);
  const tenant: IngestTenant = {
    tenantId, consentPolicy: { mode: 'opt_in' }, allowedChannels: ['store'], destinations: ['meta'], defaultCountry: 'IN', sources: {},
  };
  return { tenantId, store, sales, connections, tenant };
}

const recordSale = (s: ReturnType<typeof setup>, eventId = 'deal-1') =>
  processSale(
    {
      source: 'zoho', eventId, eventName: 'Purchase', channel: 'store', occurredAt: new Date(clock.getTime() - 3_600_000),
      value: 85000, currency: 'INR', phone: '9876543210', email: 'priya@example.com', consent: true,
    },
    s.tenant,
    { store: s.store, sales: s.sales, now },
  );

const meta503 = () => vi.fn(async () => json({ error: { message: 'down' } }, 503));
const metaOk = () => vi.fn(async () => json({ events_received: 1 }));

describe.skipIf(!emulator)('dispatcher hardening (Firestore emulator)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
  });

  it('a sale withdrawn after it was queued is skipped at send time, and nothing is sent', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    expect((await s.sales.getSale(saleKey))?.identityKeys).toHaveLength(2);

    await s.store.withdraw({ phone: '9876543210' }, now()); // customer withdraws after the webhook was received
    const fetchImpl = metaOk();
    const summary = await dispatchDue({ ...s, http: { fetchImpl: fetchImpl as never }, now });

    expect(summary).toMatchObject({ withdrawn: 1, sent: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'skipped', skipReason: 'consent_withdrawn', attempts: 0 });
  });

  it('a customer who withdrew BEFORE the sale arrives is never queued for sending', async () => {
    const s = setup();
    await s.store.withdraw({ email: 'priya@example.com' }, now());
    const result = await recordSale(s);
    expect(result.deliveries).toEqual([{ destination: 'meta', status: 'skipped', reason: 'consent_withdrawn' }]);
  });

  it('a suspended brand sends nothing, even in a run that is already under way', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    await recordSale(s, 'A');
    await recordSale(s, 'B');
    await recordSale(s, 'C');

    const fetchImpl = metaOk();
    let calls = 0;
    // Active for the first delivery (it is looked at twice: early, and again just before the request), then the brand is
    // suspended mid-run.
    const tenantActive = async () => ++calls <= 2;
    const summary = await dispatchDue({ ...s, http: { fetchImpl: fetchImpl as never }, now, tenantActive });
    expect(summary).toMatchObject({ sent: 1, suspended: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const none = await dispatchDue({ ...s, http: { fetchImpl: fetchImpl as never }, now, tenantActive: async () => false });
    expect(none).toMatchObject({ suspended: true, considered: 0, sent: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waiting for a connection does not use up retries: the first real failure afterwards still retries', async () => {
    const s = setup();
    const { saleKey } = await recordSale(s);
    const deps = { ...s, http: { fetchImpl: meta503() as never }, now };

    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      await dispatchDue(deps);
      advance(16);
    }
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'retry', attempts: 0 });

    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    await dispatchDue(deps); // the first real send hits a 503
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'retry', attempts: 1 });
  });

  it("a worker that finishes after another took over is discarded and cannot overwrite the result", async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);

    let takeover: string | null = null;
    // While the slow worker is "talking to Meta", its lease expires and a second worker takes the delivery.
    const slowFetch = vi.fn(async () => {
      const later = new Date(clock.getTime() + 5 * 60_000);
      takeover = await s.sales.claimDelivery(saleKey, 'meta', later);
      return json({ events_received: 1 });
    });
    const summary = await dispatchDue({ ...s, http: { fetchImpl: slowFetch as never }, now });

    expect(takeover).toEqual(expect.any(String));
    expect(summary.lostLease).toBe(1);
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sending', leaseOwner: takeover });
  });

  it('gives up on a delivery that keeps crashing workers', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    await db.collection('tenants').doc(s.tenantId).collection('sales').doc(saleKey).collection('deliveries').doc('meta').update({ claims: MAX_CLAIMS });

    const fetchImpl = metaOk();
    const summary = await dispatchDue({ ...s, http: { fetchImpl: fetchImpl as never }, now });
    expect(summary.failed).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'failed' });
    expect((await s.sales.getDeliveries(saleKey))[0]?.lastError).toContain('too_many_claims');
  });

  it('an unreadable success reply is retried, then confirmed on the next try', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const bad = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('not json'); } }) as unknown as Response);

    await dispatchDue({ ...s, http: { fetchImpl: bad as never }, now });
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'retry', attempts: 1 });
    advance(2);
    await dispatchDue({ ...s, http: { fetchImpl: metaOk() as never }, now });
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });
});

describe.skipIf(!emulator)('the send switch (Firestore emulator)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
  });

  const withPolicy = (s: ReturnType<typeof setup>, policy: SendPolicy) => ({ ...s, sendBlocked: (d?: string) => sendBlockReason(policy, s.tenantId, d) });

  it('when off, nothing leaves the server and the queue is left exactly as it was', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const fetchImpl = metaOk();

    const summary = await dispatchDue({ ...withPolicy(s, { enabled: false }), http: { fetchImpl: fetchImpl as never }, now });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ considered: 0, sent: 0, blocked: 1, blockedReason: expect.stringContaining('switched off') });
    // untouched: still pending, never claimed, no attempt counted
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'pending', attempts: 0, claims: 0 });
  });

  it('switching it on afterwards sends what was waiting, once', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const fetchImpl = metaOk();

    await dispatchDue({ ...withPolicy(s, { enabled: false }), http: { fetchImpl: fetchImpl as never }, now });
    const on = await dispatchDue({ ...withPolicy(s, { enabled: true }), http: { fetchImpl: fetchImpl as never }, now });
    expect(on).toMatchObject({ sent: 1, blocked: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sent' });

    const again = await dispatchDue({ ...withPolicy(s, { enabled: true }), http: { fetchImpl: fetchImpl as never }, now });
    expect(again.considered).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a brand that is not on the allowed list sends nothing, even with sending on', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    await recordSale(s);
    const fetchImpl = metaOk();
    const summary = await dispatchDue({ ...withPolicy(s, { enabled: true, tenants: ['someone-else'] }), http: { fetchImpl: fetchImpl as never }, now });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sent: 0, blocked: 1, blockedReason: expect.stringContaining('not on the list') });
  });

  it('only the allowed platforms are sent to; the other waits untouched', async () => {
    const s = setup();
    s.tenant.destinations = ['meta', 'google_ads'];
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const fetchImpl = metaOk();

    const summary = await dispatchDue({ ...withPolicy(s, { enabled: true, destinations: ['meta'] }), http: { fetchImpl: fetchImpl as never }, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('facebook.com');
    expect(summary).toMatchObject({ sent: 1, blocked: 1 });
    const byDestination = Object.fromEntries((await s.sales.getDeliveries(saleKey)).map((d) => [d.destination, d]));
    expect(byDestination.meta).toMatchObject({ status: 'sent' });
    expect(byDestination.google_ads).toMatchObject({ status: 'pending', attempts: 0, claims: 0 });
  });

  it('a block placed after the run started stops the rest of it', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    await recordSale(s, 'd1');
    await recordSale(s, 'd2');
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls++; return json({ events_received: 1 }); });
    const summary = await dispatchDue({ ...s, sendBlocked: () => (calls >= 1 ? 'switched off now' : null), http: { fetchImpl: fetchImpl as never }, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ sent: 1, blocked: 1, blockedReason: 'switched off now' });
  });
});

describe.skipIf(!emulator)('waiting for a connection does not use up the claim limit (Firestore emulator)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
  });

  it('a delivery can wait through far more runs than MAX_CLAIMS, then sends once connected', async () => {
    const s = setup();
    const { saleKey } = await recordSale(s);
    const fetchImpl = metaOk();

    for (let i = 0; i < MAX_CLAIMS + 10; i++) {
      advance(NOT_CONNECTED_RETRY_MIN + 1);
      const r = await dispatchDue({ ...s, http: { fetchImpl: fetchImpl as never }, now });
      expect(r.notConnected).toBe(1);
    }
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'retry', attempts: 0, claims: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();

    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    advance(NOT_CONNECTED_RETRY_MIN + 1);
    expect(await dispatchDue({ ...s, http: { fetchImpl: fetchImpl as never }, now })).toMatchObject({ sent: 1, failed: 0 });
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sent' });
  });

  it('retries with real attempts also reset the count, so only crash loops reach the limit', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    await dispatchDue({ ...s, http: { fetchImpl: meta503() as never }, now });
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'retry', attempts: 1, claims: 0 });
  });
});

describe.skipIf(!emulator)('stopping a run that is under way (Firestore emulator)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
  });

  it('a pause placed while a run is sending stops it at the next delivery, and the rest stay queued', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const keys = [];
    for (const id of ['p1', 'p2', 'p3']) keys.push((await recordSale(s, id)).saleKey);
    let paused = false;
    const fetchImpl = vi.fn(async () => {
      paused = true; // the operator presses Pause while the first send is on its way
      return json({ events_received: 1 });
    });
    const summary = await dispatchDue({ ...s, sendBlocked: async () => (paused ? 'Sending is paused by an operator.' : null), http: { fetchImpl: fetchImpl as never }, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the one already on its way completed; nothing after it was started
    expect(summary).toMatchObject({ sent: 1, blocked: 2, blockedReason: 'Sending is paused by an operator.' });
    const statuses = await Promise.all(keys.map(async (k) => (await s.sales.getDeliveries(k))[0]!.status));
    expect(statuses.filter((x) => x === 'sent')).toHaveLength(1);
    expect(statuses.filter((x) => x === 'pending')).toHaveLength(2);
  });

  it('a brand suspended during a run stops it at the next delivery', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    await recordSale(s, 's1');
    await recordSale(s, 's2');
    let active = true;
    const fetchImpl = vi.fn(async () => {
      active = false;
      return json({ events_received: 1 });
    });
    const summary = await dispatchDue({ ...s, tenantActive: async () => active, http: { fetchImpl: fetchImpl as never }, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(summary.suspended).toBe(true);
  });
});

describe.skipIf(!emulator)('the final check before each send (Firestore emulator)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
  });

  it('a pause that lands after the early check but before the request still stops it, and the delivery is given back untouched', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const fetchImpl = metaOk();
    const gateCalls: string[] = [];

    const summary = await dispatchDue({
      ...s,
      sendBlocked: async () => null, // the early (cached) look says allowed
      sendGate: async (d) => { gateCalls.push(d); return 'Sending is paused by an operator. Nothing was sent.'; }, // the live look says stop
      http: { fetchImpl: fetchImpl as never },
      now,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gateCalls).toEqual(['meta']);
    expect(summary).toMatchObject({ considered: 0, sent: 0, blocked: 1, blockedReason: expect.stringContaining('paused') });
    // exactly as it was: waiting, no attempt counted, nothing claimed
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'pending', attempts: 0, claims: 0 });
  });

  it('what was given back goes out normally once sending is allowed again, once', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const fetchImpl = metaOk();
    await dispatchDue({ ...s, sendGate: async () => 'paused', http: { fetchImpl: fetchImpl as never }, now });
    const again = await dispatchDue({ ...s, sendGate: async () => null, http: { fetchImpl: fetchImpl as never }, now });
    expect(again).toMatchObject({ sent: 1, blocked: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('a pause pressed while one request is on its way lets that one finish and starts none after it', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const keys = [];
    for (const id of ['g1', 'g2', 'g3', 'g4']) keys.push((await recordSale(s, id)).saleKey);
    let paused = false;
    const fetchImpl = vi.fn(async () => {
      paused = true; // pressed while the first request is in flight
      return json({ events_received: 1 });
    });
    // the early look is stale (cached) and keeps saying "allowed": only the live final look knows
    const summary = await dispatchDue({ ...s, sendBlocked: async () => null, sendGate: async () => (paused ? 'paused' : null), http: { fetchImpl: fetchImpl as never }, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ sent: 1, blocked: 3, considered: 1 });
    const statuses = await Promise.all(keys.map(async (k) => (await s.sales.getDeliveries(k))[0]!.status));
    expect(statuses.filter((x) => x === 'sent')).toHaveLength(1);
    expect(statuses.filter((x) => x === 'pending')).toHaveLength(3);
  });

  it('a brand suspended after the early check is caught at the last moment too, and the delivery waits', async () => {
    const s = setup();
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const fetchImpl = metaOk();
    let asked = 0;
    const summary = await dispatchDue({ ...s, tenantActive: async () => ++asked === 1, http: { fetchImpl: fetchImpl as never }, now }); // active for the early look, suspended for the last
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ suspended: true, blocked: 1, sent: 0 });
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'pending', attempts: 0, claims: 0 });
  });

  it('it is not consulted for things that are never sent: a withdrawn customer and a missing connection', async () => {
    const s = setup();
    await recordSale(s, 'no-connection');
    let gateCalls = 0;
    const summary = await dispatchDue({ ...s, sendGate: async () => { gateCalls++; return null; }, http: { fetchImpl: metaOk() as never }, now });
    expect(summary.notConnected).toBe(1);
    expect(gateCalls).toBe(0);
  });
});
