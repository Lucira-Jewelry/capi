export type Destination = 'meta' | 'google_ads';

export type Channel = 'online' | 'store' | 'whatsapp' | 'web_lead';

export interface Touch {
  id: string;
  /** ORIGINAL click time. Never rewrite this: fbc is built from it. */
  clickedAt: Date;
  expiresAt?: Date;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  fbc?: string;
  ctwaClid?: string;
  utm?: Record<string, string>;
}

export interface ConsentState {
  /** true = consented to ad-platform sharing, false = declined, undefined/null = unknown */
  ads?: boolean | null;
}

export interface ConsentPolicy {
  /** opt_in: need an explicit yes (DPDP, GDPR). opt_out: allowed unless the person said no. */
  mode: 'opt_in' | 'opt_out';
}

export interface BusinessEvent {
  eventId: string;
  eventName: string;
  channel: Channel;
  occurredAt: Date;
  value?: number;
  currency?: string;
}

export interface Identity {
  phoneHash?: string;
  emailHash?: string;
}
