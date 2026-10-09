import type { Firestore } from '@google-cloud/firestore';

/**
 * The operator's pause switch for all sending, kept in Firestore so that every running instance obeys it within a few
 * seconds, with no redeploy. (The OUTBOUND_SENDS setting is the other half: that one is fixed when an instance starts.)
 *
 * It stops the NEXT delivery: a request that is already on its way to a platform cannot be recalled.
 */
export interface SendPause {
  paused: boolean;
  reason?: string;
  at?: Date;
}

export interface SendControlOptions {
  /** How long a read is reused. Default 3 s: the longest a pause can take to reach a busy instance. */
  cacheMs?: number;
  now?: () => number;
}

export class SendControl {
  private cached: { at: number; value: SendPause } | null = null;
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly db: Firestore, opts: SendControlOptions = {}) {
    this.cacheMs = opts.cacheMs ?? 3000;
    this.now = opts.now ?? (() => Date.now());
  }

  private get doc() {
    return this.db.collection('system').doc('sending');
  }

  /**
   * `fresh` reads the database, ignoring the cache. Use it for the decision to actually send; the cache is only for
   * showing the state on screen and for the cheap early skip.
   */
  async get(opts: { fresh?: boolean } = {}): Promise<SendPause> {
    if (!opts.fresh && this.cached && this.now() - this.cached.at < this.cacheMs) return this.cached.value;
    const snap = await this.doc.get();
    const d = snap.data();
    const value: SendPause = d?.paused === true ? { paused: true, ...(d.reason ? { reason: String(d.reason) } : {}), ...(d.at?.toDate ? { at: d.at.toDate() } : {}) } : { paused: false };
    this.cached = { at: this.now(), value };
    return value;
  }

  async set(paused: boolean, reason?: string, at: Date = new Date()): Promise<SendPause> {
    await this.doc.set({ paused, reason: reason ? reason.slice(0, 200) : null, at });
    this.cached = null;
    return this.get();
  }
}
