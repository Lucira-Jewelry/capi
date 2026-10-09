import {
  evaluateDelivery,
  hashEmailForGoogle,
  hashEmailForMeta,
  hashPhoneForGoogle,
  hashPhoneForMeta,
  identityKeyForEmail,
  identityKeyForPhone,
  type Destination,
} from '@datahash/core';
import type { DeliveryDraft, PersonHashes, SalesRepo, Store } from '@datahash/store';
import type { IncomingSale, IngestTenant } from './types';

export interface PipelineDeps {
  store: Pick<Store, 'lookupForSale' | 'isSuppressed'>;
  sales: Pick<SalesRepo, 'recordSale'>;
  now?: () => Date;
}

export interface ProcessResult {
  saleKey: string;
  duplicate: boolean;
  /** True if this customer had identified themselves on the website (so click IDs may be available). */
  matchedPerson: boolean;
  deliveries: Array<{ destination: Destination; status: 'pending' | 'skipped'; reason?: string }>;
}

function saleHashes(sale: IncomingSale, country: IngestTenant['defaultCountry']): PersonHashes {
  const h: PersonHashes = {};
  const mp = hashPhoneForMeta(sale.phone, country);
  const gp = hashPhoneForGoogle(sale.phone, country);
  const me = hashEmailForMeta(sale.email);
  const ge = hashEmailForGoogle(sale.email);
  if (mp) h.metaPhone = mp;
  if (gp) h.googlePhone = gp;
  if (me) h.metaEmail = me;
  if (ge) h.googleEmail = ge;
  return h;
}

/**
 * Turn one normalised sale into a stored sale plus a pending/skipped delivery per destination.
 * Sending itself happens later (Part 4).
 */
export async function processSale(sale: IncomingSale, tenant: IngestTenant, deps: PipelineDeps): Promise<ProcessResult> {
  const now = deps.now ? deps.now() : new Date();
  const country = tenant.defaultCountry;

  const contact = { phone: sale.phone ?? null, email: sale.email ?? null, defaultCountry: country };
  const found = sale.phone || sale.email ? await deps.store.lookupForSale(contact) : null;

  // The sale's own contact details win; the stored person fills any gaps.
  const hashes: PersonHashes = { ...(found?.person.hashes ?? {}), ...saleHashes(sale, country) };

  // Consent: what the source said (CRM field, captured at the counter), else what the website recorded.
  const consentAds = sale.consent ?? found?.person.consent?.ads ?? null;
  const consent = consentAds === null ? undefined : { ads: consentAds };

  const event = {
    eventId: sale.eventId,
    eventName: sale.eventName,
    channel: sale.channel,
    occurredAt: sale.occurredAt,
    ...(sale.value !== undefined ? { value: sale.value } : {}),
    ...(sale.currency ? { currency: sale.currency } : {}),
  };

  // The customer's hashed identity keys: stored on the sale so a later withdrawal of consent can find it.
  const identityKeys = [identityKeyForPhone(sale.phone, country), identityKeyForEmail(sale.email)].filter((k): k is string => Boolean(k));
  const withdrawn = await deps.store.isSuppressed(identityKeys);

  const drafts: DeliveryDraft[] = tenant.destinations.map((destination): DeliveryDraft => {
    if (withdrawn) return { destination, status: 'skipped', skipReason: 'consent_withdrawn' };
    const identity =
      destination === 'meta'
        ? { phoneHash: hashes.metaPhone, emailHash: hashes.metaEmail }
        : { phoneHash: hashes.googlePhone, emailHash: hashes.googleEmail };

    const result = evaluateDelivery({
      event,
      destination,
      identity,
      consent,
      consentPolicy: tenant.consentPolicy,
      touches: found?.touches ?? [],
      allowedChannels: tenant.allowedChannels,
      now,
    });

    if (result.action === 'skip') return { destination, status: 'skipped', skipReason: result.reason };
    return {
      destination,
      status: 'pending',
      ...(result.touch ? { touchId: result.touch.id } : {}),
    };
  });

  const { saleKey, duplicate } = await deps.sales.recordSale(
    {
      source: sale.source,
      eventId: sale.eventId,
      eventName: sale.eventName,
      channel: sale.channel,
      occurredAt: sale.occurredAt,
      ...(sale.value !== undefined ? { value: sale.value } : {}),
      ...(sale.currency ? { currency: sale.currency } : {}),
      ...(sale.storeName ? { storeName: sale.storeName } : {}),
      personId: found?.person.id ?? null,
      hashes,
      consentAds,
      ...(identityKeys.length ? { identityKeys } : {}),
    },
    drafts,
    now,
  );

  return {
    saleKey,
    duplicate,
    matchedPerson: Boolean(found),
    deliveries: drafts.map((d) => ({
      destination: d.destination,
      status: d.status,
      ...(d.skipReason ? { reason: d.skipReason } : {}),
    })),
  };
}
