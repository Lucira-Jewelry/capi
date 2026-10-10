import type { ConsentState } from '@datahash/core';

/** What we keep per person. Hashes and internal keys: never the plain phone, email or name (see the fields marked "as given"). */
export interface PersonHashes {
  metaPhone?: string;
  googlePhone?: string;
  metaEmail?: string;
  googleEmail?: string;
  // Extra details that raise the match rate. All hashed except the ones marked "as given".
  metaFirstName?: string;
  metaLastName?: string;
  metaCity?: string;
  metaState?: string;
  metaZip?: string;
  metaCountry?: string;
  /** The brand's own customer ID, hashed. */
  metaExternalId?: string;
  googleFirstName?: string;
  googleLastName?: string;
  /** As given: Google takes the country code and postal code of an address unhashed. */
  googleRegion?: string;
  googlePostal?: string;
  /** As given: Meta's browser ID cookie (_fbp), seen on the website. */
  fbp?: string;
}

export interface StoredConsent extends ConsentState {
  updatedAt: Date;
  source?: string;
  textVersion?: string;
}

export interface StoredPerson {
  id: string;
  phoneKey?: string;
  emailKey?: string;
  hashes: PersonHashes;
  consent?: StoredConsent;
  firstSeen: Date;
  lastSeen: Date;
  /** Firestore TTL field: the person disappears after the retention period without activity. */
  expiresAt: Date;
  mergedInto?: string;
}

export interface IncomingTouch {
  /** Original click time (Date or epoch ms). Never "now". */
  clickedAt: Date | number;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  fbc?: string;
  ctwaClid?: string;
  utm?: Record<string, string>;
  landingUrl?: string;
}

export interface IdentifyInput {
  phone?: string | null;
  email?: string | null;
  defaultCountry?: 'IN' | 'US' | 'GB' | 'AE' | 'SG';
  consent?: { ads: boolean; source?: string; textVersion?: string };
  /** Meta's browser ID cookie from the visitor's browser. */
  fbp?: string | null;
  touches?: IncomingTouch[];
  now?: Date;
}

export type IdentifyResult =
  | { status: 'ok'; personId: string; created: boolean; merged: boolean; touchesWritten: number }
  | { status: 'rejected'; reason: 'no_valid_identifier' };

export interface StoreOptions {
  /** Brand identifier. All data lives under tenants/{tenantId}/... */
  tenantId: string;
  /** Days to keep people and touches after the last activity / click. Default 90. */
  retentionDays?: number;
}
