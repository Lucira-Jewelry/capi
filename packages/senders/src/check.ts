import { sha256Hex } from '@datahash/core';
import type { ConnectionsRepo } from '@datahash/store';
import { sendGoogle, type GoogleAppCredentials } from './google';
import { sendMeta } from './meta';
import type { HttpOptions, SendContext } from './types';

/**
 * "Check connection" for Google: asks the Data Manager API to validate a sample event against the brand's account and
 * conversion action with `validateOnly`, which sends nothing. Catches the usual setup mistakes (no access to the
 * account, API not enabled, wrong scope, wrong conversion action type) before a real sale hits them.
 */
export async function checkGoogleConnection(deps: {
  connections: ConnectionsRepo;
  google?: GoogleAppCredentials | undefined;
  http?: HttpOptions;
  now?: () => Date;
}): Promise<{ ok: boolean; message: string }> {
  const now = deps.now ? deps.now() : new Date();
  const conn = await deps.connections.getWithSecret('google_ads').catch(() => 'unreadable' as const);
  if (conn === 'unreadable') return { ok: false, message: 'The saved token cannot be decrypted. Save the refresh token again.' };
  if (!conn) return { ok: false, message: 'Google Ads is not connected yet.' };
  if (!deps.google) {
    return {
      ok: false,
      message:
        conn.settings.authMethod === 'service_account'
          ? 'The server has no Google service account configured (GOOGLE_SERVICE_ACCOUNT_JSON).'
          : 'The server has no Google OAuth client configured (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).',
    };
  }

  // A made-up customer: validated, never ingested.
  const ctx: SendContext = {
    saleKey: 'connection-check',
    sale: {
      source: 'check', eventId: 'connection-check', eventName: 'Purchase', channel: 'store', occurredAt: now, value: 1, currency: 'INR',
      personId: null, hashes: { googleEmail: sha256Hex('connection-check@example.com') }, consentAds: true,
    },
    touch: null,
  };
  const r = await sendGoogle(ctx, { settings: conn.settings, refreshToken: conn.secret }, deps.google, { ...deps.http, validateOnly: true, now: () => now.getTime() });

  if (r.outcome === 'sent') {
    await deps.connections.markStatus('google_ads', 'active', undefined, now);
    return { ok: true, message: 'Google accepted the account and the conversion action. Nothing was sent.' };
  }
  if (r.outcome === 'retry') return { ok: false, message: `Could not check right now, try again in a minute. (${r.error})` };
  if (r.authError) await deps.connections.markStatus('google_ads', 'error', r.error, now);
  return { ok: false, message: r.error };
}

export interface MetaTestResult {
  ok: boolean;
  message: string;
  /** What Meta said (events received and trace ID), to quote when asking Meta for help. */
  detail?: string;
  datasetId?: string;
  testEventCode?: string;
}

/**
 * "Send test event" for Meta: posts ONE made-up Purchase to the brand's dataset, always with the saved test event code,
 * so it shows up in Events Manager under Test Events and never counts as a real conversion. Without a test code nothing
 * is sent at all: the one thing this must not do is put a fake purchase into the brand's live data.
 */
export async function checkMetaConnection(deps: {
  connections: ConnectionsRepo;
  http?: HttpOptions;
  metaApiVersion?: string;
  now?: () => Date;
}): Promise<MetaTestResult> {
  const now = deps.now ? deps.now() : new Date();
  const conn = await deps.connections.getWithSecret('meta').catch(() => 'unreadable' as const);
  if (conn === 'unreadable') return { ok: false, message: 'The saved token cannot be decrypted. Save the access token again.' };
  if (!conn) return { ok: false, message: 'Meta is not connected yet.' };
  const testEventCode = conn.settings.testEventCode;
  if (!testEventCode) {
    return {
      ok: false,
      message: 'Add the Test event code from Events Manager (Test Events tab) to this connection first. A test is only ever sent with a test code.',
    };
  }

  // A made-up customer: it only ever reaches Test Events.
  const ctx: SendContext = {
    saleKey: 'connection-check',
    sale: {
      source: 'check', eventId: `connection-check-${now.getTime()}`, eventName: 'Purchase', channel: 'store', occurredAt: now, value: 1, currency: 'INR',
      personId: null, hashes: { metaEmail: sha256Hex('connection-check@example.com') }, consentAds: true,
    },
    touch: null,
  };
  const r = await sendMeta(ctx, { settings: conn.settings, token: conn.secret }, { ...deps.http, apiVersion: deps.metaApiVersion });
  const where = { datasetId: conn.settings.datasetId, testEventCode };

  if (r.outcome === 'sent') {
    await deps.connections.markStatus('meta', 'active', undefined, now);
    return {
      ok: true,
      message: `Meta received the test event. In Events Manager open dataset ${conn.settings.datasetId}, Test Events, and look on the Server tab for code ${testEventCode}. If it is not there after a minute, check that the dataset and test code match the ones open in Events Manager. A test event shows only on the Server tab of Test Events, and how Meta lists a physical-store purchase there can differ, so this check alone cannot prove a real sale will arrive.`,
      detail: r.response,
      ...where,
    };
  }
  if (r.outcome === 'retry') return { ok: false, message: `Could not reach Meta right now, try again in a minute. (${r.error})`, ...where };
  if (r.authError) await deps.connections.markStatus('meta', 'error', r.error, now);
  return { ok: false, message: r.error, ...where };
}
