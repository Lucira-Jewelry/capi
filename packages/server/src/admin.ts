import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Channel, CountryCode, Destination, TenantConfig, ZohoMapping } from '@datahash/core';
import {
  DEFAULT_ZOHO_MAPPING,
  IMPORT_COLUMNS,
  IMPORT_TEMPLATE,
  salesFromCsv,
  type IncomingSale,
  type ProcessResult,
} from '@datahash/ingest';
import type { DispatchSummary } from '@datahash/senders';
import type { EraseResult } from '@datahash/ingest';
import { installSnippets } from './snippets';
import { defaultCheckDeps, runTrackingCheck, type CheckDeps } from './tracking-check';
import { saleKey, type ConnectionsRepo, type SalesRepo, type TenantRegistry } from '@datahash/store';

const SHARED_CONTACT_MESSAGE = 'This phone or email is linked to many other contact details, which usually means a number or address shared by several people. Nothing was changed. Handle it by hand, or use a different detail for the customer.';

export interface SendingState {
  allowed: boolean;
  reason?: string;
  destinations?: string[];
}

export interface SendOverview {
  /** OUTBOUND_SENDS is "on" on this server. */
  enabled: boolean;
  /** An operator paused all sending from the console. */
  paused: boolean;
  reason?: string;
  at?: string;
  /** Limits from the server's settings, if any. */
  tenants?: string[];
  destinations?: string[];
}

export interface AdminDeps {
  /** Shared operator token (ADMIN_TOKEN). Brand self-service logins come later. */
  adminToken: string;
  registry: TenantRegistry;
  connectionsFor: (tenantId: string) => ConnectionsRepo;
  salesFor: (tenantId: string) => SalesRepo;
  processFor: (tenant: TenantConfig, sale: IncomingSale) => Promise<ProcessResult>;
  dispatchFor: (tenantId: string) => Promise<DispatchSummary>;
  /** Whether this server may send for the brand (the OUTBOUND_SENDS switch), so the console can say so. */
  sendingFor?: (tenantId: string) => SendingState | Promise<SendingState>;
  /** The server-wide send switch and the operator's pause. Without it the console has no pause button. */
  sendControl?: {
    overview(): Promise<SendOverview>;
    setPaused(paused: boolean, reason?: string): Promise<SendOverview>;
  };
  /** Erase one customer: website profile, clicks, and their details on sales. */
  eraseFor?: (tenant: TenantConfig, contact: { phone?: string; email?: string }) => Promise<EraseResult>;
  /** What the server can log in to Google with, so the console can tell the operator what to hand to a brand. */
  googleInfo?: { serviceAccountEmail?: string; oauthConfigured: boolean };
  /** DNS and HTTP used by "Check setup". Defaults to the real ones; tests pass fakes. */
  trackingCheckDeps?: CheckDeps;
  /** What would be sent for a delivery, built without sending and without secrets. */
  previewFor?: (tenantId: string, saleKey: string, destination: 'meta' | 'google_ads') => Promise<unknown | null>;
  /** Validate the saved Google connection without sending anything. */
  checkGoogleFor: (tenantId: string) => Promise<{ ok: boolean; message: string }>;
  /** Record a customer's withdrawal of consent (operator handling a privacy request). */
  withdrawFor: (tenant: TenantConfig, contact: { phone?: string; email?: string }) => Promise<{ keys: number; personFound: boolean }>;
  /** Public base URL of the collector, used to show the right script tag and webhook URLs. */
  publicUrl: string;
  now?: () => Date;
}

export interface AdminRequest {
  method: string;
  /** Path after /admin/api, e.g. /tenants/acme-1a2b3c/sales */
  path: string;
  query: URLSearchParams;
  body: unknown;
  token?: string | undefined;
}

export interface AdminResponse {
  status: number;
  body: unknown;
}

const CHANNELS: Channel[] = ['store', 'online', 'whatsapp', 'web_lead'];
const DESTINATIONS: Destination[] = ['meta', 'google_ads'];
const COUNTRIES: CountryCode[] = ['IN', 'US', 'GB', 'AE', 'SG'];

const ok = (body: unknown, status = 200): AdminResponse => ({ status, body });
const fail = (status: number, error: string, message?: string): AdminResponse => ({
  status,
  body: { error, ...(message ? { message } : {}) },
});

const digest = (s: string) => createHash('sha256').update(s).digest();
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const strList = (v: unknown, max = 50): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => str(x));

function origins(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 20) return null;
  const out: string[] = [];
  for (const o of v) {
    if (typeof o !== 'string') return null;
    try {
      const u = new URL(o.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      out.push(u.origin);
    } catch {
      return null;
    }
  }
  return [...new Set(out)];
}


// ---- import check -----------------------------------------------------------------------------------------------

const CHECK_TTL_MS = 30 * 60 * 1000;

/** Proof that this exact file was checked for this brand and came out clean. Signed, so it cannot be made up. */
function checkTokenFor(adminToken: string, tenantId: string, csv: string, at: number): string {
  const mac = createHmac('sha256', `import-check:${adminToken}`).update(`${tenantId}|${createHash('sha256').update(csv).digest('hex')}|${at}`).digest('hex');
  return `${at}.${mac}`;
}

function checkTokenProblem(adminToken: string, tenantId: string, csv: string, token: unknown, now: number): 'check_required' | 'check_outdated' | null {
  if (typeof token !== 'string' || !token) return 'check_required';
  const at = Number(token.split('.')[0]);
  if (!Number.isFinite(at) || now - at > CHECK_TTL_MS || at > now + 60_000) return 'check_outdated';
  const expected = Buffer.from(checkTokenFor(adminToken, tenantId, csv, at));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : 'check_outdated';
}

export interface ImportSummary {
  /** Valid rows in the file. Everything below, except `alreadyImported`, counts only the rows that will be added. */
  rows: number;
  /** Not recorded before: these will be added. */
  newSales: number;
  /** Already imported earlier: these are skipped, not counted twice. */
  alreadyImported: number;
  /** Rows with a phone or an email, which is what the ad platforms match on. */
  withContact: number;
  withoutContact: number;
  consent: { yes: number; no: number; notStated: number };
  /** Rows that also carry a name, a postal code, or both (better matching). */
  withName: number;
  withPostalCode: number;
  value: Record<string, number>;
  firstDate: string | null;
  lastDate: string | null;
}

async function summariseImport(sales: SalesRepo, rows: Array<{ sale?: IncomingSale }>): Promise<ImportSummary> {
  const list = rows.flatMap((r) => (r.sale ? [r.sale] : []));
  const out: ImportSummary = { rows: list.length, newSales: 0, alreadyImported: 0, withContact: 0, withoutContact: 0, consent: { yes: 0, no: 0, notStated: 0 }, withName: 0, withPostalCode: 0, value: {}, firstDate: null, lastDate: null };
  // Which rows will really be added: not recorded before, and not a repeat of an earlier row in the same file.
  const fresh: IncomingSale[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const existing = await Promise.all(chunk.map((sale) => sales.getSale(saleKey(sale.source, sale.eventId))));
    chunk.forEach((sale, j) => {
      const key = saleKey(sale.source, sale.eventId);
      if (existing[j] || seen.has(key)) out.alreadyImported++;
      else {
        out.newSales++;
        fresh.push(sale);
      }
      seen.add(key);
    });
  }
  // Everything below describes only the rows that will be added, so the confirmation never overstates the import.
  let first = Infinity;
  let last = -Infinity;
  for (const sale of fresh) {
    if (sale.phone || sale.email) out.withContact++;
    else out.withoutContact++;
    if (sale.consent === true) out.consent.yes++;
    else if (sale.consent === false) out.consent.no++;
    else out.consent.notStated++;
    if (sale.firstName && sale.lastName) out.withName++;
    if (sale.postalCode) out.withPostalCode++;
    if (sale.value !== undefined) {
      const cur = sale.currency ?? 'INR';
      out.value[cur] = Math.round(((out.value[cur] ?? 0) + sale.value) * 100) / 100;
    }
    first = Math.min(first, sale.occurredAt.getTime());
    last = Math.max(last, sale.occurredAt.getTime());
  }
  if (fresh.length) {
    out.firstDate = new Date(first).toISOString().slice(0, 10);
    out.lastDate = new Date(last).toISOString().slice(0, 10);
  }
  return out;
}

function subset<T extends string>(v: unknown, allowed: T[]): T[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.every((x) => allowed.includes(x as T)) ? ([...new Set(v)] as T[]) : null;
}

/** Returns a clean mapping or a message saying what is wrong. */
export function validateZohoMapping(v: unknown): ZohoMapping | string {
  if (!isObj(v)) return 'mapping must be an object';
  for (const key of ['dealId', 'amount', 'occurredAt', 'phone', 'channel'] as const) {
    if (!str(v[key])) return `${key} is required (a Zoho field name)`;
  }
  if (!strList(v.storeChannelValues) || (v.storeChannelValues as string[]).length === 0) {
    return 'storeChannelValues needs at least one value';
  }
  for (const key of ['stage', 'fallbackOccurredAt', 'email', 'firstName', 'lastName', 'city', 'state', 'postalCode', 'country', 'customerId', 'store', 'consent', 'currency', 'eventName', 'dateOnlyOffset'] as const) {
    if (v[key] !== undefined && !str(v[key])) return `${key} must be text`;
  }
  for (const key of ['wonStages', 'whatsappChannelValues', 'onlineChannelValues', 'consentTrueValues'] as const) {
    if (v[key] !== undefined && !strList(v[key])) return `${key} must be a list of text values`;
  }
  const keep = [
    'dealId', 'stage', 'wonStages', 'amount', 'occurredAt', 'fallbackOccurredAt', 'dateOnlyOffset', 'phone', 'email', 'firstName', 'lastName', 'city', 'state', 'postalCode', 'country', 'customerId', 'store',
    'channel', 'storeChannelValues', 'whatsappChannelValues', 'onlineChannelValues', 'consent', 'consentTrueValues', 'currency', 'eventName',
  ];
  return Object.fromEntries(keep.filter((k) => v[k] !== undefined).map((k) => [k, v[k]])) as unknown as ZohoMapping;
}

function tenantSettings(body: Record<string, unknown>): { patch: Partial<TenantConfig>; error?: string } {
  const patch: Partial<TenantConfig> = {};
  if (body.name !== undefined) {
    if (!str(body.name, 80)) return { patch, error: 'name must be 1-80 characters' };
    patch.name = body.name.trim();
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'suspended') return { patch, error: 'status must be active or suspended' };
    patch.status = body.status;
  }
  if (body.consentMode !== undefined) {
    if (body.consentMode !== 'opt_in' && body.consentMode !== 'opt_out') return { patch, error: 'consentMode must be opt_in or opt_out' };
    patch.consentPolicy = { mode: body.consentMode };
  }
  if (body.defaultCountry !== undefined) {
    if (!COUNTRIES.includes(body.defaultCountry as CountryCode)) return { patch, error: `defaultCountry must be one of ${COUNTRIES.join(', ')}` };
    patch.defaultCountry = body.defaultCountry as CountryCode;
  }
  if (body.allowedChannels !== undefined) {
    const v = subset(body.allowedChannels, CHANNELS);
    if (!v) return { patch, error: `allowedChannels must be a non-empty list from ${CHANNELS.join(', ')}` };
    patch.allowedChannels = v;
  }
  if (body.destinations !== undefined) {
    const v = subset(body.destinations, DESTINATIONS);
    if (!v) return { patch, error: `destinations must be a non-empty list from ${DESTINATIONS.join(', ')}` };
    patch.destinations = v;
  }
  if (body.retentionDays !== undefined) {
    const n = body.retentionDays;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 365) return { patch, error: 'retentionDays must be a whole number from 1 to 365' };
    patch.retentionDays = n;
  }
  return { patch };
}

/**
 * The record the brand adds. One CNAME is all the address itself needs. `ready` is false while the server's own public
 * address is not set (a CNAME to "localhost" would be useless), so the console can say so instead of handing it out.
 */
export function dnsInstructions(trackingHost: string, publicBase: string) {
  const name = trackingHost.replace(/:\d+$/, '');
  const target = new URL(publicBase).hostname;
  const local = /\.localhost$/.test(name);
  return {
    type: 'CNAME',
    name,
    /** What many DNS panels want in the "Name" or "Host" box: just the first part. */
    short: name.split('.')[0]!,
    target,
    local,
    ready: local || !(target === 'localhost' || /^\d+(\.\d+){3}$/.test(target) || target.endsWith('.localhost')),
  };
}

function snippetsFor(origin: string, key: string, consentMode: 'opt_in' | 'opt_out') {
  const { script, gtm } = installSnippets({ trackerUrl: `${origin}/tracker.js`, key, endpoint: origin, consentMode });
  return { snippet: script, gtmSnippet: gtm };
}

async function tenantView(id: string, deps: AdminDeps) {
  const tenant = await deps.registry.getTenant(id);
  if (!tenant) return null;
  const base = deps.publicUrl.replace(/\/$/, '');
  const siteKeys = await deps.registry.listSiteKeys(id);
  return {
    tenant,
    siteKeys: siteKeys.map((s) => {
      // With the brand's own tracking address the script is loaded from, and talks to, that address.
      const origin = s.trackingHost ? `${/localhost/.test(s.trackingHost) ? 'http' : 'https'}://${s.trackingHost}` : base;
      return {
        ...s,
        // Two ways to install it, built from the same settings. Opt-out brands need the browser told so, otherwise the
        // script waits for a "yes" that never comes.
        ...snippetsFor(origin, s.key, tenant.consentPolicy.mode),
        // What the brand's DNS needs: this address must point at our collector.
        ...(s.trackingHost ? { dns: dnsInstructions(s.trackingHost, base) } : {}),
      };
    }),
    connections: await deps.connectionsFor(id).list(),
    webhooks: { zoho: `${base}/webhooks/${id}/zoho`, generic: `${base}/webhooks/${id}/generic` },
    sending: (await deps.sendingFor?.(id)) ?? { allowed: true },
  };
}

export async function handleAdmin(req: AdminRequest, deps: AdminDeps): Promise<AdminResponse> {
  if (!tokenMatches(req.token, deps.adminToken)) return fail(401, 'unauthorized', 'Missing or wrong admin token.');
  const now = deps.now ? deps.now() : new Date();
  const { method, path } = req;
  const body = isObj(req.body) ? req.body : {};

  try {
    if (method === 'GET' && path === '/me') return ok({ ok: true });

    if (method === 'GET' && path === '/meta') {
      return ok({
        channels: CHANNELS,
        destinations: DESTINATIONS,
        countries: COUNTRIES,
        importColumns: IMPORT_COLUMNS,
        importTemplate: IMPORT_TEMPLATE,
        defaultZohoMapping: DEFAULT_ZOHO_MAPPING,
        google: deps.googleInfo ?? { oauthConfigured: false },
      });
    }

    if (path === '/sending') {
      if (!deps.sendControl) return fail(404, 'not_available', 'This server has no send control.');
      if (method === 'GET') return ok(await deps.sendControl.overview());
      if (method === 'PUT') {
        if (typeof body.paused !== 'boolean') return fail(400, 'paused_required', 'Say whether sending is paused (true or false).');
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        return ok(await deps.sendControl.setPaused(body.paused, reason || undefined));
      }
    }

    if (path === '/tenants') {
      if (method === 'GET') {
        const all = await deps.registry.listTenants();
        all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return ok({ tenants: all });
      }
      if (method === 'POST') {
        if (!str(body.name, 80)) return fail(400, 'invalid_name', 'name must be 1-80 characters');
        const { patch, error } = tenantSettings(body);
        if (error) return fail(400, 'invalid_settings', error);
        const o = origins(body.origins);
        if (!o) return fail(400, 'invalid_origins', 'origins must be a list of full URLs like https://www.brand.com');

        let zoho: ZohoMapping | undefined;
        if (body.zoho === true) zoho = DEFAULT_ZOHO_MAPPING;
        else if (body.zoho !== undefined && body.zoho !== false) {
          const checked = validateZohoMapping(body.zoho);
          if (typeof checked === 'string') return fail(400, 'invalid_mapping', checked);
          zoho = checked;
        }

        const created = await deps.registry.createTenant({
          name: body.name.trim(),
          origins: o,
          ...(typeof body.trackingHost === 'string' && body.trackingHost.trim() ? { trackingHost: body.trackingHost } : {}),
          ...(patch.consentPolicy ? { consentMode: patch.consentPolicy.mode } : {}),
          ...(patch.allowedChannels ? { allowedChannels: patch.allowedChannels } : {}),
          ...(patch.destinations ? { destinations: patch.destinations } : {}),
          ...(patch.defaultCountry ? { defaultCountry: patch.defaultCountry } : {}),
          ...(patch.retentionDays ? { retentionDays: patch.retentionDays } : {}),
          ...(zoho ? { zoho } : {}),
        });
        return ok({ ...(await tenantView(created.tenant.tenantId, deps)), siteKey: created.siteKey, webhookSecret: created.webhookSecret }, 201);
      }
      return fail(405, 'method_not_allowed');
    }

    const m = /^\/tenants\/([a-z0-9][a-z0-9-]{0,80})(\/.*)?$/.exec(path);
    if (!m) return fail(404, 'not_found');
    const id = m[1]!;
    const rest = m[2] ?? '';
    if (!(await deps.registry.getTenant(id))) return fail(404, 'unknown_tenant');

    if (rest === '') {
      if (method === 'GET') return ok(await tenantView(id, deps));
      if (method === 'PATCH') {
        const { patch, error } = tenantSettings(body);
        if (error) return fail(400, 'invalid_settings', error);
        await deps.registry.update(id, patch);
        return ok(await tenantView(id, deps));
      }
      return fail(405, 'method_not_allowed');
    }

    if (rest === '/sources/zoho' && method === 'PUT') {
      const checked = validateZohoMapping(body);
      if (typeof checked === 'string') return fail(400, 'invalid_mapping', checked);
      await deps.registry.setSourceMapping(id, 'zoho', checked);
      return ok(await tenantView(id, deps));
    }

    if (rest === '/webhook-secret/rotate' && method === 'POST') {
      return ok({ webhookSecret: await deps.registry.rotateWebhookSecret(id) });
    }

    if (rest === '/site-keys' && method === 'POST') {
      const o = origins(body.origins);
      if (!o) return fail(400, 'invalid_origins', 'origins must be a list of full URLs like https://www.brand.com');
      const host = typeof body.trackingHost === 'string' && body.trackingHost.trim() ? body.trackingHost : undefined;
      const key = await deps.registry.addSiteKey(id, o, str(body.label, 60) ? body.label.trim() : undefined, host);
      return ok({ siteKey: key }, 201);
    }

    const siteKeyPath = /^\/site-keys\/(pk_[a-f0-9]{24})$/.exec(rest);
    if (siteKeyPath && method === 'PATCH') {
      const patch: { origins?: string[]; label?: string; trackingHost?: string | null } = {};
      if (body.origins !== undefined) {
        const o = origins(body.origins);
        if (!o) return fail(400, 'invalid_origins', 'origins must be a list of full URLs like https://www.brand.com');
        patch.origins = o;
      }
      if (body.label !== undefined) patch.label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
      // An empty value removes the tracking address, which sends the brand back to the shared address.
      if (body.trackingHost !== undefined) patch.trackingHost = typeof body.trackingHost === 'string' && body.trackingHost.trim() ? body.trackingHost : null;
      await deps.registry.updateSiteKey(id, siteKeyPath[1]!, patch);
      return ok(await tenantView(id, deps));
    }

    const conn = /^\/connections\/(meta|google_ads)$/.exec(rest);
    if (conn) {
      const kind = conn[1] as 'meta' | 'google_ads';
      const repo = deps.connectionsFor(id);
      if (method === 'DELETE') {
        await repo.remove(kind);
        return ok({ ok: true });
      }
      if (method === 'PUT') {
        if (kind === 'google_ads' && body.authMethod !== undefined && body.authMethod !== 'oauth' && body.authMethod !== 'service_account') {
          return fail(400, 'invalid_auth_method', 'authMethod must be oauth or service_account');
        }
        const viaServiceAccount = kind === 'google_ads' && body.authMethod === 'service_account';
        // Leaving the token blank keeps the saved one, so settings can be edited without pasting it again.
        // A service-account connection has no token of its own.
        const secretField = kind === 'meta' ? body.accessToken : body.refreshToken;
        let secret = typeof secretField === 'string' ? secretField.trim() : '';
        if (!secret && !viaServiceAccount) secret = (await repo.getWithSecret(kind).catch(() => null))?.secret ?? '';
        if (!secret && !viaServiceAccount) return fail(400, 'secret_required', kind === 'meta' ? 'accessToken is required' : 'refreshToken is required');
        try {
          if (kind === 'meta') {
            await repo.set('meta', { datasetId: String(body.datasetId ?? ''), ...(str(body.testEventCode, 60) ? { testEventCode: body.testEventCode } : {}) }, secret, now);
          } else {
            await repo.set(
              'google_ads',
              {
                customerId: String(body.customerId ?? ''),
                conversionActionId: String(body.conversionActionId ?? ''),
                ...(body.loginCustomerId ? { loginCustomerId: String(body.loginCustomerId) } : {}),
                ...(viaServiceAccount ? { authMethod: 'service_account' as const } : {}),
              },
              viaServiceAccount ? undefined : secret,
              now,
            );
          }
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : 'invalid_connection');
        }
        return ok(await repo.get(kind));
      }
      return fail(405, 'method_not_allowed');
    }

    if (rest === '/sales' && method === 'GET') {
      const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 50) || 50, 1), 200);
      return ok({ sales: await deps.salesFor(id).listSales(limit) });
    }

    const resend = /^\/sales\/([a-f0-9]{32})\/deliveries\/(meta|google_ads)\/resend$/.exec(rest);
    if (resend && method === 'POST') {
      const reset = await deps.salesFor(id).resetDelivery(resend[1]!, resend[2]!, now);
      return reset ? ok({ ok: true }) : fail(409, 'not_resendable', 'Only failed, retrying or sent deliveries can be resent.');
    }

    if (rest === '/connections/google_ads/check' && method === 'POST') {
      return ok(await deps.checkGoogleFor(id));
    }

    const check = /^\/site-keys\/(pk_[a-f0-9]{24})\/check$/.exec(rest);
    if (check && method === 'POST') {
      const site = (await deps.registry.listSiteKeys(id)).find((s) => s.key === check[1]);
      if (!site) return fail(404, 'unknown_site_key');
      if (!site.trackingHost) return fail(400, 'no_tracking_host', 'This site key has no tracking address to check.');
      return ok(
        await runTrackingCheck({
          site: { key: site.key, trackingHost: site.trackingHost, origins: site.origins },
          publicUrl: deps.publicUrl,
          deps: deps.trackingCheckDeps ?? defaultCheckDeps(),
          ...(deps.now ? { now: deps.now } : {}),
        }),
      );
    }

    const preview = /^\/sales\/([a-f0-9]{32})\/deliveries\/(meta|google_ads)\/preview$/.exec(rest);
    if (preview && method === 'GET') {
      if (!deps.previewFor) return fail(501, 'not_supported');
      const p = await deps.previewFor(id, preview[1]!, preview[2] as 'meta' | 'google_ads');
      return p ? ok(p) : fail(404, 'not_found', 'No such delivery.');
    }

    if (rest === '/stats' && method === 'GET') {
      const days = Math.min(Math.max(Number(req.query.get('days') ?? 30) || 30, 1), 90);
      return ok(await deps.salesFor(id).stats(new Date(now.getTime() - days * 86_400_000)));
    }

    if (rest === '/dispatch' && method === 'POST') {
      if ((await deps.registry.getTenant(id))!.status !== 'active') return fail(409, 'brand_suspended', 'This brand is suspended: nothing is sent.');
      return ok(await deps.dispatchFor(id));
    }

    if (rest === '/consent/withdraw' && method === 'POST') {
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!phone && !email) return fail(400, 'contact_required', 'Give a phone number or an email.');
      const tenant = (await deps.registry.getTenant(id))!;
      let r;
      try {
        r = await deps.withdrawFor(tenant, { ...(phone ? { phone } : {}), ...(email ? { email } : {}) });
      } catch (e) {
        if (e instanceof Error && e.message === 'too_many_linked_contacts') return fail(409, 'too_many_linked_contacts', SHARED_CONTACT_MESSAGE);
        throw e;
      }
      return r.keys === 0 ? fail(400, 'invalid_contact', 'That phone number or email could not be read.') : ok(r);
    }

    if (rest === '/customers/erase' && method === 'POST') {
      if (!deps.eraseFor) return fail(404, 'not_available', 'This server cannot erase customers.');
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!phone && !email) return fail(400, 'contact_required', 'Give a phone number or an email.');
      // Works for suspended brands too: a privacy request must not wait for a brand to be switched back on.
      const tenant = (await deps.registry.getTenant(id))!;
      let r;
      try {
        r = await deps.eraseFor(tenant, { ...(phone ? { phone } : {}), ...(email ? { email } : {}) });
      } catch (e) {
        if (e instanceof Error && e.message === 'too_many_linked_contacts') return fail(409, 'too_many_linked_contacts', SHARED_CONTACT_MESSAGE);
        throw e;
      }
      return r.found ? ok(r) : fail(400, 'invalid_contact', 'That phone number or email could not be read.');
    }

    if (rest === '/import' && method === 'POST') {
      if (typeof body.csv !== 'string' || !body.csv.trim()) return fail(400, 'csv_required', 'Send the file contents as "csv".');
      const tenant = (await deps.registry.getTenant(id))!;
      if (tenant.status !== 'active') return fail(409, 'brand_suspended', 'This brand is suspended: imports are refused.');
      const parsed = salesFromCsv(body.csv);
      if (parsed.error) return fail(400, 'invalid_csv', parsed.error);

      const dryRun = body.dryRun === true;
      const nowMs = (deps.now ?? (() => new Date()))().getTime();
      // A real import needs a clean check of exactly this file, made a short while ago.
      if (!dryRun) {
        const problem = checkTokenProblem(deps.adminToken, id, body.csv, body.checkToken, nowMs);
        if (problem === 'check_required') return fail(400, problem, 'Check the file first, then import it.');
        if (problem) return fail(400, problem, 'The file changed, or was checked too long ago. Check it again before importing.');
      }
      const results: Array<{ line: number; status: string; error?: string }> = [];
      const counts = { recorded: 0, duplicate: 0, invalid: 0, error: 0 };
      for (const row of parsed.rows) {
        if (!row.ok || !row.sale) {
          counts.invalid++;
          results.push({ line: row.line, status: 'invalid', ...(row.error ? { error: row.error } : {}) });
          continue;
        }
        if (dryRun) {
          results.push({ line: row.line, status: 'valid' });
          continue;
        }
        try {
          const r = await deps.processFor(tenant, row.sale);
          counts[r.duplicate ? 'duplicate' : 'recorded']++;
          results.push({ line: row.line, status: r.duplicate ? 'duplicate' : 'recorded' });
        } catch {
          counts.error++;
          results.push({ line: row.line, status: 'error' });
        }
      }
      if (dryRun) {
        const clean = counts.invalid === 0;
        return ok({
          dryRun,
          counts,
          results,
          summary: await summariseImport(deps.salesFor(id), parsed.rows),
          ...(clean ? { checkToken: checkTokenFor(deps.adminToken, id, body.csv, nowMs) } : {}),
        });
      }
      return ok({ dryRun, counts, results });
    }

    return fail(404, 'not_found');
  } catch (e) {
    const message = e instanceof Error ? e.message : 'error';
    if (message === 'unknown_tenant') return fail(404, 'unknown_tenant');
    if (message === 'unknown_site_key') return fail(404, 'unknown_site_key');
    if (message === 'invalid_tracking_host') return fail(400, 'invalid_tracking_host', 'Use just the address, for example track.brand.com (no https://, no path). A port is only allowed for local testing (*.localhost).');
    if (message === 'tracking_host_taken') return fail(409, 'tracking_host_taken', 'Another site key already uses that tracking address.');
    return fail(500, 'internal_error');
  }
}
