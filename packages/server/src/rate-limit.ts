import type { IncomingMessage } from 'node:http';

/**
 * Slows down guessing of the operator tokens. After too many wrong tokens from one address that address is locked
 * out for a while, even if it then sends the right one; a correct token from an address that is not locked out
 * clears its count.
 *
 * It lives in memory, so each server instance counts for itself. With a long random token (the server insists on one
 * in production) guessing is hopeless either way; this keeps the logs quiet and the attempts cheap to refuse.
 */
export interface LimiterOptions {
  /** Wrong tokens allowed within `windowMs` before the lock. Default 10. */
  maxFailures?: number;
  /** Default 15 minutes. */
  windowMs?: number;
  /** How long the lock lasts. Default 15 minutes. */
  lockMs?: number;
  /** Most addresses remembered at once, so an attacker cannot grow memory. Default 10 000. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: LimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 10;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.lockMs = opts.lockMs ?? 15 * 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Seconds until this address may try again, or 0 if it may try now. */
  retryAfterSec(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const left = e.lockedUntil - this.now();
    if (left > 0) return Math.ceil(left / 1000);
    if (e.lockedUntil > 0) this.entries.delete(key); // the lock has run out: start fresh
    return 0;
  }

  /** A wrong token. Returns true if this one triggered the lock. */
  fail(key: string): boolean {
    const now = this.now();
    let e = this.entries.get(key);
    if (!e || now - e.windowStart > this.windowMs) {
      this.makeRoom();
      e = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.entries.set(key, e);
    }
    e.failures++;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = now + this.lockMs;
      return true;
    }
    return false;
  }

  /** A right token: forget earlier wrong ones. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  private makeRoom() {
    if (this.entries.size < this.maxEntries) return;
    const now = this.now();
    for (const [k, e] of this.entries) if (e.lockedUntil <= now && now - e.windowStart > this.windowMs) this.entries.delete(k);
    // Still full: drop the oldest records (insertion order) rather than refuse new ones.
    for (const k of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(k);
    }
  }
}

/**
 * The address a request really came from. Behind Google's front end (Cloud Run) the proxy appends the client's address
 * to X-Forwarded-For; anything before it was written by the client and cannot be trusted, so count from the END:
 * `trustedHops` is how many proxies of ours sit in front (1 for Cloud Run directly, 2 behind a load balancer).
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustedHops = 1): string {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  const parts = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (trustedHops > 0 && parts.length >= trustedHops) return parts[parts.length - trustedHops]!;
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * A plain request budget per address: at most `limit` requests in each `windowMs`. For the public endpoints, where
 * nothing is secret to guess but anyone on the internet can call them: it keeps one address from running up our
 * database bill or filling it, and costs nothing for a normal visitor.
 */
export class RateLimiter {
  private readonly entries = new Map<string, { count: number; windowStart: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { limit: number; windowMs?: number; maxEntries?: number; now?: () => number }) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxEntries = opts.maxEntries ?? 20_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Counts a request. Returns 0 if it is allowed, otherwise the seconds until the address has budget again. */
  take(key: string): number {
    const now = this.now();
    let e = this.entries.get(key);
    if (!e || now - e.windowStart >= this.windowMs) {
      if (this.entries.size >= this.maxEntries) this.makeRoom(now);
      e = { count: 0, windowStart: now };
      this.entries.set(key, e);
    }
    e.count++;
    return e.count > this.limit ? Math.max(1, Math.ceil((e.windowStart + this.windowMs - now) / 1000)) : 0;
  }

  private makeRoom(now: number) {
    for (const [k, e] of this.entries) if (now - e.windowStart >= this.windowMs) this.entries.delete(k);
    for (const k of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(k);
    }
  }
}
