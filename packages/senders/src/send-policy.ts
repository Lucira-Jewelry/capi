/**
 * The switch that decides whether this server may send customer data to ad platforms at all.
 *
 * It is enforced inside the dispatcher, so it holds for every way of sending: the scheduler, the "Send waiting
 * sales now" button, and anything added later. Turning the scheduler off alone does not stop a manual send.
 *
 *   OUTBOUND_SENDS=on|off            default off: nothing leaves this server until it is switched on
 *   SEND_ALLOWED_TENANTS=a,b         optional: only these brands may send (unset = every brand)
 *   SEND_ALLOWED_DESTINATIONS=meta   optional: only these platforms (meta, google_ads); unset = both
 *
 * Deliveries that are blocked are left exactly as they are (still queued, not claimed, no attempt counted), so
 * switching sending on later sends them.
 */
export interface SendPolicy {
  enabled: boolean;
  /** Undefined = every brand. */
  tenants?: string[];
  /** Undefined = every platform. */
  destinations?: string[];
}

const list = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export function parseSendPolicy(env: Record<string, string | undefined>): SendPolicy {
  const raw = env.OUTBOUND_SENDS?.trim().toLowerCase();
  if (raw !== undefined && raw !== '' && raw !== 'on' && raw !== 'off') {
    throw new Error(`OUTBOUND_SENDS must be "on" or "off" (got "${env.OUTBOUND_SENDS}")`);
  }
  const tenants = list(env.SEND_ALLOWED_TENANTS);
  const destinations = list(env.SEND_ALLOWED_DESTINATIONS);
  for (const d of destinations ?? []) {
    if (d !== 'meta' && d !== 'google_ads') throw new Error(`SEND_ALLOWED_DESTINATIONS: unknown destination "${d}" (use meta, google_ads)`);
  }
  return { enabled: raw === 'on', ...(tenants ? { tenants } : {}), ...(destinations ? { destinations } : {}) };
}

/**
 * Why a send is not allowed, or null if it is. Without a destination it answers for the whole brand.
 * The reasons are written for the person pressing the button.
 */
export function sendBlockReason(policy: SendPolicy, tenantId: string, destination?: string): string | null {
  if (!policy.enabled) return 'Sending is switched off on this server (OUTBOUND_SENDS is not "on"). Nothing was sent.';
  if (policy.tenants && !policy.tenants.includes(tenantId)) return 'This brand is not on the list of brands allowed to send from this server. Nothing was sent.';
  if (destination && policy.destinations && !policy.destinations.includes(destination)) return `Sending to ${destination} is not allowed on this server.`;
  return null;
}

/** For the admin screens: can this brand send, and to which platforms? */
export function describeSendPolicy(policy: SendPolicy, tenantId: string): { allowed: boolean; reason?: string; destinations?: string[] } {
  const reason = sendBlockReason(policy, tenantId);
  return { allowed: !reason, ...(reason ? { reason } : {}), ...(!reason && policy.destinations ? { destinations: policy.destinations } : {}) };
}
