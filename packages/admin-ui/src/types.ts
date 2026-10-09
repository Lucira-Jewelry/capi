export interface ZohoMapping {
  dealId: string;
  stage?: string;
  wonStages?: string[];
  amount: string;
  occurredAt: string;
  fallbackOccurredAt?: string;
  dateOnlyOffset?: string;
  phone: string;
  email?: string;
  store?: string;
  channel: string;
  storeChannelValues: string[];
  whatsappChannelValues?: string[];
  onlineChannelValues?: string[];
  consent?: string;
  consentTrueValues?: string[];
  currency?: string;
  eventName?: string;
}

export interface Tenant {
  tenantId: string;
  name: string;
  status: 'active' | 'suspended';
  consentPolicy: { mode: 'opt_in' | 'opt_out' };
  allowedChannels: string[];
  destinations: string[];
  defaultCountry: string;
  retentionDays: number;
  sources: { zoho?: ZohoMapping };
  createdAt: string;
}

export interface Connection {
  kind: 'meta' | 'google_ads';
  secretSet: boolean;
  status: 'active' | 'error';
  lastError?: string;
  updatedAt: string;
  datasetId?: string;
  testEventCode?: string;
  customerId?: string;
  loginCustomerId?: string;
  conversionActionId?: string;
  authMethod?: 'oauth' | 'service_account';
}

export interface SiteKey {
  key: string;
  origins: string[];
  label?: string;
  snippet: string;
  /** The brand's own tracking address and the DNS record that points it at us. */
  trackingHost?: string;
  dns?: { type: string; name: string; short: string; target: string; local: boolean; ready: boolean };
}

export interface TenantView {
  tenant: Tenant;
  siteKeys: SiteKey[];
  connections: Connection[];
  webhooks: { zoho: string; generic: string };
  /** Whether this server may send for the brand at all (it can be switched off, or limited to some brands or platforms). */
  sending?: { allowed: boolean; reason?: string; destinations?: string[] };
}

export interface Delivery {
  destination: string;
  status: string;
  skipReason?: string;
  attempts: number;
  lastError?: string;
  response?: string;
  touchId?: string;
  nextRetryAt?: string;
  /** Google processes accepted requests later: processing, success, partial, rejected or unknown. */
  processingStatus?: 'processing' | 'success' | 'partial' | 'rejected' | 'unknown';
  processingDetail?: string;
  externalRequestId?: string;
}

export interface SaleSummary {
  saleKey: string;
  sale: {
    eventId: string;
    eventName: string;
    channel: string;
    occurredAt: string;
    value?: number;
    currency?: string;
    storeName?: string;
    personId: string | null;
    source: string;
  };
  deliveries: Delivery[];
}

export interface Stats {
  sales: number;
  matchedToPerson: number;
  byChannel: Record<string, number>;
  deliveries: Record<string, Record<string, number>>;
  skipReasons: Record<string, Record<string, number>>;
  processing?: Record<string, Record<string, number>>;
  withClickId: number;
  contactOnly: number;
}

/** Whether the server may send, and whether an operator has paused it. */
export interface SendOverview {
  /** The server's own setting (OUTBOUND_SENDS). */
  enabled: boolean;
  paused: boolean;
  reason?: string;
  at?: string;
  tenants?: string[];
  destinations?: string[];
}

export interface Meta {
  channels: string[];
  destinations: string[];
  countries: string[];
  importColumns: string[];
  importTemplate: string;
  defaultZohoMapping: ZohoMapping;
  /** What the server can log in to Google with. */
  google: { serviceAccountEmail?: string; oauthConfigured: boolean };
}

export const DEST_LABEL: Record<string, string> = { meta: 'Meta', google_ads: 'Google Ads' };
export const CHANNEL_LABEL: Record<string, string> = { store: 'In store', online: 'Online', whatsapp: 'WhatsApp', web_lead: 'Website lead' };
export const SKIP_LABEL: Record<string, string> = {
  no_consent: 'No consent to share',
  channel_filtered: 'Channel not reported for this brand',
  no_identifiers: 'No phone, email or click ID',
  too_old: 'Too old for the platform',
  consent_withdrawn: 'Customer withdrew consent',
};
