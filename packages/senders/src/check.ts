import { sha256Hex } from '@datahash/core';
import type { ConnectionsRepo } from '@datahash/store';
import { sendGoogle, type GoogleAppCredentials } from './google';
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
