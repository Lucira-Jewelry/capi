/** Read-only application probes and synthetic benchmarks. No external network or real customer data.
 * Run: node --import tsx scripts/audit-benchmark.ts
 */
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { evaluateDelivery, normalizeEmailForGoogle, hashPhoneForGoogle, hashPhoneForMeta, hashEmailForGoogle, hashEmailForMeta } from '@datahash/core';
import { buildMetaEvent, buildGoogleConversion, sendGoogle, dispatchDue, clearGoogleTokenCache } from '@datahash/senders';
import { mapGenericSale, redactRecord } from '@datahash/ingest';
import { SalesRepo, saleKey } from '../packages/store/src/sales';
import { handleIdentify } from '../packages/server/src/identify';
import { createTracker } from '../packages/tracker/src/tracker';

const now = new Date('2026-10-09T00:00:00Z');
const sale = { source: 'webhook', eventId: 'synthetic-order-1', eventName: 'Purchase', channel: 'store' as const, occurredAt: now, value: 100, currency: 'INR', personId: null, hashes: { metaEmail: 'a'.repeat(64), googleEmail: 'a'.repeat(64) }, consentAds: true };
const ctx = { saleKey: saleKey(sale.source, sale.eventId), sale, touch: null };
const settings = { customerId: '1234567890', conversionActionId: '42' };
const app = { clientId: 'synthetic', clientSecret: 'synthetic' };
const probes: Record<string, unknown> = {};
probes.metaWebsitePayload = buildMetaEvent({ ...ctx, sale: { ...sale, channel: 'online' } });
probes.googleLeadAndPurchaseUseSameAction = buildGoogleConversion(ctx, settings)?.conversionAction === buildGoogleConversion({ ...ctx, sale: { ...sale, eventName: 'Lead' } }, settings)?.conversionAction;
probes.googleGmailNormalization = { actual: normalizeEmailForGoogle('Jane.Doe+Shopping@gmail.com'), expectedByCurrentGuide: 'janedoe@gmail.com' };
probes.localSourceKeysDifferForSameBusinessOrder = saleKey('zoho', sale.eventId) !== saleKey('import', sale.eventId);
probes.genericDropsDirectClickId = mapGenericSale({ eventId: 'direct-click', channel: 'store', occurredAt: now.toISOString(), gclid: 'synthetic-gclid', consent: true });
probes.extraContactFieldsSurviveLogRedaction = redactRecord({ phone: 'synthetic', email: 'synthetic', customer: { email: 'synthetic-extra' } }, ['phone', 'email']);
probes.futureConversionEligibility = evaluateDelivery({ event: { ...sale, occurredAt: new Date(now.getTime() + 86400000) }, destination: 'meta', identity: { emailHash: 'a'.repeat(64) }, consent: { ads: true }, consentPolicy: { mode: 'opt_in' }, touches: [], allowedChannels: ['store'], now });
let identifyWrites = 0;
probes.withdrawalEndpoint = { response: await handleIdentify({ origin: 'https://synthetic.example', body: { key: 'synthetic', email: 'synthetic@example.com', consent: { ads: false } } }, { now: () => now, findSite: async () => ({ tenantId: 'synthetic', origins: ['https://synthetic.example'], consentMode: 'opt_in', retentionDays: 90, defaultCountry: 'IN' }), storeFor: () => ({ identify: async () => { identifyWrites++; return { status: 'ok', personId: 'synthetic', created: false, merged: false, touchesWritten: 0 }; } }) }), writes: identifyWrites };
clearGoogleTokenCache();
probes.googleMalformedSuccess = await sendGoogle(ctx, { settings, refreshToken: 'synthetic-refresh' }, app, { fetchImpl: async (url) => String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600 }), { status: 200 }) : new Response('not-json', { status: 200 }) });

const dom = new JSDOM('', { url: 'https://synthetic.example/?gclid=synthetic-gclid' });
for (const key of ['window', 'document', 'location', 'localStorage', 'sessionStorage']) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
const tracker = createTracker({ key: 'synthetic-site-a', endpoint: 'https://synthetic.invalid', autoBind: false, now: () => now.getTime() });
tracker.setConsent(true);
tracker.setConsent(false);
probes.browserStorageAfterWithdrawal = { localStorageRetained: dom.window.localStorage.getItem('dh_touches') !== null, cookieRetained: dom.window.document.cookie.includes('dh_t=') };
dom.reconfigure({ url: 'https://synthetic.example/another-site-without-click' });
const trackerB = createTracker({ key: 'synthetic-site-b', endpoint: 'https://synthetic.invalid', consentMode: 'opt_out', autoBind: false, now: () => now.getTime() });
probes.anotherSiteKeyReadsSameTouches = trackerB.touches().some(t => t.gclid === 'synthetic-gclid');
dom.window.close();

const dueDocs = Array.from({ length: 501 }, (_, i) => ({ data: () => ({ tenantId: 'synthetic', saleKey: String(i), destination: 'meta', status: i === 500 ? 'pending' : 'retry', attempts: 0, createdAt: { toDate: () => now }, updatedAt: { toDate: () => now }, nextRetryAt: { toDate: () => new Date(now.getTime() + 86400000) } }) }));
let queryLimit = dueDocs.length;
const query: any = { where: () => query, limit: (n: number) => { queryLimit = n; return query; }, get: async () => ({ docs: dueDocs.slice(0, queryLimit) }) };
const fakeDb: any = { collection: () => ({ doc: () => ({}) }), collectionGroup: () => query };
probes.queueStarvation = { dueBeyondFirst500: 1, returned: (await new SalesRepo(fakeDb, { tenantId: 'synthetic' }).listDueDeliveries(now)).length };

const timings: unknown[] = [];
let sink: unknown;
function measure(label: string, iterations: number, fn: () => unknown) {
  for (let i = 0; i < 1000; i++) sink = fn();
  const samples: number[] = [];
  for (let round = 0; round < 7; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sink = fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const medianMs = samples[3]!;
  timings.push({ label, iterations, rounds: 7, medianMs, operationsPerSecond: iterations / medianMs * 1000 });
}
measure('four platform contact hashes', 5000, () => [hashPhoneForMeta('+919876543210'), hashPhoneForGoogle('+919876543210'), hashEmailForMeta('synthetic@example.com'), hashEmailForGoogle('synthetic@gmail.com')]);
measure('eligibility with 50 touches', 10000, () => evaluateDelivery({ event: sale, destination: 'google_ads', identity: { emailHash: 'a'.repeat(64) }, consent: { ads: true }, consentPolicy: { mode: 'opt_in' }, allowedChannels: ['store'], now, touches: Array.from({ length: 50 }, (_, i) => ({ id: String(i), clickedAt: new Date(now.getTime() - (i + 1) * 1000), gclid: 'synthetic' })) }));
measure('both destination payload builders', 20000, () => [buildMetaEvent(ctx), buildGoogleConversion(ctx, settings)]);

const dispatchTimings: unknown[] = [];
for (const latencyMs of [5, 25, 100]) {
  let active = 0, maxConcurrent = 0, completed = 0;
  const deliveries = Array.from({ length: 50 }, (_, i) => ({ tenantId: 'synthetic', saleKey: String(i), destination: 'meta' as const, status: 'pending' as const, attempts: 0, createdAt: now, updatedAt: now }));
  const start = performance.now();
  const summary = await dispatchDue({
    now: () => now,
    sales: { listDueDeliveries: async () => deliveries, claimDelivery: async () => true, getSale: async () => ({ ...sale, createdAt: now }), completeDelivery: async () => { completed++; } } as any,
    store: { getTouch: async () => null },
    connections: { getWithSecret: async () => ({ settings: { datasetId: 'synthetic' }, secret: 'synthetic' }), markStatus: async () => {} } as any,
    http: { fetchImpl: async () => { active++; maxConcurrent = Math.max(active, maxConcurrent); await new Promise(resolve => setTimeout(resolve, latencyMs)); active--; return new Response(JSON.stringify({ events_received: 1 }), { status: 200 }); } },
  });
  const elapsedMs = performance.now() - start;
  dispatchTimings.push({ latencyMs, deliveries: 50, elapsedMs, deliveriesPerSecond: completed / elapsedMs * 1000, maxConcurrent, summary, excludes: 'Firestore, OAuth, external network, real platform processing' });
}
void sink;
const output = { auditDate: '2026-10-09', environment: { node: process.version, architecture: process.arch, platform: process.platform, cpu: cpus()[0]?.model }, syntheticOnly: true, probes, timings, dispatchTimings };
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/conversion-benchmark-results.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
