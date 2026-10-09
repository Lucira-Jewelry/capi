import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, Store } from '@datahash/store';
import { processSale, type IngestTenant } from '@datahash/ingest';
import { checkGoogleConnection, clearGoogleTokenCache, clearServiceAccountTokenCache, dispatchDue } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
const box = new SecretBox(SecretBox.generateKey());

afterAll(async () => {
  if (emulator) await db.terminate();
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const google = { serviceAccount: { client_email: 'sender@my-project.iam.gserviceaccount.com', private_key: privateKey } };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body }) as unknown as Response;

let clock = new Date();
const now = () => clock;
const advance = (min: number) => {
  clock = new Date(clock.getTime() + min * 60_000);
};

function setup() {
  const tenantId = `sa-${randomUUID()}`;
  const store = new Store(db, { tenantId });
  const sales = new SalesRepo(db, { tenantId });
  const connections = new ConnectionsRepo(db, box, tenantId);
  const tenant: IngestTenant = { tenantId, consentPolicy: { mode: 'opt_in' }, allowedChannels: ['store'], destinations: ['google_ads'], defaultCountry: 'IN', sources: {} };
  return { tenantId, store, sales, connections, tenant };
}
const recordSale = (s: ReturnType<typeof setup>) =>
  processSale(
    { source: 'zoho', eventId: 'deal-1', eventName: 'Purchase', channel: 'store', occurredAt: new Date(clock.getTime() - 3_600_000), value: 85000, currency: 'INR', phone: '9876543210', email: 'priya@example.com', consent: true },
    s.tenant,
    { store: s.store, sales: s.sales, now },
  );

describe.skipIf(!emulator)('service-account connections (Firestore emulator)', () => {
  beforeEach(() => {
    clock = new Date();
    clearGoogleTokenCache();
    clearServiceAccountTokenCache();
  });

  it('stores no secret for a service-account connection, and an OAuth one still needs a token', async () => {
    const s = setup();
    await s.connections.set('google_ads', { customerId: '123-456-7890', conversionActionId: '77', authMethod: 'service_account' });
    const raw = (await db.collection('tenants').doc(s.tenantId).collection('connections').doc('google_ads').get()).data()!;
    expect(raw.secret).toBeNull();
    expect(raw.authMethod).toBe('service_account');

    expect(await s.connections.get('google_ads')).toMatchObject({ authMethod: 'service_account', secretSet: false, status: 'active' });
    expect(await s.connections.getWithSecret('google_ads')).toEqual({
      settings: { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' },
      secret: '',
    });

    await expect(s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77' })).rejects.toThrow('secret_required');
    await expect(s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77', authMethod: 'magic' as never }, 't')).rejects.toThrow('invalid_auth_method');
    await expect(s.connections.set('meta', { datasetId: '1' })).rejects.toThrow('secret_required'); // Meta always needs a token
  });

  it('switching a connection between methods replaces the stored token', async () => {
    const s = setup();
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77' }, 'REFRESH');
    expect(await s.connections.get('google_ads')).toMatchObject({ secretSet: true });
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' });
    expect((await s.connections.getWithSecret('google_ads'))?.secret).toBe('');
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77' }, 'NEW-REFRESH');
    expect((await s.connections.getWithSecret('google_ads'))?.secret).toBe('NEW-REFRESH');
  });

  it('a sale is sent with the service account, then its processing result is looked up the same way', async () => {
    const s = setup();
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' });
    const { saleKey } = await recordSale(s);

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'SA-AT', expires_in: 3600 });
      if (u.includes('requestStatus:retrieve')) return json({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] });
      return json({ requestId: 'REQ-SA' });
    });
    const deps = { ...s, google, http: { fetchImpl: fetchImpl as never }, now };

    expect(await dispatchDue(deps)).toMatchObject({ sent: 1 });
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sent', externalRequestId: 'REQ-SA', processingStatus: 'processing' });
    const sendCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('events:ingest')) as unknown as [string, RequestInit];
    expect((sendCall[1].headers as Record<string, string>).authorization).toBe('Bearer SA-AT');

    advance(31);
    expect((await dispatchDue(deps)).diagnostics).toMatchObject({ checked: 1, success: 1 });
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ processingStatus: 'success' });
    // one login served the upload and the lookup
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('oauth2')).length).toBe(1);
  });

  it('a brand that has not added the service account yet: flagged with what to do, then fixed by resending', async () => {
    const s = setup();
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' });
    const { saleKey } = await recordSale(s);

    let allowed = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('oauth2.googleapis.com')) return json({ access_token: 'SA-AT', expires_in: 3600 });
      return allowed ? json({ requestId: 'REQ-OK' }) : json({ error: { status: 'PERMISSION_DENIED', message: 'User does not have access to the account' } }, 403);
    });
    const deps = { ...s, google, http: { fetchImpl: fetchImpl as never }, now };

    await dispatchDue(deps);
    const failed = (await s.sales.getDeliveries(saleKey))[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain(google.serviceAccount.client_email);
    expect(await s.connections.get('google_ads')).toMatchObject({ status: 'error' });

    allowed = true; // the brand adds the email; the operator rechecks and resends
    expect(await s.sales.resetDelivery(saleKey, 'google_ads', now())).toBe(true);
    await dispatchDue(deps);
    expect((await s.sales.getDeliveries(saleKey))[0]).toMatchObject({ status: 'sent', externalRequestId: 'REQ-OK' });
  });

  it('a server without the service account key fails the delivery with a clear message', async () => {
    const s = setup();
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' });
    const { saleKey } = await recordSale(s);
    await dispatchDue({ ...s, http: { fetchImpl: vi.fn() as never }, now }); // no `google` credentials at all
    expect((await s.sales.getDeliveries(saleKey))[0]?.lastError).toContain('service_account_not_configured');
  });

  it('Check connection works with the service account and says what the server lacks', async () => {
    const s = setup();
    await s.connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (String(url).includes('oauth2') ? json({ access_token: 'SA-AT', expires_in: 3600 }) : json({ requestId: 'x' })));
    expect(await checkGoogleConnection({ connections: s.connections, google, http: { fetchImpl: fetchImpl as never } })).toMatchObject({ ok: true });
    expect(JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).validateOnly).toBe(true);

    expect(await checkGoogleConnection({ connections: s.connections })).toMatchObject({ ok: false, message: expect.stringContaining('GOOGLE_SERVICE_ACCOUNT_JSON') });
  });
});
