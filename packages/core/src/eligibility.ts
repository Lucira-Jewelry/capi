import { hasAdConsent } from './consent';
import { selectTouch } from './touches';
import type {
  BusinessEvent,
  Channel,
  ConsentPolicy,
  ConsentState,
  Destination,
  Identity,
  Touch,
} from './types';

export interface AgeLimits {
  /** Google accepts offline conversions up to about 90 days after the click. VERIFY. */
  googleMaxDays: number;
  /** Meta: website events must be recent. VERIFY the current limit. */
  metaWebMaxDays: number;
  /** Meta: offline / non-website events allow a longer window. VERIFY the current limit. */
  metaOfflineMaxDays: number;
}

export const DEFAULT_AGE_LIMITS: AgeLimits = {
  googleMaxDays: 90,
  metaWebMaxDays: 7,
  metaOfflineMaxDays: 62,
};

export interface EligibilityInput {
  event: BusinessEvent;
  destination: Destination;
  identity: Identity;
  consent: ConsentState | undefined | null;
  consentPolicy: ConsentPolicy;
  touches: Touch[];
  /** Channels this tenant wants reported (e.g. skip 'online' when Shopify apps already report it). */
  allowedChannels: Channel[];
  now?: Date;
  limits?: AgeLimits;
}

export type SkipReason = 'no_consent' | 'channel_filtered' | 'no_identifiers' | 'too_old';

export type EligibilityResult =
  | { action: 'send'; touch: Touch | null }
  | { action: 'skip'; reason: SkipReason };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Is this sale too old for the platform's window? Used when deciding to send and again right before each
 * (re)try, because a queued delivery can age out while it waits.
 */
export function exceedsAgeLimit(
  destination: Destination,
  event: Pick<BusinessEvent, 'occurredAt' | 'channel'>,
  touch: Pick<Touch, 'clickedAt'> | null,
  now: Date,
  limits: AgeLimits = DEFAULT_AGE_LIMITS,
): boolean {
  if (destination === 'google_ads') {
    // With a click ID the click age counts; otherwise the sale age counts.
    const anchor = touch ? touch.clickedAt : event.occurredAt;
    return now.getTime() - anchor.getTime() > limits.googleMaxDays * DAY_MS;
  }
  const maxDays = event.channel === 'online' || event.channel === 'web_lead' ? limits.metaWebMaxDays : limits.metaOfflineMaxDays;
  return now.getTime() - event.occurredAt.getTime() > maxDays * DAY_MS;
}

/** The order of checks matters: consent, channel, identifiers, touch, age. */
export function evaluateDelivery(input: EligibilityInput): EligibilityResult {
  const now = input.now ?? new Date();
  const limits = input.limits ?? DEFAULT_AGE_LIMITS;
  const { event, destination } = input;

  if (!hasAdConsent(input.consent, input.consentPolicy)) {
    return { action: 'skip', reason: 'no_consent' };
  }
  if (!input.allowedChannels.includes(event.channel)) {
    return { action: 'skip', reason: 'channel_filtered' };
  }

  const touch = selectTouch(input.touches, event.occurredAt, destination, now);
  if (!input.identity.phoneHash && !input.identity.emailHash && !touch) {
    return { action: 'skip', reason: 'no_identifiers' };
  }

  if (exceedsAgeLimit(destination, event, touch, now, limits)) {
    return { action: 'skip', reason: 'too_old' };
  }

  return { action: 'send', touch };
}
