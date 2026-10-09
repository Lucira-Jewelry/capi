import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, SendControl, Store, TenantRegistry } from '@datahash/store';
import { eraseCustomer, processSale, withdrawCustomer } from '@datahash/ingest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkGoogleConnection, describeSendPolicy, dispatchDue, parseSendPolicy, parseServiceAccountKey, previewPayload, sendBlockReason, type DispatchSummary, type GoogleAppCredentials } from '@datahash/senders';
import { createHttpServer } from './http';
import { defaultCheckDeps } from './tracking-check';
import { assertProductionConfig } from './config';
import { KeyedCache } from './store-cache';
import { SerialQueue } from './serial';

// Refuse to start a real deployment with unsafe settings (emulator, development key, weak token, http address...).
try {
  assertProductionConfig(process.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

// ---- configuration (environment) -------------------------------------------------------------------------
// Nothing brand-specific lives here: brand settings, site keys, webhook secrets and ad-account connections are
// stored in Firestore and managed through the admin (see /admin).
const env = (name: string) => process.env[name]?.trim() || undefined;
const need = (name: string) => {
  const v = env(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
};

const secretsKey = need('SECRETS_KEY'); // 32 bytes, base64: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const adminToken = need('ADMIN_TOKEN'); // operator login for /admin
const internalToken = env('INTERNAL_TOKEN'); // lets a scheduler call POST /internal/dispatch
const publicUrl = env('PUBLIC_URL') ?? `http://localhost:${process.env.PORT ?? 8787}`;
// The product's Google credentials, from the Google Cloud project that has the Data Manager API enabled.
//  - Service account (recommended): GOOGLE_SERVICE_ACCOUNT_JSON (the key file's text) or GOOGLE_SERVICE_ACCOUNT_FILE (a path).
//    Brands add its email as a user on their Google Ads account, or link it through your manager account.
//  - OAuth client (optional, per-brand refresh tokens): GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
const serviceAccountText = env('GOOGLE_SERVICE_ACCOUNT_JSON') ?? (env('GOOGLE_SERVICE_ACCOUNT_FILE') ? readFileSync(env('GOOGLE_SERVICE_ACCOUNT_FILE')!, 'utf8') : undefined);
const parsedKey = serviceAccountText ? parseServiceAccountKey(serviceAccountText) : undefined;
if (parsedKey && !parsedKey.ok) throw new Error(`GOOGLE_SERVICE_ACCOUNT: ${parsedKey.error}`);
const serviceAccount = parsedKey?.ok ? parsedKey.key : undefined;
const oauthConfigured = Boolean(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
const google: GoogleAppCredentials | undefined =
  serviceAccount || oauthConfigured
    ? {
        ...(serviceAccount ? { serviceAccount } : {}),
        ...(oauthConfigured ? { clientId: env('GOOGLE_CLIENT_ID')!, clientSecret: env('GOOGLE_CLIENT_SECRET')! } : {}),
      }
    : undefined;

// Whether this server may send customer data to ad platforms at all. Off unless OUTBOUND_SENDS=on, and enforced in the
// dispatcher, so the scheduler and the "Send waiting sales now" button are both held back. See send-policy.ts.
const sendPolicy = parseSendPolicy(process.env);
console.log(
  sendPolicy.enabled
    ? `outbound sends: ON${sendPolicy.tenants ? ` for brands ${sendPolicy.tenants.join(', ')}` : ' for all brands'}${sendPolicy.destinations ? ` to ${sendPolicy.destinations.join(', ')}` : ''}`
    : 'outbound sends: OFF (set OUTBOUND_SENDS=on to send)',
);

// ---- wiring ----------------------------------------------------------------------------------------------
// Signs the first-party cookie. Derived from SECRETS_KEY unless COOKIE_SECRET is given, so one secret to manage by default.
const cookieSecret = env('COOKIE_SECRET') ?? createHmac('sha256', Buffer.from(secretsKey, 'base64')).update('first-party-cookie').digest('base64');

const db = createFirestore();
const registry = new TenantRegistry(db);
const box = new SecretBox(secretsKey);

const sendControl = new SendControl(db);
const stores = new KeyedCache((tenantId, retentionDays) => new Store(db, { tenantId, ...(retentionDays ? { retentionDays } : {}) }));
const salesRepos = new Map<string, SalesRepo>();
// Pass the brand's retention wherever something may be written about a person; without it the 90-day default applies.
const storeOf = (tenantId: string, retentionDays?: number) => stores.get(tenantId, retentionDays);
const salesOf = (tenantId: string) => {
  let s = salesRepos.get(tenantId);
  if (!s) {
    s = new SalesRepo(db, { tenantId });
    salesRepos.set(tenantId, s);
  }
  return s;
};
const connectionsOf = (tenantId: string) => new ConnectionsRepo(db, box, tenantId);

/** Why this brand may not send right now (the server's setting, then the operator's pause), or null. */
const sendBlockedFor = (tenantId: string, fresh = false) => async (destination?: string): Promise<string | null> => {
  const fromSettings = sendBlockReason(sendPolicy, tenantId, destination);
  if (fromSettings) return fromSettings;
  const pause = await sendControl.get({ fresh });
  return pause.paused ? `Sending is paused by an operator${pause.reason ? ` (${pause.reason})` : ''}. Nothing was sent.` : null;
};

const sendOverview = async () => {
  const pause = await sendControl.get();
  return {
    enabled: sendPolicy.enabled,
    paused: pause.paused,
    ...(pause.reason ? { reason: pause.reason } : {}),
    ...(pause.at ? { at: pause.at.toISOString() } : {}),
    ...(sendPolicy.tenants ? { tenants: sendPolicy.tenants } : {}),
    ...(sendPolicy.destinations ? { destinations: sendPolicy.destinations } : {}),
  };
};

// One dispatch run at a time on this instance: the scheduler and the console button can fire together, and two runs
// would mean two sends in flight, which is what "stop" is promised to bound.
const dispatchLane = new SerialQueue();

const dispatchTenant = (tenantId: string): Promise<DispatchSummary> =>
  dispatchLane.run(() => dispatchDue({
    sales: salesOf(tenantId),
    store: storeOf(tenantId),
    connections: connectionsOf(tenantId),
    google,
    sendBlocked: sendBlockedFor(tenantId),
    // The decision that counts: read live, immediately before each request (see DispatcherDeps.sendGate).
    sendGate: (destination) => sendBlockedFor(tenantId, true)(destination),
    // Asked before every delivery, straight from the database (not the short-lived cache): suspending a brand stops a
    // run that is already under way at its next delivery. A request already on its way to a platform cannot be recalled.
    tenantActive: async () => (await registry.getTenant(tenantId, { fresh: true }))?.status === 'active',
  }));

async function dispatchAll() {
  const results: Record<string, DispatchSummary> = {};
  for (const t of await registry.listTenants()) {
    if (t.status !== 'active') continue;
    const r = await dispatchTenant(t.tenantId);
    if (r.considered > 0) results[t.tenantId] = r;
  }
  return results;
}

const server = createHttpServer({
  trackerFile: env('TRACKER_FILE') ?? new URL('../../tracker/dist/tracker.js', import.meta.url).pathname,
  adminUiDir: env('ADMIN_UI_DIR') ?? new URL('../../admin-ui/dist', import.meta.url).pathname,
  findSite: async (key) => {
    const found = await registry.findSite(key);
    if (!found) return null;
    return {
      tenantId: found.tenant.tenantId,
      origins: found.site.origins,
      consentMode: found.tenant.consentPolicy.mode,
      retentionDays: found.tenant.retentionDays,
      defaultCountry: found.tenant.defaultCountry,
      ...(found.site.trackingHost ? { trackingHost: found.site.trackingHost } : {}),
    };
  },
  cookieSecret,
  storeFor: (site) => storeOf(site.tenantId, site.retentionDays),
  webhook: {
    getTenant: async (tenantId) => {
      const t = await registry.getTenant(tenantId);
      return t && t.status === 'active' ? t : null;
    },
    verifySecret: (tenantId, secret) => registry.verifyWebhookSecret(tenantId, secret),
    process: (tenant, sale) =>
      processSale(sale, tenant, { store: storeOf(tenant.tenantId, tenant.retentionDays), sales: salesOf(tenant.tenantId) }),
    log: (tenant, source, payload, outcome) => salesOf(tenant.tenantId).logIngest({ source, payload, outcome }),
  },
  admin: {
    adminToken,
    registry,
    connectionsFor: connectionsOf,
    salesFor: salesOf,
    processFor: (tenant, sale) =>
      processSale(sale, tenant, { store: storeOf(tenant.tenantId, tenant.retentionDays), sales: salesOf(tenant.tenantId) }),
    dispatchFor: dispatchTenant,
    // A local `*.localhost` tracking name is only reachable on a development server, never on a deployed one.
    trackingCheckDeps: defaultCheckDeps({ allowLocalNames: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(publicUrl) }),
    sendingFor: async (tenantId) => {
      const fromSettings = describeSendPolicy(sendPolicy, tenantId);
      if (!fromSettings.allowed) return fromSettings;
      const blocked = await sendBlockedFor(tenantId)();
      return blocked ? { allowed: false, reason: blocked } : fromSettings;
    },
    sendControl: {
      overview: sendOverview,
      setPaused: async (paused, reason) => {
        await sendControl.set(paused, reason);
        console.log(paused ? `sending PAUSED by an operator${reason ? `: ${reason}` : ''}` : 'sending resumed by an operator');
        return sendOverview();
      },
    },
    eraseFor: (tenant, contact) =>
      eraseCustomer({ store: storeOf(tenant.tenantId, tenant.retentionDays), sales: salesOf(tenant.tenantId) }, { ...contact, defaultCountry: tenant.defaultCountry }),
    googleInfo: { ...(serviceAccount ? { serviceAccountEmail: serviceAccount.client_email } : {}), oauthConfigured },
    previewFor: async (tenantId, saleKey, destination) => {
      const sale = await salesOf(tenantId).getSale(saleKey);
      const delivery = (await salesOf(tenantId).getDeliveries(saleKey)).find((d) => d.destination === destination);
      if (!sale || !delivery) return null;
      const touch = delivery.touchId && sale.personId ? await storeOf(tenantId).getTouch(sale.personId, delivery.touchId) : null;
      const conn = await connectionsOf(tenantId).getWithSecret(destination).catch(() => null);
      return previewPayload(destination, { saleKey, sale, touch }, conn?.settings ?? null);
    },
    checkGoogleFor: (tenantId) => checkGoogleConnection({ connections: connectionsOf(tenantId), google }),
    withdrawFor: (tenant, contact) =>
      withdrawCustomer({ store: storeOf(tenant.tenantId, tenant.retentionDays), sales: salesOf(tenant.tenantId) }, { ...contact, defaultCountry: tenant.defaultCountry }),
    publicUrl,
  },
  ...(internalToken ? { internal: { token: internalToken, dispatchAll } } : {}),
  trustedProxyHops: Number(env('TRUSTED_PROXY_HOPS') ?? 1),
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => console.log(`collector listening on :${port}  (admin: ${publicUrl}/admin)`));

// Cloud Run asks the container to stop with SIGTERM and gives it a few seconds: finish the requests in flight, then exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal}: shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

// For local development: send what is due every N seconds. In production use a scheduler (Cloud Scheduler)
// calling POST /internal/dispatch every minute.
const every = Number(env('DISPATCH_INTERVAL_SECONDS') ?? 0);
if (every > 0) {
  setInterval(() => {
    dispatchAll().then(
      (r) => Object.keys(r).length && console.log('dispatched', JSON.stringify(r)),
      (e) => console.error('dispatch failed', e instanceof Error ? e.message : e),
    );
  }, every * 1000);
}
