import type { Channel, ZohoMapping } from '@datahash/core';
import type { AdapterResult } from '../types';
import { asString, getPath, parseAmount, parseDate } from '../util';

export type { ZohoMapping };

/**
 * A starting point for onboarding a new Zoho brand, using common field names. Every brand's real Zoho API
 * names go into that tenant's own mapping (stored in the database), never into code.
 * Phone and email live on the Contact, so the webhook must include them (merge fields) or the sync must select them.
 */
export const DEFAULT_ZOHO_MAPPING: ZohoMapping = {
  dealId: 'id',
  stage: 'Stage',
  wonStages: ['Closed Won'],
  amount: 'Amount',
  occurredAt: 'Closing_Date',
  fallbackOccurredAt: 'Modified_Time',
  phone: 'Contact_Name.Mobile',
  email: 'Contact_Name.Email',
  store: 'Store',
  channel: 'Sale_Channel',
  storeChannelValues: ['store', 'in-store', 'showroom', 'offline'],
  whatsappChannelValues: ['whatsapp'],
  onlineChannelValues: ['online', 'website', 'shopify'],
  consent: 'Ad_Consent',
  currency: 'INR',
  eventName: 'Purchase',
};

/** The optional customer-detail mapping fields, which are the same names as on the sale. */
const DETAIL_FIELDS = ['firstName', 'lastName', 'city', 'state', 'postalCode', 'country', 'customerId'] as const;

const DEFAULT_TRUE = ['true', 'yes', 'y', '1', 'consented', 'granted', 'agreed'];

const norm = (s: string) => s.trim().toLowerCase();

/** Every Zoho field the mapping reads. The daily sync uses this to select the right columns. */
export function zohoFieldsFromMapping(m: ZohoMapping): string[] {
  return [
    ...new Set(
      [m.dealId, m.stage, m.amount, m.occurredAt, m.fallbackOccurredAt, m.phone, m.email, ...DETAIL_FIELDS.map((f) => m[f]), m.store, m.channel, m.consent].filter(
        (f): f is string => Boolean(f),
      ),
    ),
  ];
}

/** Paths holding plain contact details. */
export function zohoPiiPaths(m: ZohoMapping): string[] {
  return [m.phone, m.email, ...DETAIL_FIELDS.map((f) => m[f])].filter((f): f is string => Boolean(f));
}

/**
 * What is safe to keep in the ingest log: only the fields the mapping reads, never the rest of the record
 * (names, addresses, alternate contacts...), with phone and email shown as "[redacted]" so the log still shows
 * whether they were present.
 */
export function zohoLogView(record: unknown, m: ZohoMapping): Record<string, unknown> {
  const pii = new Set(zohoPiiPaths(m));
  const out: Record<string, unknown> = {};
  for (const path of zohoFieldsFromMapping(m)) {
    const value = getPath(record, path);
    if (value === undefined || value === null || value === '') continue;
    out[path] = pii.has(path) ? '[redacted]' : typeof value === 'object' ? '[object]' : value;
  }
  return out;
}

export function mapZohoDeal(record: unknown, m: ZohoMapping): AdapterResult {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'invalid_payload' };

  if (m.stage) {
    const stage = asString(getPath(record, m.stage));
    const won = (m.wonStages ?? []).map(norm);
    if (!stage || !won.includes(norm(stage))) return { ok: false, reason: 'not_won', detail: stage };
  }

  const eventId = asString(getPath(record, m.dealId));
  if (!eventId) return { ok: false, reason: 'missing_deal_id' };

  const value = parseAmount(getPath(record, m.amount));
  if (value === null || value < 0) return { ok: false, reason: 'invalid_amount', detail: String(getPath(record, m.amount)) };

  const occurredAt =
    parseDate(getPath(record, m.occurredAt), m.dateOnlyOffset) ??
    (m.fallbackOccurredAt ? parseDate(getPath(record, m.fallbackOccurredAt), m.dateOnlyOffset) : null);
  if (!occurredAt) return { ok: false, reason: 'invalid_date' };

  const rawChannel = asString(getPath(record, m.channel));
  const channel = resolveChannel(rawChannel, m);
  if (!channel) return { ok: false, reason: 'unknown_channel', detail: rawChannel };

  const sale: AdapterResultSale = {
    source: 'zoho',
    eventId,
    eventName: m.eventName ?? 'Purchase',
    channel,
    occurredAt,
    value,
    currency: m.currency ?? 'INR',
  };

  const store = m.store ? asString(getPath(record, m.store)) : undefined;
  if (store) sale.storeName = store;
  const phone = asString(getPath(record, m.phone));
  if (phone) sale.phone = phone;
  const email = m.email ? asString(getPath(record, m.email)) : undefined;
  if (email) sale.email = email;
  for (const f of DETAIL_FIELDS) {
    const v = m[f] ? asString(getPath(record, m[f]!)) : undefined;
    if (v) sale[f] = v;
  }

  if (m.consent) {
    const raw = asString(getPath(record, m.consent));
    if (raw !== undefined) {
      const yes = (m.consentTrueValues ?? DEFAULT_TRUE).map(norm);
      sale.consent = yes.includes(norm(raw));
    }
  }
  return { ok: true, sale };
}

type AdapterResultSale = Extract<AdapterResult, { ok: true }>['sale'];

function resolveChannel(raw: string | undefined, m: ZohoMapping): Channel | null {
  if (!raw) return null;
  const v = norm(raw);
  if (m.storeChannelValues.map(norm).includes(v)) return 'store';
  if ((m.whatsappChannelValues ?? []).map(norm).includes(v)) return 'whatsapp';
  if ((m.onlineChannelValues ?? []).map(norm).includes(v)) return 'online';
  return null;
}
