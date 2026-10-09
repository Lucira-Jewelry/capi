import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, type DocumentData, type DocumentReference, type Firestore } from '@google-cloud/firestore';
import type { Channel, Destination } from '@datahash/core';
import type { PersonHashes } from './types';

/**
 * pending  - waiting to be sent
 * sending  - claimed by a worker (has a lease; if the worker dies the lease expires and it is retried)
 * retry    - a send failed temporarily; will be tried again at nextRetryAt
 * sent / failed - final (failed can be resent by hand); skipped - never eligible (reason recorded)
 */
export type DeliveryStatus = 'pending' | 'sending' | 'retry' | 'sent' | 'failed' | 'skipped';

export interface SaleRecord {
  source: string;
  eventId: string;
  eventName: string;
  channel: Channel;
  occurredAt: Date;
  value?: number;
  currency?: string;
  storeName?: string;
  /** Person found in our store, if this customer identified themselves on the website before. */
  personId: string | null;
  /** Hashes of the sale's own contact details (never the plain phone or email). */
  hashes: PersonHashes;
  /** Consent that applied to this sale (CRM field first, else the person's stored consent). */
  consentAds: boolean | null;
  /**
   * Hashed identity keys of the customer (see identityKeyForPhone/Email). Lets a later withdrawal of consent
   * find and stop this sale even when the customer never identified on the website.
   */
  identityKeys?: string[];
}

export interface DeliveryDraft {
  destination: Destination;
  status: 'pending' | 'skipped';
  skipReason?: string;
  touchId?: string;
}

/**
 * What the platform did with an accepted request, for platforms that process asynchronously (Google Data Manager).
 * processing - accepted, result not known yet; success - processed; partial - some records rejected;
 * rejected - all records rejected; unknown - no result within 24 hours.
 */
export type ProcessingStatus = 'processing' | 'success' | 'partial' | 'rejected' | 'unknown';

export interface StoredDelivery extends Omit<DeliveryDraft, 'status'> {
  tenantId: string;
  saleKey: string;
  status: DeliveryStatus;
  /** Real send attempts to the platform. Waiting for a connection or a lost claim does not count. */
  attempts: number;
  /** Times a worker claimed it. Capped by the dispatcher so a delivery that keeps crashing workers is not retried forever. */
  claims: number;
  createdAt: Date;
  updatedAt: Date;
  leaseUntil?: Date;
  /** Token of the worker holding the lease. Only that worker may write the result. */
  leaseOwner?: string;
  nextRetryAt?: Date;
  sentAt?: Date;
  lastError?: string;
  /** Short, non-sensitive summary of the platform's answer (for example how many events it received). */
  response?: string;
  /** The platform's ID for the request, needed to look up its processing result and for support. */
  externalRequestId?: string;
  processingStatus?: ProcessingStatus;
  processingNextCheckAt?: Date;
  processingChecks?: number;
  /** Plain-language summary of the processing result, for example "INVALID_CONVERSION_ACTION_TYPE x1". */
  processingDetail?: string;
}

export interface DeliveryOutcome {
  status: 'sent' | 'failed' | 'retry' | 'skipped' | 'pending';
  error?: string;
  response?: string;
  nextRetryAt?: Date;
  /** For status 'skipped': why (for example consent_withdrawn). */
  skipReason?: string;
  /** The token returned by claimDelivery. If another worker has taken over, the write is refused. */
  leaseToken?: string;
  /** Set to false when no request reached the platform (for example the account is not connected yet). */
  countAttempt?: boolean;
  /** The platform's request ID. With `processingNextCheckAt` it starts tracking the asynchronous processing result. */
  requestId?: string;
  processingNextCheckAt?: Date;
}

export interface SaleSummary {
  saleKey: string;
  sale: SaleRecord & { createdAt: Date };
  deliveries: StoredDelivery[];
}

export interface SalesStats {
  since: Date;
  sales: number;
  /** Sales whose customer had identified on the website, so click IDs could be used. */
  matchedToPerson: number;
  byChannel: Record<string, number>;
  /** destination -> status -> count */
  deliveries: Record<string, Record<string, number>>;
  /** destination -> reason -> count */
  skipReasons: Record<string, Record<string, number>>;
  /** destination -> processing result -> count, for sent deliveries the platform processes asynchronously. */
  processing: Record<string, Record<string, number>>;
  /** Deliveries sent or pending that carry a click ID vs contact details only. */
  withClickId: number;
  contactOnly: number;
}

/** Same source + event ID always gives the same key, so a replayed webhook or the daily sync is a no-op. */
export function saleKey(source: string, eventId: string): string {
  return createHash('sha256').update(`${source}|${eventId}`).digest('hex').slice(0, 32);
}

export interface SalesOptions {
  tenantId: string;
  /** Days to keep sale and delivery records (they hold hashes, no plain contact details). Default 400. */
  retentionDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const optDate = (v: unknown): Date | undefined =>
  v && typeof (v as { toDate?: unknown }).toDate === 'function' ? (v as { toDate(): Date }).toDate() : undefined;

function toSale(d: DocumentData): SaleRecord & { createdAt: Date } {
  return { ...d, occurredAt: d.occurredAt.toDate(), createdAt: d.createdAt.toDate() } as SaleRecord & { createdAt: Date };
}

function toDelivery(d: DocumentData): StoredDelivery {
  const { leaseUntil, nextRetryAt, sentAt, createdAt, updatedAt, lastError, response, leaseOwner, externalRequestId, processingStatus, processingNextCheckAt, processingChecks, processingDetail, ...rest } = d;
  return {
    ...rest,
    claims: typeof d.claims === 'number' ? d.claims : 0,
    createdAt: createdAt.toDate(),
    updatedAt: updatedAt.toDate(),
    ...(optDate(leaseUntil) ? { leaseUntil: optDate(leaseUntil) } : {}),
    ...(optDate(nextRetryAt) ? { nextRetryAt: optDate(nextRetryAt) } : {}),
    ...(optDate(sentAt) ? { sentAt: optDate(sentAt) } : {}),
    ...(lastError ? { lastError } : {}),
    ...(response ? { response } : {}),
    ...(leaseOwner ? { leaseOwner } : {}),
    ...(externalRequestId ? { externalRequestId } : {}),
    ...(processingStatus ? { processingStatus } : {}),
    ...(optDate(processingNextCheckAt) ? { processingNextCheckAt: optDate(processingNextCheckAt) } : {}),
    ...(typeof processingChecks === 'number' ? { processingChecks } : {}),
    ...(processingDetail ? { processingDetail } : {}),
  } as StoredDelivery;
}

export class SalesRepo {
  private readonly root;
  private readonly retentionDays: number;

  constructor(private readonly db: Firestore, private readonly opts: SalesOptions) {
    this.root = db.collection('tenants').doc(opts.tenantId);
    this.retentionDays = opts.retentionDays ?? 400;
  }

  private get sales() {
    return this.root.collection('sales');
  }

  /**
   * Save a sale and one delivery row per destination, once. If the sale already exists,
   * nothing is changed and `duplicate: true` is returned.
   */
  async recordSale(
    sale: SaleRecord,
    deliveries: DeliveryDraft[],
    now: Date = new Date(),
  ): Promise<{ saleKey: string; duplicate: boolean }> {
    const key = saleKey(sale.source, sale.eventId);
    const saleRef = this.sales.doc(key);
    const expiresAt = new Date(now.getTime() + this.retentionDays * DAY_MS);

    const duplicate = await this.db.runTransaction(async (tx) => {
      if ((await tx.get(saleRef)).exists) return true;
      tx.set(saleRef, { ...sale, tenantId: this.opts.tenantId, createdAt: now, expiresAt });
      for (const d of deliveries) {
        tx.set(saleRef.collection('deliveries').doc(d.destination), {
          ...d,
          tenantId: this.opts.tenantId,
          saleKey: key,
          attempts: 0,
          claims: 0,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        });
      }
      return false;
    });
    return { saleKey: key, duplicate };
  }

  /**
   * Contact details and website profiles that appear on the same sales as any of these keys or profiles. A customer's
   * phone and email are only known to belong together because a sale (or a website visit) carried both.
   */
  async linkedTo(identityKeys: string[], personIds: string[]): Promise<{ keys: string[]; personIds: string[] }> {
    const keys = new Set<string>();
    const persons = new Set<string>();
    const lookups = [
      ...identityKeys.map((k) => this.sales.where('identityKeys', 'array-contains', k).select('identityKeys', 'personId').get()),
      ...personIds.map((id) => this.sales.where('personId', '==', id).select('identityKeys', 'personId').get()),
    ];
    for (const snap of await Promise.all(lookups)) {
      for (const d of snap.docs) {
        for (const k of (d.get('identityKeys') as string[] | undefined) ?? []) keys.add(k);
        const p = d.get('personId') as string | null | undefined;
        if (p) persons.add(p);
      }
    }
    return { keys: [...keys], personIds: [...persons] };
  }

  /**
   * Erasure of a customer from the sales: removes everything that identifies them (contact hashes, the keys used to
   * match withdrawals, the link to their website profile) and cancels what has not been sent yet. The sale itself
   * (when, how much, which channel) stays as a business record, which also stops a replayed webhook from bringing
   * the customer's details back. Matches by the customer's identity keys and by the website profiles just erased.
   */
  async anonymizeCustomer(identityKeys: string[], personIds: string[], now: Date = new Date()): Promise<{ sales: number; deliveriesCancelled: number }> {
    const found = new Map<string, DocumentReference>();
    const lookups = [
      ...identityKeys.map((k) => this.sales.where('identityKeys', 'array-contains', k).get()),
      ...personIds.map((id) => this.sales.where('personId', '==', id).get()),
    ];
    for (const snap of await Promise.all(lookups)) for (const d of snap.docs) found.set(d.id, d.ref);

    let deliveriesCancelled = 0;
    for (const ref of found.values()) {
      const deliveries = await ref.collection('deliveries').get();
      const batch = this.db.batch();
      batch.update(ref, { hashes: {}, identityKeys: [], personId: null, erasedAt: now });
      for (const d of deliveries.docs) {
        const status = d.data().status as string;
        const unsent = status === 'pending' || status === 'retry' || status === 'sending';
        if (unsent) deliveriesCancelled++;
        batch.update(d.ref, {
          touchId: FieldValue.delete(),
          updatedAt: now,
          ...(unsent ? { status: 'skipped', skipReason: 'customer_erased', leaseUntil: null, leaseOwner: null, nextRetryAt: null } : {}),
        });
      }
      await batch.commit(); // one sale and its few deliveries: far below the batch limit
    }
    return { sales: found.size, deliveriesCancelled };
  }

  async getSale(key: string): Promise<(SaleRecord & { createdAt: Date }) | null> {
    const snap = await this.sales.doc(key).get();
    return snap.exists ? toSale(snap.data()!) : null;
  }

  async getDeliveries(key: string): Promise<StoredDelivery[]> {
    const snap = await this.sales.doc(key).collection('deliveries').get();
    return snap.docs.map((doc) => toDelivery(doc.data()));
  }

  private deliveryRef(key: string, destination: string): DocumentReference {
    return this.sales.doc(key).collection('deliveries').doc(destination);
  }

  /**
   * Deliveries that should be sent now: pending ones (oldest first), retries whose time has come, and ones whose
   * worker lease expired (the worker died mid-send). Each kind is selected by the database, so a pile of
   * deliveries that are not due yet can never hide ones that are.
   * Needs the collection-group indexes in deploy/firestore.indexes.json.
   */
  async listDueDeliveries(now: Date = new Date(), limit = 50): Promise<StoredDelivery[]> {
    const base = () => this.db.collectionGroup('deliveries').where('tenantId', '==', this.opts.tenantId);
    const [pending, retry, stale] = await Promise.all([
      base().where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(limit).get(),
      base().where('status', '==', 'retry').where('nextRetryAt', '<=', now).orderBy('nextRetryAt', 'asc').limit(limit).get(),
      base().where('status', '==', 'sending').where('leaseUntil', '<=', now).orderBy('leaseUntil', 'asc').limit(limit).get(),
    ]);
    return [...stale.docs, ...retry.docs, ...pending.docs].map((d) => toDelivery(d.data())).slice(0, limit);
  }

  /** Sent deliveries whose processing result on the platform is still unknown and due to be looked up. */
  async listDueProcessing(now: Date = new Date(), limit = 50): Promise<StoredDelivery[]> {
    const snap = await this.db
      .collectionGroup('deliveries')
      .where('tenantId', '==', this.opts.tenantId)
      .where('status', '==', 'sent')
      .where('processingStatus', '==', 'processing')
      .where('processingNextCheckAt', '<=', now)
      .orderBy('processingNextCheckAt', 'asc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => toDelivery(d.data()));
  }

  async recordProcessing(
    key: string,
    destination: string,
    result: { status: ProcessingStatus; detail?: string; nextCheckAt?: Date; checks: number },
    now: Date = new Date(),
  ): Promise<void> {
    await this.deliveryRef(key, destination).update({
      processingStatus: result.status,
      processingChecks: result.checks,
      processingNextCheckAt: result.status === 'processing' ? (result.nextCheckAt ?? now) : null,
      processingDetail: result.detail ? result.detail.slice(0, 300) : null,
      updatedAt: now,
    });
  }

  /**
   * Take a delivery for sending. Returns a lease token, or null if another worker got it first.
   * Pass the token back to completeDelivery so a slow worker cannot overwrite the result of the one that took over.
   */
  async claimDelivery(key: string, destination: string, now: Date = new Date(), leaseMs = 2 * 60_000): Promise<string | null> {
    const ref = this.deliveryRef(key, destination);
    const token = randomUUID();
    const won = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const d = toDelivery(snap.data()!);
      const due =
        d.status === 'pending' ||
        (d.status === 'retry' && (!d.nextRetryAt || d.nextRetryAt <= now)) ||
        (d.status === 'sending' && (!d.leaseUntil || d.leaseUntil <= now));
      if (!due) return false;
      tx.update(ref, {
        status: 'sending',
        claims: d.claims + 1,
        leaseOwner: token,
        leaseUntil: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      });
      return true;
    });
    return won ? token : null;
  }

  /** Write the result of a send. Returns false (and writes nothing) if the lease now belongs to another worker. */
  async completeDelivery(key: string, destination: string, outcome: DeliveryOutcome, now: Date = new Date()): Promise<boolean> {
    const ref = this.deliveryRef(key, destination);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const d = toDelivery(snap.data()!);
      if (outcome.leaseToken && d.leaseOwner !== outcome.leaseToken) return false;
      tx.update(ref, {
        status: outcome.status,
        updatedAt: now,
        leaseUntil: null,
        leaseOwner: null,
        // The worker finished properly, so this is not a crash loop. `claims` only counts claims that were never
        // completed; otherwise a delivery waiting for a connection would use them all up.
        claims: 0,
        attempts: d.attempts + (outcome.countAttempt === false ? 0 : 1),
        nextRetryAt: outcome.nextRetryAt ?? null,
        lastError: outcome.error ? outcome.error.slice(0, 300) : null,
        response: outcome.response ?? null,
        ...(outcome.skipReason ? { skipReason: outcome.skipReason } : {}),
        ...(outcome.status === 'sent' ? { sentAt: now } : {}),
        ...(outcome.requestId
          ? {
              externalRequestId: outcome.requestId,
              processingStatus: 'processing',
              processingNextCheckAt: outcome.processingNextCheckAt ?? now,
              processingChecks: 0,
              processingDetail: null,
            }
          : {}),
      });
      return true;
    });
  }

  /** Manual resend from the admin: put a failed (or sent) delivery back in the queue. */
  async resetDelivery(key: string, destination: string, now: Date = new Date()): Promise<boolean> {
    const ref = this.deliveryRef(key, destination);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const status = snap.data()!.status as DeliveryStatus;
      if (status !== 'failed' && status !== 'sent' && status !== 'retry') return false;
      tx.update(ref, {
        status: 'pending', attempts: 0, claims: 0, nextRetryAt: null, lastError: null, leaseUntil: null, leaseOwner: null, updatedAt: now,
        externalRequestId: null, processingStatus: null, processingNextCheckAt: null, processingChecks: null, processingDetail: null,
      });
      return true;
    });
  }

  /** Newest sales first, each with its deliveries. */
  async listSales(limit = 50): Promise<SaleSummary[]> {
    const snap = await this.sales.orderBy('createdAt', 'desc').limit(limit).get();
    return Promise.all(
      snap.docs.map(async (doc) => ({
        saleKey: doc.id,
        sale: toSale(doc.data()),
        deliveries: await this.getDeliveries(doc.id),
      })),
    );
  }

  async stats(since: Date, cap = 5000): Promise<SalesStats> {
    const stats: SalesStats = {
      since,
      sales: 0,
      matchedToPerson: 0,
      byChannel: {},
      deliveries: {},
      skipReasons: {},
      processing: {},
      withClickId: 0,
      contactOnly: 0,
    };
    const snap = await this.sales.where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(cap).get();
    for (const doc of snap.docs) {
      const sale = doc.data();
      stats.sales++;
      if (sale.personId) stats.matchedToPerson++;
      stats.byChannel[sale.channel] = (stats.byChannel[sale.channel] ?? 0) + 1;
      for (const d of await this.getDeliveries(doc.id)) {
        const byStatus = (stats.deliveries[d.destination] ??= {});
        byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
        if (d.processingStatus) {
          const proc = (stats.processing[d.destination] ??= {});
          proc[d.processingStatus] = (proc[d.processingStatus] ?? 0) + 1;
        }
        if (d.status === 'skipped' && d.skipReason) {
          const reasons = (stats.skipReasons[d.destination] ??= {});
          reasons[d.skipReason] = (reasons[d.skipReason] ?? 0) + 1;
        } else if (d.status !== 'skipped') {
          if (d.touchId) stats.withClickId++;
          else stats.contactOnly++;
        }
      }
    }
    return stats;
  }

  /** Raw webhook / sync trace for debugging. Callers must redact phone and email first. Kept 30 days. */
  async logIngest(entry: { source: string; payload: unknown; outcome: unknown }, now: Date = new Date()): Promise<void> {
    await this.root.collection('ingest_log').add({
      source: entry.source,
      payload: JSON.stringify(entry.payload),
      outcome: JSON.stringify(entry.outcome),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 30 * DAY_MS),
    });
  }
}
