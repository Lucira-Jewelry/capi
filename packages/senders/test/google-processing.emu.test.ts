import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, Store } from '@datahash/store';
import { processSale, type IngestTenant } from '@datahash/ingest';
import { clearGoogleTokenCache, dispatchDue, PROCESSING_GIVE_UP_MIN, reconcileProcessing } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
const box = new SecretBox(SecretBox.generateKey());

afterAll(async () => {
  if (emulator) await db.terminate();
});

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body }) as unknown as Response;
const app = { clientId: 'cid', clientSecret: 'cs' };

let clock = new Date();
const now = () => clock;
const advance = (min: number) => {
  clock = new Date(clock.getTime() + min * 60_000);
};

function setup() {
  const tenantId = `gp-${randomUUID()}`;
  const store = new Store(db, { tenantId });
  const sales = new SalesRepo(db, { tenantId });
  const connections = new ConnectionsRepo(db, box, tenantId);
  const tenant: IngestTenant = {
    tenantId, consentPolicy: { mode: 'opt_in' }, allowedChannels: ['store'], destinations: ['google_ads'], defaultCountry: 'IN', sources: {},
  };
  return { tenantId, store, sales, connections, tenant };
}

const recordSale = (s: ReturnType<typeof setup>) =>
  processSale(
    {
      source: 'zoho', eventId: 'deal-1', eventName: 'Purchase', channel: 'store', occurredAt: new Date(clock.getTime() - 3_600_000),
      value: 85000, currency: 'INR', phone: '9876543210', email: 'priya@example.com', consent: true,
    },
    s.tenant,
    { store: s.store, sales: s.sales, now },
  );

/** A fake Google: accepts uploads with a request ID, and answers status lookups with whatever `status` returns. */
function fakeGoogle(status: () => Response) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'AT', expires_in: 3600 });
    if (u.includes('requestStatus:retrieve')) return status();
    return json({ requestId: 'REQ-77' });
  });
}
const statusBody = (requestStatus: string, errors: Array<[string, number]> = [], warnings: Array<[string, number]> = []) =>
  json({
    requestStatusPerDestination: [
      {
        requestStatus,
        errorInfo: { errorCounts: errors.map(([reason, recordCount]) => ({ reason, recordCount: String(recordCount) })) },
        warningInfo: { warningCounts: warnings.map(([reason, recordCount]) => ({ reason, recordCount })) },
      },
    ],
  });

async function sendOne(s: ReturnType<typeof setup>, status: () => Response) {
  await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77' }, 'RT');
  const { saleKey } = await recordSale(s);
  const fetchImpl = fakeGoogle(status);
  const deps = { ...s, google: app, http: { fetchImpl: fetchImpl as never }, now };
  await dispatchDue(deps);
  return { saleKey, fetchImpl, deps };
}
const delivery = async (s: ReturnType<typeof setup>, saleKey: string) => (await s.sales.getDeliveries(saleKey))[0]!;

describe.skipIf(!emulator)('Google processing results (Firestore emulator)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
  });

  it('a send is "accepted, processing" with the request ID; nothing is asked of Google before the first check is due', async () => {
    const s = setup();
    const { saleKey, fetchImpl, deps } = await sendOne(s, () => statusBody('PROCESSING'));
    expect(await delivery(s, saleKey)).toMatchObject({ status: 'sent', externalRequestId: 'REQ-77', processingStatus: 'processing', processingChecks: 0 });

    advance(29);
    const early = await reconcileProcessing(deps);
    expect(early.checked).toBe(0);
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('requestStatus'))).toBe(false);
  });

  it('after Google finishes: processed, with warnings noted', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => statusBody('SUCCESS', [], [['SOME_FIELD_IGNORED', 1]]));
    advance(31);
    expect(await reconcileProcessing(deps)).toMatchObject({ checked: 1, success: 1 });
    expect(await delivery(s, saleKey)).toMatchObject({ status: 'sent', processingStatus: 'success', processingDetail: 'warnings: SOME_FIELD_IGNORED x1' });
    expect(await s.sales.listDueProcessing(new Date(clock.getTime() + 86_400_000))).toEqual([]); // finished: not asked again
  });

  it('a request Google accepted but then rejected shows up, with the reasons', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => statusBody('FAILED', [['INVALID_CONVERSION_ACTION_TYPE', 1]]));
    advance(31);
    expect(await reconcileProcessing(deps)).toMatchObject({ rejected: 1 });
    const d = await delivery(s, saleKey);
    expect(d).toMatchObject({ status: 'sent', processingStatus: 'rejected' });
    expect(d.processingDetail).toBe('rejected: INVALID_CONVERSION_ACTION_TYPE x1');
  });

  it('a partly rejected request is recorded as partial', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => statusBody('PARTIAL_SUCCESS', [['EVENT_TIME_INVALID', 2]]));
    advance(31);
    expect(await reconcileProcessing(deps)).toMatchObject({ partial: 1 });
    expect(await delivery(s, saleKey)).toMatchObject({ processingStatus: 'partial', processingDetail: 'rejected: EVENT_TIME_INVALID x2' });
  });

  it('still processing: checks back off from 30 minutes (x1.3, up to 60) and give up after 24 hours', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => statusBody('PROCESSING'));
    const waits: number[] = [];
    let last = clock.getTime();

    advance(31); // first check is due 30 minutes after sending
    for (let i = 0; i < 6; i++) {
      await reconcileProcessing(deps);
      const d = await delivery(s, saleKey);
      expect(d.processingStatus).toBe('processing');
      const next = d.processingNextCheckAt!.getTime();
      waits.push(Math.round((next - clock.getTime()) / 60_000));
      last = next;
      clock = new Date(last + 1000);
    }
    expect(waits).toEqual([39, 51, 60, 60, 60, 60]); // 30 x 1.3, x 1.3^2, then capped at 60

    // 24 hours after sending with no answer: stop asking and say so.
    advance(PROCESSING_GIVE_UP_MIN);
    await reconcileProcessing(deps);
    expect(await delivery(s, saleKey)).toMatchObject({ processingStatus: 'unknown', processingDetail: 'Google gave no result within 24 hours' });
  });

  it('a failed lookup is postponed, not treated as a result', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => json({ error: { status: 'UNAVAILABLE', message: 'later' } }, 503));
    advance(31);
    expect(await reconcileProcessing(deps)).toMatchObject({ checked: 1, success: 0, rejected: 0, stillProcessing: 1 });
    const d = await delivery(s, saleKey);
    expect(d.processingStatus).toBe('processing');
    expect(d.processingDetail).toContain('could not look up the result');
    expect(d.processingNextCheckAt!.getTime()).toBeGreaterThan(clock.getTime());
  });

  it('without a connected account the result cannot be looked up; it waits instead of failing', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => statusBody('SUCCESS'));
    await s.connections.remove('google_ads');
    advance(31);
    expect(await reconcileProcessing(deps)).toMatchObject({ checked: 0, stillProcessing: 1 });
    expect((await delivery(s, saleKey)).processingStatus).toBe('processing');
  });

  it('a dispatch run also checks results, and stats count each processing outcome', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => statusBody('FAILED', [['INVALID_CONVERSION_ACTION_TYPE', 1]]));
    advance(31);
    const run = await dispatchDue(deps);
    expect(run.diagnostics).toMatchObject({ checked: 1, rejected: 1 });
    const stats = await s.sales.stats(new Date(clock.getTime() - 86_400_000));
    expect(stats.processing).toEqual({ google_ads: { rejected: 1 } });
    expect(stats.deliveries.google_ads).toEqual({ sent: 1 });
    void saleKey;
  });

  it('resending clears the old result, and a new send starts tracking again', async () => {
    const s = setup();
    const { saleKey, deps } = await sendOne(s, () => statusBody('FAILED', [['INVALID_CONVERSION_ACTION_TYPE', 1]]));
    advance(31);
    await reconcileProcessing(deps);
    expect((await delivery(s, saleKey)).processingStatus).toBe('rejected');

    expect(await s.sales.resetDelivery(saleKey, 'google_ads', now())).toBe(true);
    expect(await delivery(s, saleKey)).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await delivery(s, saleKey)).processingStatus).toBeUndefined();

    await dispatchDue(deps);
    expect(await delivery(s, saleKey)).toMatchObject({ status: 'sent', processingStatus: 'processing', externalRequestId: 'REQ-77' });
  });

  it('Meta deliveries are not tracked this way (Meta answers at once)', async () => {
    const s = setup();
    s.tenant.destinations = ['meta'];
    await s.connections.set('meta', { datasetId: '999' }, 'TOKEN');
    const { saleKey } = await recordSale(s);
    const fetchImpl = vi.fn(async () => json({ events_received: 1 }));
    await dispatchDue({ ...s, google: app, http: { fetchImpl: fetchImpl as never }, now });
    expect(await delivery(s, saleKey)).toMatchObject({ status: 'sent' });
    expect((await delivery(s, saleKey)).processingStatus).toBeUndefined();
  });
});
