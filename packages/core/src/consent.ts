import type { ConsentPolicy, ConsentState } from './types';

/** Can this person's data be sent to ad platforms under the tenant's consent policy? */
export function hasAdConsent(consent: ConsentState | undefined | null, policy: ConsentPolicy): boolean {
  if (policy.mode === 'opt_in') return consent?.ads === true;
  // opt_out: allowed unless the person explicitly declined
  return consent?.ads !== false;
}
