/**
 * A pretend brand website, for testing the first-party flow on your own machine, end to end.
 *
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/demo-site.ts
 *
 * Needs the emulator and the collector (npm run dev) running. It creates a brand whose tracking address is
 *   track.brand.localhost:8787   (the collector, reached under the brand's own name)
 * and serves the brand's page at
 *   http://brand.localhost:9000/?gclid=TEST-GCLID&fbclid=TEST-FBCLID
 * Chrome resolves *.localhost to your machine, so no DNS or hosts-file change is needed.
 * (Safari and Firefox may not; use Chrome for this.)
 */
import { createServer } from 'node:http';
import { createFirestore, TenantRegistry } from '@datahash/store';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set (this script is for the local emulator only).');
  process.exit(1);
}

const sitePort = Number(process.env.SITE_PORT ?? 9000);
const collectorPort = Number(process.env.PORT ?? 8787);
const trackingHost = `track.brand.localhost:${collectorPort}`;
const siteOrigin = `http://brand.localhost:${sitePort}`;
const collector = `http://127.0.0.1:${collectorPort}`;

const db = createFirestore();
const registry = new TenantRegistry(db, { cacheMs: 0 });
const created = await registry.createTenant({
  name: `First-Party Demo ${Math.random().toString(36).slice(2, 6)}`,
  origins: [siteOrigin],
  trackingHost: `track-${Math.random().toString(36).slice(2, 8)}.brand.localhost:${collectorPort}`,
  consentMode: 'opt_in',
});
const key = created.siteKey;
const host = (await registry.listSiteKeys(created.tenant.tenantId))[0]!.trackingHost!;
await db.terminate();
void trackingHost;

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo Jewellers (pretend brand site)</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 24px 16px 120px; color: #1d1d1f; }
  h1 { margin-bottom: 4px } .muted { color: #666 } .card { border: 1px solid #ddd; border-radius: 10px; padding: 16px; margin: 16px 0; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #aaa; background: #fff; cursor: pointer; }
  button.primary { background: #2557d6; color: #fff; border-color: #2557d6; }
  input { font: inherit; padding: 8px; border: 1px solid #bbb; border-radius: 8px; width: 100%; box-sizing: border-box; margin: 4px 0 12px; }
  pre { background: #f4f4f6; padding: 12px; border-radius: 8px; overflow: auto; font-size: 13px; }
  .banner { position: fixed; left: 0; right: 0; bottom: 0; background: #1d1d1f; color: #fff; padding: 14px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .banner[hidden] { display: none } code { background: #eee; padding: 1px 5px; border-radius: 4px; }
</style></head><body>
<h1>Demo Jewellers</h1>
<p class="muted">A pretend brand website. This page is <code>${siteOrigin}</code>; the tracking address is <code>${host}</code>.</p>

<div class="card"><h2>1. Land from an ad</h2>
  <p>Open this page with a click ID in the address, for example:</p>
  <p><a href="/?gclid=TEST-GCLID-123&fbclid=TEST-FBCLID-456&utm_source=google&utm_campaign=diwali">/?gclid=TEST-GCLID-123&amp;fbclid=TEST-FBCLID-456&amp;utm_source=google&amp;utm_campaign=diwali</a></p>
  <p class="muted">Then accept cookies in the bar at the bottom. Nothing is saved before that.</p></div>

<div class="card"><h2>2. Enquire</h2>
  <form id="enquiry"><label>Name<input name="name" value="Priya Sharma"></label>
  <label>Phone<input name="phone" type="tel" value="98765 43210"></label>
  <label>Email<input name="email" type="email" value="priya@example.com"></label>
  <button class="primary" type="submit">Book an appointment</button></form>
  <p id="enquiry-result" class="muted"></p></div>

<div class="card"><h2>3. Later, she buys in the store</h2>
  <p>The shop marks the deal Won in the CRM, which calls the brand's webhook. Pretend that happened:</p>
  <button id="sale">Simulate a store purchase for this phone</button>
  <p id="sale-result" class="muted"></p></div>

<div class="card"><h2>What is stored in this browser</h2>
  <button id="show">Refresh</button> <button id="withdraw">Withdraw consent</button>
  <pre id="state">(press Refresh)</pre></div>

<div class="banner" id="banner"><span>We use cookies to understand which ads brought you here.</span>
  <button class="primary" id="yes">Accept</button><button id="no">Decline</button></div>

<script src="http://${host}/tracker.js" data-key="${key}" data-endpoint="http://${host}" async></script>
<script>
  const $ = (id) => document.getElementById(id);
  const KEY = ${JSON.stringify(key)}, COLLECTOR = ${JSON.stringify(`http://${host}`)};
  // The cookie banner tells the tracker the visitor's choice.
  $('yes').onclick = () => { window.datahash.setConsent(true); $('banner').hidden = true; setTimeout(show, 400); };
  $('no').onclick = () => { window.datahash.setConsent(false); $('banner').hidden = true; setTimeout(show, 400); };
  $('enquiry').addEventListener('submit', async (e) => {
    e.preventDefault(); // the tracker already saw the submit (it listens in the capture phase)
    $('enquiry-result').textContent = 'Thanks! (the tracker has sent her phone and email, with the stored click, to the collector)';
    setTimeout(show, 600);
  });
  $('sale').onclick = async () => {
    const f = Object.fromEntries(new FormData($('enquiry')));
    const r = await fetch('/simulate-sale', { method: 'POST', body: JSON.stringify({ phone: f.phone, email: f.email }) });
    $('sale-result').textContent = JSON.stringify(await r.json());
  };
  $('withdraw').onclick = async () => { await window.datahash.withdraw({ phone: new FormData($('enquiry')).get('phone') }); setTimeout(show, 400); };
  $('show').onclick = show;
  async function show() {
    const out = { page: location.origin, trackingAddress: COLLECTOR, savedInThisBrowser: window.datahash ? window.datahash.touches() : 'script not loaded' };
    try {
      const r = await fetch(COLLECTOR + '/touch?key=' + KEY, { credentials: 'include' });
      out.firstPartyCookieHeldByServer = await r.json();
    } catch (err) { out.firstPartyCookieHeldByServer = 'could not reach the collector: ' + err.message; }
    out.readableCookiesOnThisPage = document.cookie || '(none; the server\\'s cookie is HttpOnly, so scripts cannot read it)';
    $('state').textContent = JSON.stringify(out, null, 2);
  }
  addEventListener('load', () => setTimeout(show, 800));
</script></body></html>`;

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/simulate-sale') {
    let raw = '';
    for await (const c of req) raw += c;
    const { phone, email } = JSON.parse(raw || '{}') as { phone?: string; email?: string };
    const r = await fetch(`${collector}/webhooks/${created.tenant.tenantId}/generic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': created.webhookSecret },
      body: JSON.stringify({ eventId: `DEMO-${Date.now()}`, channel: 'store', occurredAt: new Date().toISOString(), value: 85000, currency: 'INR', phone, email, store: 'Main Showroom', consent: true }),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await r.json()));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
server.listen(sitePort, () => {
  console.log(`
Brand:            ${created.tenant.name}  (${created.tenant.tenantId})
Tracking address: http://${host}
Brand site:       ${siteOrigin}/?gclid=TEST-GCLID-123&fbclid=TEST-FBCLID-456&utm_source=google&utm_campaign=diwali

Open the brand site in Chrome. Then look at the console: http://localhost:${collectorPort}/admin  (brand: ${created.tenant.name}).
`);
});
