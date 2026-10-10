import type { GoogleAdsSettings, MetaSettings } from '@datahash/store';
import { DATA_MANAGER_BASE, DATA_MANAGER_VERSION, buildGoogleRequest } from './google';
import { DEFAULT_META_API_VERSION, buildMetaEvent } from './meta';
import type { SendContext } from './types';

export interface PayloadPreview {
  destination: 'meta' | 'google_ads';
  method: 'POST';
  /** Where it would be sent. Access tokens are never part of it. */
  url: string;
  body: unknown;
  /** Plain-language notes: which click was credited, what is missing. */
  notes: string[];
}

/** What this sale is matched on, and the details that would help and are missing. Plain words for the console. */
export function matchSummary(destination: 'meta' | 'google_ads', ctx: SendContext): { used: string[]; missing: string[] } {
  const h = ctx.sale.hashes;
  const t = ctx.touch;
  const used: string[] = [];
  const missing: string[] = [];
  const check = (label: string, present: boolean) => (present ? used : missing).push(label);
  if (destination === 'meta') {
    check('phone', Boolean(h.metaPhone));
    check('email', Boolean(h.metaEmail));
    check('Meta click ID', Boolean(t?.fbc || t?.fbclid || t?.ctwaClid));
    check('name', Boolean(h.metaFirstName && h.metaLastName));
    check('city', Boolean(h.metaCity));
    check('postal code', Boolean(h.metaZip));
    check('country', Boolean(h.metaCountry));
    check('customer ID', Boolean(h.metaExternalId));
    check('browser ID (fbp)', Boolean(h.fbp));
  } else {
    check('phone', Boolean(h.googlePhone));
    check('email', Boolean(h.googleEmail));
    check('Google click ID', Boolean(t?.gclid || t?.gbraid || t?.wbraid));
    check('name, country and postal code (together)', Boolean(h.googleFirstName && h.googleLastName && h.googleRegion && h.googlePostal));
  }
  return { used, missing };
}

/**
 * Exactly what would be sent for a delivery, built by the same code that sends it, without sending anything and
 * without any secret. For checking first-party data (click IDs, fbc, hashed contact details) end to end.
 */
export function previewPayload(
  destination: 'meta' | 'google_ads',
  ctx: SendContext,
  settings: MetaSettings | GoogleAdsSettings | null,
): PayloadPreview | { error: string } {
  const notes: string[] = [];
  const touch = ctx.touch;
  notes.push(
    touch
      ? `Credited click: ${[touch.gclid && `gclid ${touch.gclid}`, touch.gbraid && `gbraid ${touch.gbraid}`, touch.wbraid && `wbraid ${touch.wbraid}`, touch.fbclid && `fbclid ${touch.fbclid}`, touch.ctwaClid && `ctwa_clid ${touch.ctwaClid}`].filter(Boolean).join(', ')} (clicked ${touch.clickedAt.toISOString()})`
      : 'No website click is credited to this sale: it is matched on the hashed phone and email only.',
  );

  const summary = matchSummary(destination, ctx);
  notes.push(`Matched on: ${summary.used.join(', ') || 'nothing'}.${summary.missing.length ? ` Not available: ${summary.missing.join(', ')}.` : ''}`);

  if (destination === 'meta') {
    const event = buildMetaEvent(ctx);
    if (!event) return { error: 'Nothing to match on: no hashed phone, email or click ID.' };
    const s = settings as MetaSettings | null;
    if (!s) notes.push('Meta is not connected yet, so the dataset ID below is a placeholder.');
    if (s?.testEventCode) notes.push(`Test mode: the test event code ${s.testEventCode} is included, so Meta shows this under Test Events and does not count it.`);
    return {
      destination,
      method: 'POST',
      url: `https://graph.facebook.com/${DEFAULT_META_API_VERSION}/${s?.datasetId ?? '<dataset id>'}/events`,
      body: { data: [event], ...(s?.testEventCode ? { test_event_code: s.testEventCode } : {}) },
      notes,
    };
  }

  const g = settings as GoogleAdsSettings | null;
  if (!g) notes.push('Google Ads is not connected yet, so the account and conversion action below are placeholders.');
  const request = buildGoogleRequest(ctx, g ?? { customerId: '<customer id>', conversionActionId: '<conversion action id>' });
  if (!request) return { error: 'Nothing to match on: no click ID, hashed email or phone.' };
  return { destination, method: 'POST', url: `${DATA_MANAGER_BASE}/${DATA_MANAGER_VERSION}/events:ingest`, body: request, notes };
}
