import type { Destination, Touch } from './types';

export function touchHasIdFor(touch: Touch, destination: Destination): boolean {
  if (destination === 'meta') return Boolean(touch.fbc || touch.fbclid || touch.ctwaClid);
  return Boolean(touch.gclid || touch.gbraid || touch.wbraid);
}

/**
 * Pick the touch to credit: the most recent touch BEFORE (or at) the sale that carries an ID
 * the destination understands and has not expired.
 */
export function selectTouch(
  touches: Touch[],
  occurredAt: Date,
  destination: Destination,
  now: Date = new Date(),
): Touch | null {
  const candidates = touches.filter(
    (t) =>
      touchHasIdFor(t, destination) &&
      t.clickedAt.getTime() <= occurredAt.getTime() &&
      (!t.expiresAt || t.expiresAt.getTime() > now.getTime()),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.clickedAt.getTime() - a.clickedAt.getTime());
  return candidates[0]!;
}
