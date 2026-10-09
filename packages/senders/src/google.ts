import type { Channel } from '@datahash/core';
import type { GoogleAdsSettings } from '@datahash/store';
import { forgetServiceAccountToken, serviceAccountAccessToken, type ServiceAccountKey } from './google-service-account';
import { timedFetch, type HttpOptions, type SendContext, type SendResult } from './types';

/**
 * Google Data Manager API (replaces the retired Google Ads `uploadClickConversions` path).
 * Built from Google's current documentation: events:ingest, requestStatus:retrieve, "Format user data".
 * Things still worth confirming on a real account are marked VERIFY.
 */
export const DATA_MANAGER_BASE = 'https://datamanager.googleapis.com';
export const DATA_MANAGER_VERSION = 'v1';

/**
 * The product's own Google credentials. Both live in the Google Cloud project that has the Data Manager API enabled.
 * A brand is connected through one of them:
 *  - `serviceAccount` (recommended): the brand adds the service account's email as a user on its Google Ads account, or
 *    links it through your manager account. One credential for every brand, and no Google app verification needed.
 *  - `clientId` + `clientSecret`: the product's OAuth client. Each brand's Google user grants access and we keep a
 *    refresh token (scope https://www.googleapis.com/auth/datamanager). Needs Google OAuth app verification before
 *    production, because that scope is sensitive.
 */
export interface GoogleAppCredentials {
  clientId?: string;
  clientSecret?: string;
  serviceAccount?: ServiceAccountKey;
}

/** How we log in to one brand's account. */
export type GoogleAuth = { method: 'oauth'; refreshToken: string } | { method: 'service_account' };

export type GoogleAccess =
  | { ok: true; token: string }
  /** retry: temporary. brand_auth: the brand's own token/access must be fixed. platform: our own configuration or key is wrong. */
  | { ok: false; error: string; kind: 'retry' | 'brand_auth' | 'platform' };

/** An access token for this brand's login method, or why there is none. */
export async function googleAccessFor(
  auth: GoogleAuth,
  app: GoogleAppCredentials,
  opts: HttpOptions & { now?: () => number } = {},
): Promise<GoogleAccess> {
  if (auth.method === 'service_account') {
    if (!app.serviceAccount) {
      return { ok: false, kind: 'platform', error: 'service_account_not_configured: set GOOGLE_SERVICE_ACCOUNT_JSON on the server, or connect this brand with an OAuth token' };
    }
    const r = await serviceAccountAccessToken(app.serviceAccount, opts);
    return r.ok ? r : { ok: false, error: r.error, kind: r.temporary ? 'retry' : 'platform' };
  }
  if (!app.clientId || !app.clientSecret) {
    return { ok: false, kind: 'platform', error: 'google_oauth_client_not_configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server, or connect this brand with the service account' };
  }
  const r = await googleAccessToken(auth.refreshToken, app, opts);
  return r.ok ? r : { ok: false, error: r.error, kind: r.authError ? 'brand_auth' : 'retry' };
}

type EventSource = 'WEB' | 'APP' | 'IN_STORE' | 'PHONE' | 'MESSAGE' | 'OTHER';

/** Where the sale happened. Required by Google for offline conversions. */
const EVENT_SOURCE: Record<Channel, EventSource> = {
  store: 'IN_STORE',
  whatsapp: 'MESSAGE',
  online: 'WEB',
  web_lead: 'WEB',
};

/**
 * Google's older rule said gbraid/wbraid conversions cannot carry user identifiers. The Data Manager reference does
 * not repeat it, so this stays conservative until verified on a real account. VERIFY.
 */
const SEND_USER_DATA_WITH_BRAID = false;

export interface DataManagerAccount {
  accountType: 'GOOGLE_ADS';
  accountId: string;
}

export interface DataManagerEvent {
  eventTimestamp: string;
  transactionId: string;
  eventSource: EventSource;
  conversionValue?: number;
  currency?: string;
  adIdentifiers?: { gclid?: string; gbraid?: string; wbraid?: string };
  userData?: { userIdentifiers: Array<{ emailAddress: string } | { phoneNumber: string }> };
}

export interface IngestRequest {
  destinations: Array<{ operatingAccount: DataManagerAccount; loginAccount: DataManagerAccount; productDestinationId: string }>;
  encoding?: 'HEX';
  consent?: { adUserData: 'CONSENT_GRANTED' };
  events: DataManagerEvent[];
  validateOnly: boolean;
}

export function buildGoogleEvent({ sale, touch }: SendContext): DataManagerEvent | null {
  const event: DataManagerEvent = {
    // ISO 8601 in UTC. Real event time, never the time of sending.
    eventTimestamp: sale.occurredAt.toISOString(),
    // The same ID on every retry and the key Google deduplicates on, across sources too.
    transactionId: sale.eventId,
    eventSource: EVENT_SOURCE[sale.channel],
  };
  if (sale.value !== undefined) {
    event.conversionValue = sale.value;
    event.currency = sale.currency ?? 'INR';
  }

  const braidOnly = Boolean(touch && !touch.gclid && (touch.gbraid || touch.wbraid));
  if (touch?.gclid) event.adIdentifiers = { gclid: touch.gclid };
  else if (touch?.gbraid) event.adIdentifiers = { gbraid: touch.gbraid };
  else if (touch?.wbraid) event.adIdentifiers = { wbraid: touch.wbraid };

  if (!braidOnly || SEND_USER_DATA_WITH_BRAID) {
    const ids: NonNullable<DataManagerEvent['userData']>['userIdentifiers'] = [];
    if (sale.hashes.googleEmail) ids.push({ emailAddress: sale.hashes.googleEmail });
    if (sale.hashes.googlePhone) ids.push({ phoneNumber: sale.hashes.googlePhone });
    if (ids.length) event.userData = { userIdentifiers: ids };
  }

  // Google needs at least one thing to match on.
  return event.adIdentifiers || event.userData ? event : null;
}

export function buildGoogleRequest(ctx: SendContext, settings: GoogleAdsSettings, validateOnly = false): IngestRequest | null {
  const event = buildGoogleEvent(ctx);
  if (!event) return null;
  const request: IngestRequest = {
    destinations: [
      {
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: settings.customerId },
        // Access through a manager (MCC) account when one is set, otherwise direct.
        loginAccount: { accountType: 'GOOGLE_ADS', accountId: settings.loginCustomerId ?? settings.customerId },
        // The conversion action ID. The action must be of type "Import from clicks" (UPLOAD_CLICKS).
        productDestinationId: settings.conversionActionId,
      },
    ],
    events: [event],
    validateOnly,
  };
  // Our consent is a single yes/no to sharing for advertising, which is what adUserData states. We have no separate
  // answer about personalization, so it is left unspecified rather than guessed. VERIFY for EEA customers.
  if (ctx.sale.consentAds === true) request.consent = { adUserData: 'CONSENT_GRANTED' };
  if (event.userData) request.encoding = 'HEX';
  return request;
}

// ---- OAuth ----------------------------------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function googleAccessToken(
  refreshToken: string,
  app: GoogleAppCredentials,
  opts: HttpOptions & { now?: () => number } = {},
): Promise<{ ok: true; token: string } | { ok: false; error: string; authError: boolean }> {
  const now = (opts.now ?? Date.now)();
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > now) return { ok: true, token: cached.token };

  let res: Response;
  try {
    res = await timedFetch(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: app.clientId ?? '',
          client_secret: app.clientSecret ?? '',
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      },
      opts,
    );
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : 'error'}`, authError: false };
  }
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    // Only a refused grant means the brand must reconnect. Rate limits (429), outages and anything else are temporary.
    return {
      ok: false,
      error: `google oauth ${res.status}: ${json.error ?? 'error'}`,
      authError: res.status === 400 || res.status === 401 || res.status === 403,
    };
  }
  tokenCache.set(refreshToken, { token: json.access_token, expiresAt: now + ((json.expires_in ?? 3600) - 60) * 1000 });
  return { ok: true, token: json.access_token };
}

// ---- errors ---------------------------------------------------------------------------------------------------

interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ reason?: string; fieldViolations?: Array<{ field?: string; description?: string }> }>;
  };
}

function describeError(res: Response, json: GoogleApiError | null): string {
  const e = json?.error;
  const reasons = (e?.details ?? []).map((d) => d.reason).filter(Boolean);
  const fields = (e?.details ?? []).flatMap((d) => d.fieldViolations ?? []).map((v) => `${v.field}: ${v.description}`);
  return `google ${res.status}${e?.status ? ` ${e.status}` : ''}${reasons.length ? ` [${reasons.join(', ')}]` : ''}: ${e?.message ?? 'error'}${fields.length ? ` (${fields.slice(0, 3).join('; ')})` : ''}`;
}

/** Turn a failed HTTP answer into retry / failed / needs-attention. `accessHint` says how to fix an access problem. */
function classify(res: Response, json: GoogleApiError | null, forget: () => void, accessHint?: string): SendResult {
  const error = describeError(res, json);
  if (res.status === 401 || res.status === 403) {
    forget();
    // 403 covers: no access to the account, API not enabled for the project, scope missing. All need a human.
    return { outcome: 'failed', error: accessHint ? `${error}. ${accessHint}` : error, authError: true };
  }
  if (res.status === 429 || res.status >= 500) return { outcome: 'retry', error };
  return { outcome: 'failed', error };
}

// ---- send -----------------------------------------------------------------------------------------------------

export async function sendGoogle(
  ctx: SendContext,
  connection: { settings: GoogleAdsSettings; refreshToken: string },
  app: GoogleAppCredentials,
  opts: HttpOptions & { apiVersion?: string; now?: () => number; validateOnly?: boolean; baseUrl?: string } = {},
): Promise<SendResult> {
  const request = buildGoogleRequest(ctx, connection.settings, opts.validateOnly ?? false);
  if (!request) return { outcome: 'failed', error: 'no_identifiers: no click ID, hashed email or phone to match on' };

  const auth: GoogleAuth =
    connection.settings.authMethod === 'service_account' ? { method: 'service_account' } : { method: 'oauth', refreshToken: connection.refreshToken };
  const access = await googleAccessFor(auth, app, opts);
  if (!access.ok) {
    if (access.kind === 'retry') return { outcome: 'retry', error: access.error };
    // brand_auth: the brand's token was refused. platform: our own setup is wrong (not the brand's fault).
    return access.kind === 'brand_auth' ? { outcome: 'failed', error: access.error, authError: true } : { outcome: 'failed', error: access.error };
  }
  const authToken = access.token;

  const url = `${opts.baseUrl ?? DATA_MANAGER_BASE}/${opts.apiVersion ?? DATA_MANAGER_VERSION}/events:ingest`;
  let res: Response;
  try {
    res = await timedFetch(
      url,
      { method: 'POST', headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' }, body: JSON.stringify(request) },
      opts,
    );
  } catch (err) {
    return { outcome: 'retry', error: `network: ${err instanceof Error ? err.message : 'error'}` };
  }

  // A reply we cannot read is not proof Google accepted the request. Retry with the same transaction ID.
  const json = (await res.json().catch(() => null)) as (GoogleApiError & { requestId?: string; fieldWarnings?: unknown[] }) | null;
  if (!res.ok) {
    const sa = auth.method === 'service_account' ? app.serviceAccount?.client_email : undefined;
    return classify(
      res,
      json,
      () => (sa ? forgetServiceAccountToken(sa) : tokenCache.delete(connection.refreshToken)),
      sa
        ? `The brand must add ${sa} as a user on the Google Ads account (Admin > Access and security), or link the account to the manager account${connection.settings.loginCustomerId ? ` ${connection.settings.loginCustomerId}` : ''}`
        : undefined,
    );
  }
  if (!json) return { outcome: 'retry', error: 'google: unreadable response, will check again' };

  if (opts.validateOnly) return { outcome: 'sent', response: 'validated (nothing was sent)' };
  if (!json.requestId) return { outcome: 'retry', error: 'google: accepted without a request ID, will check again' };
  const warnings = Array.isArray(json.fieldWarnings) ? json.fieldWarnings.length : 0;
  return {
    outcome: 'sent',
    // Accepted is not processed: Google handles the request asynchronously (30 minutes to 24 hours).
    response: `accepted request=${json.requestId}${warnings ? ` warnings=${warnings}` : ''}`,
    requestId: json.requestId,
  };
}

// ---- processing result ----------------------------------------------------------------------------------------

export type GoogleProcessing = 'PROCESSING' | 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'UNKNOWN';

export type ProcessingLookup =
  | {
      ok: true;
      status: GoogleProcessing;
      errors: Array<{ reason: string; count: number }>;
      warnings: Array<{ reason: string; count: number }>;
    }
  | { ok: false; error: string; authError: boolean };

interface RequestStatusBody {
  requestStatusPerDestination?: Array<{
    requestStatus?: string;
    errorInfo?: { errorCounts?: Array<{ reason?: string; recordCount?: string | number }> };
    warningInfo?: { warningCounts?: Array<{ reason?: string; recordCount?: string | number }> };
  }>;
}

const RANK: Record<GoogleProcessing, number> = { SUCCESS: 0, UNKNOWN: 1, PROCESSING: 2, PARTIAL_SUCCESS: 3, FAILED: 4 };

/** What did Google do with a request it accepted earlier? Only works for requests that were not validate-only. */
export async function retrieveGoogleRequestStatus(
  requestId: string,
  /** A refresh token (OAuth connections) or `{ serviceAccount: true }` (service-account connections). */
  credential: string | { serviceAccount: true },
  app: GoogleAppCredentials,
  opts: HttpOptions & { apiVersion?: string; now?: () => number; baseUrl?: string } = {},
): Promise<ProcessingLookup> {
  const access = await googleAccessFor(typeof credential === 'string' ? { method: 'oauth', refreshToken: credential } : { method: 'service_account' }, app, opts);
  if (!access.ok) return { ok: false, error: access.error, authError: access.kind === 'brand_auth' };
  const auth = { token: access.token };

  const url = `${opts.baseUrl ?? DATA_MANAGER_BASE}/${opts.apiVersion ?? DATA_MANAGER_VERSION}/requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`;
  let res: Response;
  try {
    res = await timedFetch(url, { method: 'GET', headers: { authorization: `Bearer ${auth.token}` } }, opts);
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : 'error'}`, authError: false };
  }
  const json = (await res.json().catch(() => null)) as (RequestStatusBody & GoogleApiError) | null;
  if (!res.ok) return { ok: false, error: describeError(res, json), authError: res.status === 401 || res.status === 403 };
  if (!json) return { ok: false, error: 'google: unreadable status response', authError: false };

  let worst: GoogleProcessing = 'SUCCESS';
  const errors = new Map<string, number>();
  const warnings = new Map<string, number>();
  const parts = json.requestStatusPerDestination ?? [];
  if (parts.length === 0) worst = 'UNKNOWN';
  for (const part of parts) {
    const status = (part.requestStatus && part.requestStatus in RANK ? part.requestStatus : part.requestStatus === 'REQUEST_STATUS_UNKNOWN' ? 'UNKNOWN' : 'UNKNOWN') as GoogleProcessing;
    if (RANK[status] > RANK[worst]) worst = status;
    for (const e of part.errorInfo?.errorCounts ?? []) errors.set(e.reason ?? 'UNKNOWN', (errors.get(e.reason ?? 'UNKNOWN') ?? 0) + Number(e.recordCount ?? 1));
    for (const w of part.warningInfo?.warningCounts ?? []) warnings.set(w.reason ?? 'UNKNOWN', (warnings.get(w.reason ?? 'UNKNOWN') ?? 0) + Number(w.recordCount ?? 1));
  }
  const list = (m: Map<string, number>) => [...m].map(([reason, count]) => ({ reason, count }));
  return { ok: true, status: worst, errors: list(errors), warnings: list(warnings) };
}

/** For tests. */
export function clearGoogleTokenCache() {
  tokenCache.clear();
}
