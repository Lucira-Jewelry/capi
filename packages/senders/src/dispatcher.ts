import { exceedsAgeLimit } from '@datahash/core';
import type { ConnectionsRepo, SalesRepo, Store, StoredDelivery } from '@datahash/store';
import { retrieveGoogleRequestStatus, sendGoogle, type GoogleAppCredentials } from './google';
import { sendMeta } from './meta';
import type { HttpOptions, SendContext, SendResult } from './types';

/** Wait before each retry, in minutes. After the last one the delivery is marked failed. */
export const RETRY_DELAYS_MIN = [1, 5, 30, 120, 360];
export const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;
/** A brand that has not connected an account yet is checked again at this interval; it does not use up attempts. */
export const NOT_CONNECTED_RETRY_MIN = 15;
/**
 * Google processes an accepted request asynchronously (30 minutes to 24 hours). Its recommended polling: first look
 * after 30 minutes, then back off by 1.3x up to 60 minutes, and stop after 24 hours.
 */
export const PROCESSING_FIRST_CHECK_MIN = 30;
export const PROCESSING_BACKOFF = 1.3;
export const PROCESSING_MAX_BACKOFF_MIN = 60;
export const PROCESSING_GIVE_UP_MIN = 24 * 60;

/** A delivery claimed this many times without finishing (workers keep crashing on it) is given up on. */
export const MAX_CLAIMS = 20;

export interface DispatcherDeps {
  sales: SalesRepo;
  store: Pick<Store, 'getTouch' | 'isSuppressed'>;
  connections: ConnectionsRepo;
  google?: GoogleAppCredentials | undefined;
  http?: HttpOptions;
  metaApiVersion?: string;
  googleApiVersion?: string;
  now?: () => Date;
  /**
   * Is the brand allowed to send right now? Asked before every delivery, so suspending a brand stops a run
   * that is already under way.
   */
  tenantActive?: () => Promise<boolean>;
  /**
   * May data be sent? Asked once for the whole brand (no argument) and again for each delivery's platform. A string
   * is the reason it may not. Blocked deliveries are left untouched in the queue.
   */
  sendBlocked?: (destination?: string) => string | null | Promise<string | null>;
  /**
   * The final check, made immediately before the request to the platform and expected to read live state (not a cache):
   * a string means do not send. The delivery then goes back to the queue exactly as it was. This is what makes a pause
   * take effect at once; `sendBlocked` is only the cheap early skip.
   */
  sendGate?: (destination: string) => Promise<string | null>;
}

export interface DispatchSummary {
  considered: number;
  sent: number;
  retried: number;
  failed: number;
  notConnected: number;
  lostClaim: number;
  /** Skipped at send time because the customer withdrew consent after the sale was queued. */
  withdrawn: number;
  /** A worker finished after another one had taken over the delivery; its result was discarded. */
  lostLease: number;
  /** The brand is suspended: nothing was sent. */
  suspended: boolean;
  /** Due deliveries left in the queue because sending is not allowed (see SendPolicy). */
  blocked: number;
  /** Why, when anything was blocked. */
  blockedReason?: string;
  /** Look-ups of what Google did with requests it accepted earlier. */
  diagnostics: DiagnosticsSummary;
}

export interface DiagnosticsSummary {
  checked: number;
  success: number;
  partial: number;
  rejected: number;
  stillProcessing: number;
}

const min = (m: number) => m * 60_000;

/**
 * Send what is due for one brand. Safe to run often and from several workers: each delivery is claimed
 * with a lease token, only the holder of the token may write the result, and the same event ID is used on
 * every try so a platform never counts a sale twice.
 */
export async function dispatchDue(deps: DispatcherDeps, limit = 50): Promise<DispatchSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: DispatchSummary = {
    considered: 0, sent: 0, retried: 0, failed: 0, notConnected: 0, lostClaim: 0, withdrawn: 0, lostLease: 0, suspended: false, blocked: 0,
    diagnostics: { checked: 0, success: 0, partial: 0, rejected: 0, stillProcessing: 0 },
  };

  // The whole brand may not send: leave everything exactly where it is.
  const everything = await deps.sendBlocked?.();
  if (everything) {
    summary.blocked = (await deps.sales.listDueDeliveries(now(), limit)).length;
    if (summary.blocked) summary.blockedReason = everything;
    return summary;
  }

  for (const delivery of await deps.sales.listDueDeliveries(now(), limit)) {
    if (deps.tenantActive && !(await deps.tenantActive())) {
      summary.suspended = true;
      break;
    }
    const why = await deps.sendBlocked?.(delivery.destination);
    if (why) {
      summary.blocked++;
      summary.blockedReason = why;
      continue;
    }
    summary.considered++;
    const token = await deps.sales.claimDelivery(delivery.saleKey, delivery.destination, now());
    if (!token) {
      summary.lostClaim++;
      continue;
    }

    const write = async (outcome: Parameters<SalesRepo['completeDelivery']>[2]) => {
      const written = await deps.sales.completeDelivery(delivery.saleKey, delivery.destination, { ...outcome, leaseToken: token }, now());
      if (!written) summary.lostLease++;
      return written;
    };

    if (delivery.claims + 1 > MAX_CLAIMS) {
      summary.failed++;
      await write({ status: 'failed', error: `too_many_claims: workers kept stopping on this delivery`, countAttempt: false });
      continue;
    }

    const result = await processOne(deps, delivery, now());

    if (result.kind === 'blocked') {
      // Stopped at the last moment: give the delivery back untouched (no attempt counted) for when sending resumes.
      summary.considered--;
      summary.blocked++;
      summary.blockedReason = result.reason;
      await write({ status: 'pending', countAttempt: false });
      if (result.suspended) {
        summary.suspended = true;
        break;
      }
      continue;
    }

    if (result.kind === 'not_connected') {
      summary.notConnected++;
      await write({ status: 'retry', error: result.error, nextRetryAt: new Date(now().getTime() + min(NOT_CONNECTED_RETRY_MIN)), countAttempt: false });
    } else if (result.kind === 'withdrawn') {
      summary.withdrawn++;
      await write({ status: 'skipped', skipReason: 'consent_withdrawn', countAttempt: false });
    } else if (result.outcome === 'sent') {
      summary.sent++;
      await write({
        status: 'sent',
        response: result.response,
        ...(result.requestId
          ? { requestId: result.requestId, processingNextCheckAt: new Date(now().getTime() + min(PROCESSING_FIRST_CHECK_MIN)) }
          : {}),
      });
    } else if (result.outcome === 'retry' && result.transport && delivery.attempts + 1 < MAX_ATTEMPTS) {
      summary.retried++;
      const delay = RETRY_DELAYS_MIN[delivery.attempts] ?? RETRY_DELAYS_MIN[RETRY_DELAYS_MIN.length - 1]!;
      await write({ status: 'retry', error: result.error, nextRetryAt: new Date(now().getTime() + min(delay)) });
    } else {
      summary.failed++;
      const error = result.outcome === 'retry' ? `gave up after ${delivery.attempts + 1} tries: ${result.error}` : result.error;
      const written = await write({ status: 'failed', error, countAttempt: Boolean(result.transport) });
      if (written && result.outcome === 'failed' && result.authError) {
        await deps.connections.markStatus(delivery.destination, 'error', result.error, now());
      }
    }
  }

  // Look up what Google did with requests it accepted earlier (cheap, and needs no new sends).
  if (!summary.suspended && deps.google) summary.diagnostics = await reconcileProcessing(deps, limit);
  return summary;
}

const checkDelay = (checks: number) => Math.min(PROCESSING_FIRST_CHECK_MIN * PROCESSING_BACKOFF ** checks, PROCESSING_MAX_BACKOFF_MIN);

/**
 * Accepted is not processed. For each sent Google delivery whose result is still unknown, ask Google what it did:
 * processed, partly rejected, or rejected (with the reasons), so a sale that was refused after acceptance shows up.
 */
export async function reconcileProcessing(deps: DispatcherDeps, limit = 50): Promise<DiagnosticsSummary> {
  const now = deps.now ?? (() => new Date());
  const out: DiagnosticsSummary = { checked: 0, success: 0, partial: 0, rejected: 0, stillProcessing: 0 };
  if (!deps.google) return out;

  for (const d of await deps.sales.listDueProcessing(now(), limit)) {
    const checks = d.processingChecks ?? 0;
    const postpone = (minutes: number, detail?: string) =>
      deps.sales.recordProcessing(
        d.saleKey,
        d.destination,
        { status: 'processing', checks: checks + 1, nextCheckAt: new Date(now().getTime() + min(minutes)), ...(detail ? { detail } : {}) },
        now(),
      );

    const conn = await deps.connections.getWithSecret('google_ads').catch(() => null);
    if (!conn || !d.externalRequestId) {
      await postpone(PROCESSING_MAX_BACKOFF_MIN, 'waiting: the Google account is not connected, cannot look up the result');
      out.stillProcessing++;
      continue;
    }

    out.checked++;
    const r = await retrieveGoogleRequestStatus(
      d.externalRequestId,
      conn.settings.authMethod === 'service_account' ? { serviceAccount: true } : conn.secret,
      deps.google,
      {
        ...deps.http,
        apiVersion: deps.googleApiVersion,
        now: () => now().getTime(),
      },
    );
    if (!r.ok) {
      await postpone(r.authError ? PROCESSING_MAX_BACKOFF_MIN : 10, `could not look up the result: ${r.error}`);
      out.stillProcessing++;
      continue;
    }

    const reasons = (list: Array<{ reason: string; count: number }>) => list.map((x) => `${x.reason} x${x.count}`).join(', ');
    if (r.status === 'SUCCESS') {
      await deps.sales.recordProcessing(d.saleKey, d.destination, { status: 'success', checks: checks + 1, ...(r.warnings.length ? { detail: `warnings: ${reasons(r.warnings)}` } : {}) }, now());
      out.success++;
    } else if (r.status === 'PARTIAL_SUCCESS') {
      await deps.sales.recordProcessing(d.saleKey, d.destination, { status: 'partial', checks: checks + 1, detail: `rejected: ${reasons(r.errors) || 'see Google Ads diagnostics'}` }, now());
      out.partial++;
    } else if (r.status === 'FAILED') {
      await deps.sales.recordProcessing(d.saleKey, d.destination, { status: 'rejected', checks: checks + 1, detail: `rejected: ${reasons(r.errors) || 'see Google Ads diagnostics'}` }, now());
      out.rejected++;
    } else {
      // Still processing (or no answer yet). Give up after 24 hours.
      const ageMin = (now().getTime() - (d.sentAt ?? d.createdAt).getTime()) / 60_000;
      if (ageMin > PROCESSING_GIVE_UP_MIN) {
        await deps.sales.recordProcessing(d.saleKey, d.destination, { status: 'unknown', checks: checks + 1, detail: 'Google gave no result within 24 hours' }, now());
      } else {
        await postpone(checkDelay(checks + 1));
        out.stillProcessing++;
      }
    }
  }
  return out;
}

/** `transport` is true when a request really went to the platform, so the result counts as an attempt. */
type Processed =
  | (SendResult & { kind?: undefined; transport?: boolean })
  | { kind: 'not_connected'; error: string }
  | { kind: 'withdrawn' }
  | { kind: 'blocked'; reason: string; suspended?: boolean };

async function processOne(deps: DispatcherDeps, delivery: StoredDelivery, now: Date): Promise<Processed> {
  const sale = await deps.sales.getSale(delivery.saleKey);
  if (!sale) return { outcome: 'failed', error: 'sale_not_found' };

  // Consent can be withdrawn after a sale was queued. Check right before sending.
  if (sale.identityKeys?.length && (await deps.store.isSuppressed(sale.identityKeys))) return { kind: 'withdrawn' };

  const touch =
    delivery.touchId && sale.personId ? await deps.store.getTouch(sale.personId, delivery.touchId) : null;

  // The window may have closed while the delivery waited in the queue.
  if (exceedsAgeLimit(delivery.destination, sale, touch, now)) {
    return { outcome: 'failed', error: 'too_old: past the platform attribution window' };
  }

  const ctx: SendContext = { saleKey: delivery.saleKey, sale, touch };
  // The very last look before anything leaves: the brand is still active and sending is still allowed, read live.
  const lastLook = async (): Promise<Processed | null> => {
    if (deps.tenantActive && !(await deps.tenantActive())) return { kind: 'blocked', reason: 'This brand is suspended: nothing is sent.', suspended: true };
    const why = await deps.sendGate?.(delivery.destination);
    return why ? { kind: 'blocked', reason: why } : null;
  };
  const notConnected = { kind: 'not_connected' as const, error: 'not_connected: no account connected for this destination' };
  const unreadable: Processed = {
    outcome: 'failed',
    error: 'secret_unreadable: the saved token cannot be decrypted. Reconnect the account.',
    authError: true,
  };

  if (delivery.destination === 'meta') {
    const conn = await deps.connections.getWithSecret('meta').catch(() => 'unreadable' as const);
    if (conn === 'unreadable') return unreadable;
    if (!conn) return notConnected;
    const stop = await lastLook();
    if (stop) return stop;
    const r = await sendMeta(ctx, { settings: conn.settings, token: conn.secret }, { ...deps.http, apiVersion: deps.metaApiVersion });
    return { ...r, transport: true };
  }

  const conn = await deps.connections.getWithSecret('google_ads').catch(() => 'unreadable' as const);
  if (conn === 'unreadable') return unreadable;
  if (!conn) return notConnected;
  if (!deps.google) {
    return {
      outcome: 'failed',
      error:
        conn.settings.authMethod === 'service_account'
          ? 'service_account_not_configured: set GOOGLE_SERVICE_ACCOUNT_JSON on the server'
          : 'google_oauth_client_not_configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
    };
  }
  const stop = await lastLook();
  if (stop) return stop;
  const r = await sendGoogle(ctx, { settings: conn.settings, refreshToken: conn.secret }, deps.google, {
    ...deps.http,
    apiVersion: deps.googleApiVersion,
    now: () => now.getTime(),
  });
  return { ...r, transport: true };
}
