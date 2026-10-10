import { buildFbc, type Channel } from '@datahash/core';
import type { MetaSettings } from '@datahash/store';
import { timedFetch, type HttpOptions, type SendContext, type SendResult } from './types';

/**
 * Graph API version. VERIFY the current version and keep it configurable.
 */
export const DEFAULT_META_API_VERSION = 'v21.0';

/** Meta action_source by channel. VERIFY the allowed values and rules for each in Meta's docs. */
const ACTION_SOURCE: Record<Channel, string> = {
  store: 'physical_store',
  whatsapp: 'business_messaging',
  online: 'system_generated',
  web_lead: 'system_generated',
};

export interface MetaEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: string;
  messaging_channel?: string;
  user_data: {
    ph?: string[];
    em?: string[];
    fn?: string[];
    ln?: string[];
    ct?: string[];
    st?: string[];
    zp?: string[];
    country?: string[];
    external_id?: string[];
    fbc?: string;
    fbp?: string;
    ctwa_clid?: string;
  };
  custom_data?: { value: number; currency: string };
}

export function buildMetaEvent({ sale, touch }: SendContext): MetaEvent | null {
  const user_data: MetaEvent['user_data'] = {};
  if (sale.hashes.metaPhone) user_data.ph = [sale.hashes.metaPhone];
  if (sale.hashes.metaEmail) user_data.em = [sale.hashes.metaEmail];
  // Customer details that raise the match rate. Lists, like the Business SDK sends them; fbp is a plain string.
  const h = sale.hashes;
  if (h.metaFirstName) user_data.fn = [h.metaFirstName];
  if (h.metaLastName) user_data.ln = [h.metaLastName];
  if (h.metaCity) user_data.ct = [h.metaCity];
  if (h.metaState) user_data.st = [h.metaState];
  if (h.metaZip) user_data.zp = [h.metaZip];
  if (h.metaCountry) user_data.country = [h.metaCountry];
  if (h.metaExternalId) user_data.external_id = [h.metaExternalId];
  if (h.fbp) user_data.fbp = h.fbp;
  if (touch?.fbc) user_data.fbc = touch.fbc;
  else if (touch?.fbclid) user_data.fbc = buildFbc(touch.fbclid, touch.clickedAt.getTime());
  if (touch?.ctwaClid) user_data.ctwa_clid = touch.ctwaClid;
  // Meta needs a real identifier. Name, place and the browser ID only help a match; they are not one on their own.
  if (!user_data.ph && !user_data.em && !user_data.fbc && !user_data.ctwa_clid) return null;

  const event: MetaEvent = {
    event_name: sale.eventName,
    event_time: Math.floor(sale.occurredAt.getTime() / 1000),
    // Same ID on every retry (and on any pixel event for the same action) so Meta counts the sale once.
    event_id: sale.eventId,
    action_source: ACTION_SOURCE[sale.channel],
    user_data,
  };
  if (sale.channel === 'whatsapp') event.messaging_channel = 'whatsapp';
  if (sale.value !== undefined) event.custom_data = { value: sale.value, currency: sale.currency ?? 'INR' };
  return event;
}

interface MetaError {
  message?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
}

// Meta error codes that mean "slow down / try later". VERIFY against Meta's current error reference.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const AUTH_CODES = new Set([102, 190]);

export async function sendMeta(
  ctx: SendContext,
  connection: { settings: MetaSettings; token: string },
  opts: HttpOptions & { apiVersion?: string } = {},
): Promise<SendResult> {
  const event = buildMetaEvent(ctx);
  if (!event) return { outcome: 'failed', error: 'no_user_data: no hashed phone, email or click ID to match on' };

  const url =
    `https://graph.facebook.com/${opts.apiVersion ?? DEFAULT_META_API_VERSION}/${connection.settings.datasetId}/events` +
    `?access_token=${encodeURIComponent(connection.token)}`;
  const body = {
    data: [event],
    ...(connection.settings.testEventCode ? { test_event_code: connection.settings.testEventCode } : {}),
  };

  let res: Response;
  try {
    res = await timedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, opts);
  } catch (err) {
    return { outcome: 'retry', error: `network: ${err instanceof Error ? err.message : 'error'}` };
  }

  // A reply we cannot read is not proof Meta received the event. Retry with the same event ID (safe: Meta dedupes).
  const json = (await res.json().catch(() => null)) as { events_received?: number; fbtrace_id?: string; error?: MetaError } | null;
  if (res.ok) {
    if (!json) return { outcome: 'retry', error: 'meta: unreadable response, will check again' };
    if (!json.events_received) return { outcome: 'failed', error: 'meta accepted the request but received 0 events' };
    return { outcome: 'sent', response: `events_received=${json.events_received}${json.fbtrace_id ? ` trace=${json.fbtrace_id}` : ''}` };
  }

  const e = json?.error ?? {};
  const message = `meta ${res.status}${e.code ? ` code ${e.code}` : ''}: ${e.message ?? 'error'}`;
  if (e.code !== undefined && AUTH_CODES.has(e.code)) return { outcome: 'failed', error: message, authError: true };
  if (res.status >= 500 || res.status === 429 || e.is_transient || (e.code !== undefined && TRANSIENT_CODES.has(e.code))) {
    return { outcome: 'retry', error: message };
  }
  return { outcome: 'failed', error: message };
}
