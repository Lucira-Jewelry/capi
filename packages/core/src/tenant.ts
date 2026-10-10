import type { Channel, ConsentPolicy, Destination } from './types';

/**
 * Where each piece of a sale lives in a brand's Zoho records. Values are Zoho API field names
 * (or dotted paths into lookups, e.g. "Contact_Name.Mobile"). Every brand supplies its own mapping.
 */
export interface ZohoMapping {
  dealId: string;
  /** Stage field and the stage values that count as won. If `stage` is omitted, every record is treated as won. */
  stage?: string;
  wonStages?: string[];
  amount: string;
  /** Sale time. Date-only values get 12:00 in `dateOnlyOffset`. */
  occurredAt: string;
  /** Used when `occurredAt` is empty. */
  fallbackOccurredAt?: string;
  dateOnlyOffset?: string;
  phone: string;
  email?: string;
  /** Optional customer details (same style of path as `phone`). Each one raises the match rate. */
  firstName?: string;
  lastName?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  /** The contact's own ID in Zoho, sent to the platforms as a hashed customer ID. */
  customerId?: string;
  store?: string;
  channel: string;
  storeChannelValues: string[];
  whatsappChannelValues?: string[];
  onlineChannelValues?: string[];
  /** CRM field holding the customer's consent for ad-platform sharing. */
  consent?: string;
  consentTrueValues?: string[];
  currency?: string;
  eventName?: string;
}

export type CountryCode = 'IN' | 'US' | 'GB' | 'AE' | 'SG';

/** Everything that differs from one brand (tenant) to the next. Stored in the database, never in code. */
export interface TenantConfig {
  tenantId: string;
  name: string;
  status: 'active' | 'suspended';
  consentPolicy: ConsentPolicy;
  /** Channels reported to ad platforms. Leave 'online' out when another tool already reports online sales. */
  allowedChannels: Channel[];
  destinations: Destination[];
  defaultCountry: CountryCode;
  /** Days to keep people and touches. */
  retentionDays: number;
  /** Per-source field mappings. */
  sources: { zoho?: ZohoMapping };
  createdAt: Date;
}

/** A public key embedded in a brand's website script. */
export interface SiteKeyRecord {
  key: string;
  tenantId: string;
  /** Page origins allowed to use the key, e.g. ["https://www.brand.com"]. */
  origins: string[];
  label?: string;
  /**
   * The brand's own tracking address, e.g. "track.brand.com" (a CNAME to our collector). When set, the script is
   * loaded from and talks to this address, which the browser treats as the brand's own site, and the collector sets
   * its first-party cookie there. Local development may include a port ("track.brand.localhost:8787").
   */
  trackingHost?: string;
}

/**
 * A hostname the brand can point at us. Lower case, letters/digits/hyphens, at least two labels, no scheme, path or
 * IP address. A port is only allowed on *.localhost, for local testing. Returns the clean value or an error message.
 */
export function parseTrackingHost(raw: string): { ok: true; host: string } | { ok: false; error: string } {
  const host = raw.trim().toLowerCase();
  const m = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(:(\d{2,5}))?$/.exec(host);
  if (!m) return { ok: false, error: 'Use just the address, for example track.brand.com (no https://, no path).' };
  const name = m[1]!;
  if (m[6] && !name.endsWith('.localhost')) return { ok: false, error: 'A port is only allowed for local testing (*.localhost).' };
  if (/^\d+(\.\d+)+$/.test(name)) return { ok: false, error: 'Use a name, not an IP address.' };
  if (name.length > 253) return { ok: false, error: 'That address is too long.' };
  return { ok: true, host };
}
