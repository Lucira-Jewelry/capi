/**
 * Fill the LOCAL Firestore emulator with demo brands and sales in every state, so the console has something to show.
 *
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/seed-demo.ts
 *
 * Refuses to run without the emulator host, so it can never write to a real database.
 * Nothing here talks to Meta or Google. The "Demo Jewellers" brand only has finished deliveries, so pressing
 * "Send waiting sales now" there does nothing; the "Pending Co" brand has no connections, so its sales just wait.
 */
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, Store, TenantRegistry } from '@datahash/store';
import { DEFAULT_ZOHO_MAPPING, processSale, type IncomingSale, type IngestTenant } from '@datahash/ingest';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set (this script is for the local emulator only).');
  process.exit(1);
}

const db = createFirestore();
const registry = new TenantRegistry(db, { cacheMs: 0 });
const box = new SecretBox(process.env.SECRETS_KEY ?? Buffer.from('dev-only-secrets-key-32-bytes!!!').toString('base64'));
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const jewellers = await registry.createTenant({
  name: 'Demo Jewellers',
  origins: ['https://demo-jewellers.example.com'],
  zoho: DEFAULT_ZOHO_MAPPING,
});
const pendingCo = await registry.createTenant({ name: 'Pending Co', origins: ['https://pending.example.com'], destinations: ['meta'] });

// ---- Demo Jewellers ------------------------------------------------------------------------------------------
{
  const tenant: IngestTenant = jewellers.tenant;
  const store = new Store(db, { tenantId: tenant.tenantId });
  const sales = new SalesRepo(db, { tenantId: tenant.tenantId });
  const connections = new ConnectionsRepo(db, box, tenant.tenantId);
  // Placeholder values: they are never used because nothing here is due to be sent.
  await connections.set('meta', { datasetId: '1234567890123456', testEventCode: 'TEST12345' }, 'PLACEHOLDER-NOT-A-REAL-TOKEN');
  await connections.set('google_ads', { customerId: '123-456-7890', conversionActionId: '987654321', authMethod: 'service_account' });

  // Two customers who clicked an ad and gave their number on the website before buying in the store.
  await store.identify({ phone: '98765 43210', email: 'priya@example.com', consent: { ads: true, source: 'enquiry-form' }, now: hoursAgo(120),
    touches: [{ clickedAt: hoursAgo(130), gclid: 'DEMO-GCLID-1', fbclid: 'DEMO-FBCLID-1', fbc: `fb.1.${hoursAgo(130).getTime()}.DEMO-FBCLID-1`, utm: { utm_source: 'google', utm_campaign: 'diwali' } }] });
  await store.identify({ phone: '98111 22233', consent: { ads: true }, now: hoursAgo(80), touches: [{ clickedAt: hoursAgo(90), fbclid: 'DEMO-FBCLID-2', fbc: `fb.1.${hoursAgo(90).getTime()}.DEMO-FBCLID-2` }] });
  await store.withdraw({ phone: '97000 11111' }, hoursAgo(3)); // someone who asked us to stop

  const sale = (over: Partial<IncomingSale> & Pick<IncomingSale, 'eventId'>): IncomingSale => ({
    source: 'zoho', eventName: 'Purchase', channel: 'store', occurredAt: hoursAgo(20), value: 50000, currency: 'INR', consent: true, storeName: 'Main Showroom', ...over,
  });
  const record = (s: IncomingSale) => processSale(s, tenant, { store, sales });
  const finish = async (saleKey: string, dest: 'meta' | 'google_ads', outcome: Parameters<SalesRepo['completeDelivery']>[2]) => {
    const token = (await sales.claimDelivery(saleKey, dest))!;
    await sales.completeDelivery(saleKey, dest, { ...outcome, leaseToken: token });
  };
  const sentGoogle = async (saleKey: string, processing: 'processing' | 'success' | 'rejected', detail?: string) => {
    await finish(saleKey, 'google_ads', { status: 'sent', response: 'accepted', requestId: `REQ-${saleKey.slice(0, 6)}`, processingNextCheckAt: new Date(Date.now() + 3_600_000) });
    if (processing !== 'processing') await sales.recordProcessing(saleKey, 'google_ads', { status: processing, checks: 1, ...(detail ? { detail } : {}) });
  };

  // 1. Matched to a website click, delivered everywhere and processed.
  const a = await record(sale({ eventId: 'INV-3001', value: 85000, phone: '98765 43210', email: 'priya@example.com', occurredAt: hoursAgo(6) }));
  await finish(a.saleKey, 'meta', { status: 'sent', response: 'events_received=1 trace=DEMO' });
  await sentGoogle(a.saleKey, 'success');
  // 2. Google accepted it and then rejected it.
  const b = await record(sale({ eventId: 'INV-3002', value: 42000, phone: '98111 22233', occurredAt: hoursAgo(12) }));
  await finish(b.saleKey, 'meta', { status: 'sent', response: 'events_received=1 trace=DEMO' });
  await sentGoogle(b.saleKey, 'rejected', 'rejected: INVALID_CONVERSION_ACTION_TYPE x1');
  // 3. Online sale: reported by the store platform's own apps, so skipped here.
  await record(sale({ eventId: 'INV-3003', channel: 'online', value: 1200, phone: '99000 00001', occurredAt: hoursAgo(14) }));
  // 4. The CRM says the customer did not consent.
  await record(sale({ eventId: 'INV-3004', value: 30000, phone: '99000 00002', consent: false, occurredAt: hoursAgo(16) }));
  // 5. Meta rejected the token; Google still waiting for its result.
  const e = await record(sale({ eventId: 'INV-3005', value: 61000, phone: '99000 00003', occurredAt: hoursAgo(18) }));
  await finish(e.saleKey, 'meta', { status: 'failed', error: 'meta 400 code 190: Invalid OAuth access token' });
  await sentGoogle(e.saleKey, 'processing');
  // 6. A WhatsApp sale: Meta had a temporary problem and will retry.
  const f = await record(sale({ eventId: 'INV-3006', channel: 'whatsapp', value: 18000, phone: '99000 00004', occurredAt: hoursAgo(9) }));
  await finish(f.saleKey, 'meta', { status: 'retry', error: 'meta 503: temporarily unavailable', nextRetryAt: new Date(Date.now() + 25 * 60_000) });
  await finish(f.saleKey, 'google_ads', { status: 'skipped', skipReason: 'no_identifiers' }).catch(() => undefined);
  // 7. Customer withdrew consent.
  await record(sale({ eventId: 'INV-3007', value: 24000, phone: '97000 11111', occurredAt: hoursAgo(2) }));

  // flag the Meta connection as needing attention, as it would after that rejected token
  await connections.markStatus('meta', 'error', 'meta 400 code 190: Invalid OAuth access token');
}

// ---- Pending Co: nothing connected, so its sales wait --------------------------------------------------------
{
  const tenant: IngestTenant = pendingCo.tenant;
  const store = new Store(db, { tenantId: tenant.tenantId });
  const sales = new SalesRepo(db, { tenantId: tenant.tenantId });
  for (const [i, v] of [12000, 34000, 56000].entries()) {
    await processSale(
      { source: 'import', eventId: `PC-${100 + i}`, eventName: 'Purchase', channel: 'store', occurredAt: hoursAgo(5 + i), value: v, currency: 'INR', phone: `9800000000${i}`, consent: true },
      tenant,
      { store, sales },
    );
  }
}

console.log(`Demo Jewellers: ${jewellers.tenant.tenantId}\nPending Co:     ${pendingCo.tenant.tenantId}`);
await db.terminate();
