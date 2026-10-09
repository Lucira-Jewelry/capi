import { createHash, randomUUID } from 'node:crypto';
import {
  Firestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import {
  hashEmailForGoogle,
  hashEmailForMeta,
  hashPhoneForGoogle,
  hashPhoneForMeta,
  identityKeyForEmail,
  identityKeyForPhone,
  type Touch,
} from '@datahash/core';
import type {
  IdentifyInput,
  IdentifyResult,
  IncomingTouch,
  PersonHashes,
  StoredConsent,
  StoredPerson,
  StoreOptions,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export function createFirestore(projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'datahash-dev'): Firestore {
  // Picks up FIRESTORE_EMULATOR_HOST automatically when it is set.
  // Production requires an explicit database ID so a staging service in a shared GCP project cannot silently write to
  // the project's (default) database. Local development and emulator tests keep the SDK's default behavior.
  const databaseId = process.env.FIRESTORE_DATABASE?.trim();
  return new Firestore({ projectId, ...(databaseId ? { databaseId } : {}), ignoreUndefinedProperties: true });
}

/** Deterministic touch ID: re-sending the same identify call never duplicates touches. */
export function touchId(t: IncomingTouch): string {
  const ms = t.clickedAt instanceof Date ? t.clickedAt.getTime() : t.clickedAt;
  const raw = [t.gclid, t.gbraid, t.wbraid, t.fbclid, t.ctwaClid, ms].map((v) => v ?? '').join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate(): Date }).toDate();
  return new Date(v as string | number);
}

function personFromSnap(snap: DocumentSnapshot): StoredPerson {
  const d = snap.data()!;
  const person: StoredPerson = {
    id: snap.id,
    hashes: (d.hashes ?? {}) as PersonHashes,
    firstSeen: toDate(d.firstSeen),
    lastSeen: toDate(d.lastSeen),
    expiresAt: toDate(d.expiresAt),
  };
  if (d.phoneKey) person.phoneKey = d.phoneKey;
  if (d.emailKey) person.emailKey = d.emailKey;
  if (d.mergedInto) person.mergedInto = d.mergedInto;
  if (d.consent) person.consent = { ...d.consent, updatedAt: toDate(d.consent.updatedAt) } as StoredConsent;
  return person;
}

export class Store {
  private readonly retentionDays: number;
  private readonly root: DocumentReference;

  constructor(private readonly db: Firestore, private readonly opts: StoreOptions) {
    this.retentionDays = opts.retentionDays ?? 90;
    this.root = db.collection('tenants').doc(opts.tenantId);
  }

  private get identities() {
    return this.root.collection('identities');
  }
  private get persons() {
    return this.root.collection('persons');
  }
  private get suppressions() {
    return this.root.collection('suppressions');
  }
  private touchesOf(personId: string) {
    return this.persons.doc(personId).collection('touches');
  }

  /**
   * First point where anything is stored: the visitor has given a phone or email.
   * Links identities, merges two people if the phone and email belonged to different records,
   * and saves the touches the browser sent.
   */
  async identify(input: IdentifyInput): Promise<IdentifyResult> {
    const now = input.now ?? new Date();
    const country = input.defaultCountry ?? 'IN';

    const phoneKey = identityKeyForPhone(input.phone, country);
    const emailKey = identityKeyForEmail(input.email);
    if (!phoneKey && !emailKey) return { status: 'rejected', reason: 'no_valid_identifier' };

    const incomingHashes: PersonHashes = {};
    const mp = hashPhoneForMeta(input.phone, country);
    const gp = hashPhoneForGoogle(input.phone, country);
    const me = hashEmailForMeta(input.email);
    const ge = hashEmailForGoogle(input.email);
    if (mp) incomingHashes.metaPhone = mp;
    if (gp) incomingHashes.googlePhone = gp;
    if (me) incomingHashes.metaEmail = me;
    if (ge) incomingHashes.googleEmail = ge;

    const expiresAt = new Date(now.getTime() + this.retentionDays * DAY_MS);
    const keys = [phoneKey, emailKey].filter((k): k is string => Boolean(k));

    return this.db.runTransaction(async (tx: Transaction) => {
      // ---- reads (all before writes) ----
      const identitySnaps = await tx.getAll(...keys.map((k) => this.identities.doc(k)));
      const existingIds = [...new Set(identitySnaps.filter((s) => s.exists).map((s) => s.data()!.personId as string))];
      const personSnaps = existingIds.length
        ? await tx.getAll(...existingIds.map((id) => this.persons.doc(id)))
        : [];
      const existing = personSnaps.filter((s) => s.exists).map(personFromSnap);
      existing.sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime());

      const primary = existing[0];
      const secondaries = existing.slice(1);
      const secondaryTouches = [];
      for (const s of secondaries) {
        secondaryTouches.push({ person: s, snap: await tx.get(this.touchesOf(s.id)) });
      }

      // ---- writes ----
      const created = !primary;
      const personId = primary?.id ?? randomUUID();
      const mergedHashes: PersonHashes = { ...(primary?.hashes ?? {}) };
      for (const s of secondaries) Object.assign(mergedHashes, s.hashes);
      Object.assign(mergedHashes, incomingHashes);

      const allPhoneKey = phoneKey ?? primary?.phoneKey ?? secondaries.find((s) => s.phoneKey)?.phoneKey;
      const allEmailKey = emailKey ?? primary?.emailKey ?? secondaries.find((s) => s.emailKey)?.emailKey;

      const personData: Record<string, unknown> = {
        hashes: mergedHashes,
        firstSeen: primary?.firstSeen ?? now,
        lastSeen: now,
        expiresAt,
      };
      if (allPhoneKey) personData.phoneKey = allPhoneKey;
      if (allEmailKey) personData.emailKey = allEmailKey;
      if (input.consent) {
        const consent: Record<string, unknown> = { ads: input.consent.ads, updatedAt: now };
        if (input.consent.source) consent.source = input.consent.source;
        if (input.consent.textVersion) consent.textVersion = input.consent.textVersion;
        personData.consent = consent;
      } else if (primary?.consent) {
        personData.consent = primary.consent;
      }
      tx.set(this.persons.doc(personId), personData, { merge: true });

      // Every key this person now owns points at them (including the secondaries' keys).
      const ownedKeys = new Set<string>(keys);
      for (const s of secondaries) {
        if (s.phoneKey) ownedKeys.add(s.phoneKey);
        if (s.emailKey) ownedKeys.add(s.emailKey);
      }
      for (const k of ownedKeys) {
        tx.set(this.identities.doc(k), { personId, expiresAt, updatedAt: now }, { merge: true });
      }

      // An explicit "yes" after an earlier withdrawal lifts the suppression for these contact details.
      if (input.consent?.ads === true) {
        for (const k of ownedKeys) tx.delete(this.suppressions.doc(k));
      }

      // Merge: move touches over, retire the secondary record.
      let touchesWritten = 0;
      for (const { person, snap } of secondaryTouches) {
        for (const doc of snap.docs) {
          tx.set(this.touchesOf(personId).doc(doc.id), doc.data());
          tx.delete(doc.ref);
          touchesWritten++;
        }
        tx.set(this.persons.doc(person.id), { mergedInto: personId, expiresAt }, { merge: true });
      }

      for (const t of input.touches ?? []) {
        const clickedAt = t.clickedAt instanceof Date ? t.clickedAt : new Date(t.clickedAt);
        const data: Record<string, unknown> = {
          clickedAt,
          expiresAt: new Date(clickedAt.getTime() + this.retentionDays * DAY_MS),
        };
        for (const key of ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'ctwaClid', 'utm', 'landingUrl'] as const) {
          if (t[key] !== undefined) data[key] = t[key];
        }
        tx.set(this.touchesOf(personId).doc(touchId(t)), data);
        touchesWritten++;
      }

      return { status: 'ok' as const, personId, created, merged: secondaries.length > 0, touchesWritten };
    });
  }

  /** Find a person by phone and/or email, following merges. */
  async findPerson(contact: { phone?: string | null; email?: string | null; defaultCountry?: 'IN' | 'US' | 'GB' | 'AE' | 'SG' }): Promise<StoredPerson | null> {
    const keys = [
      identityKeyForPhone(contact.phone, contact.defaultCountry ?? 'IN'),
      identityKeyForEmail(contact.email),
    ].filter((k): k is string => Boolean(k));

    for (const key of keys) {
      const idSnap = await this.identities.doc(key).get();
      if (!idSnap.exists) continue;
      let personId = idSnap.data()!.personId as string;
      for (let hops = 0; hops < 5; hops++) {
        const snap = await this.persons.doc(personId).get();
        if (!snap.exists) break;
        const person = personFromSnap(snap);
        if (!person.mergedInto) return person;
        personId = person.mergedInto;
      }
    }
    return null;
  }

  /** Newest touches first, in the shape the core eligibility rules expect. */
  async getTouches(personId: string, limit = 50): Promise<Touch[]> {
    const snap = await this.touchesOf(personId).orderBy('clickedAt', 'desc').limit(limit).get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      const touch: Touch = { id: doc.id, clickedAt: toDate(d.clickedAt) };
      if (d.expiresAt) touch.expiresAt = toDate(d.expiresAt);
      for (const key of ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'ctwaClid'] as const) {
        if (d[key]) touch[key] = d[key];
      }
      if (d.utm) touch.utm = d.utm;
      return touch;
    });
  }

  async getTouch(personId: string, touchId: string): Promise<Touch | null> {
    const snap = await this.touchesOf(personId).doc(touchId).get();
    if (!snap.exists) return null;
    const d = snap.data()!;
    const touch: Touch = { id: snap.id, clickedAt: toDate(d.clickedAt) };
    if (d.expiresAt) touch.expiresAt = toDate(d.expiresAt);
    for (const key of ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'ctwaClid'] as const) {
      if (d[key]) touch[key] = d[key];
    }
    if (d.utm) touch.utm = d.utm;
    return touch;
  }

  /** Everything needed to decide and build a send for a sale. */
  async lookupForSale(contact: { phone?: string | null; email?: string | null; defaultCountry?: 'IN' | 'US' | 'GB' | 'AE' | 'SG' }) {
    const person = await this.findPerson(contact);
    if (!person) return null;
    return { person, touches: await this.getTouches(person.id) };
  }

  /**
   * The customer withdrew consent. Records a suppression for every identity key we know for them (the contact
   * details given plus the stored person's own), and marks the stored person as declined. Sales that are already
   * queued check suppressions right before sending, so nothing more goes out for this customer.
   * Works for customers who never identified on the website too (CRM-only), because suppressions are keyed by
   * hashed contact details, not by a person record.
   */
  async withdraw(
    contact: { phone?: string | null; email?: string | null; defaultCountry?: 'IN' | 'US' | 'GB' | 'AE' | 'SG' },
    now: Date = new Date(),
    source = 'withdrawal',
  ): Promise<{ keys: number; personFound: boolean }> {
    const keys = new Set(
      [identityKeyForPhone(contact.phone, contact.defaultCountry ?? 'IN'), identityKeyForEmail(contact.email)].filter((k): k is string => Boolean(k)),
    );
    if (keys.size === 0) return { keys: 0, personFound: false };

    const person = await this.findPerson(contact);
    if (person?.phoneKey) keys.add(person.phoneKey);
    if (person?.emailKey) keys.add(person.emailKey);

    const batch = this.db.batch();
    for (const k of keys) batch.set(this.suppressions.doc(k), { createdAt: now, source });
    if (person) batch.set(this.persons.doc(person.id), { consent: { ads: false, updatedAt: now, source } }, { merge: true });
    await batch.commit();
    return { keys: keys.size, personFound: Boolean(person) };
  }

  /** True if any of these identity keys has withdrawn consent. */
  async isSuppressed(identityKeys: string[]): Promise<boolean> {
    if (identityKeys.length === 0) return false;
    const snaps = await this.db.getAll(...identityKeys.map((k) => this.suppressions.doc(k)));
    return snaps.some((s) => s.exists);
  }

  /**
   * Removes a person, their clicks and every identity pointing at them, and the empty records left behind when other
   * profiles were merged into this one. Does not record a withdrawal: see `erase`.
   */
  async deletePerson(personId: string): Promise<{ touches: number; identities: number }> {
    const [touches, identities, merged] = await Promise.all([
      this.touchesOf(personId).get(),
      this.identities.where('personId', '==', personId).get(),
      this.persons.where('mergedInto', '==', personId).get(),
    ]);
    const refs = [...touches.docs, ...identities.docs, ...merged.docs].map((d) => d.ref);
    refs.push(this.persons.doc(personId));
    for (let i = 0; i < refs.length; i += 400) {
      const batch = this.db.batch();
      for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
      await batch.commit();
    }
    return { touches: touches.size, identities: identities.size };
  }

  /** The identity keys (hashed phone and email) a contact stands for. Empty if neither can be read. */
  keysFor(contact: { phone?: string | null; email?: string | null; defaultCountry?: 'IN' | 'US' | 'GB' | 'AE' | 'SG' }): string[] {
    return [identityKeyForPhone(contact.phone, contact.defaultCountry ?? 'IN'), identityKeyForEmail(contact.email)].filter((k): k is string => Boolean(k));
  }

  /**
   * The website profiles any of these keys point at, and every other key those profiles own (a profile can hold a
   * phone and an email, so knowing one finds the other).
   */
  async profilesForKeys(keys: string[]): Promise<{ personIds: string[]; keys: string[] }> {
    if (keys.length === 0) return { personIds: [], keys: [] };
    const snaps = await this.db.getAll(...keys.map((k) => this.identities.doc(k)));
    const personIds = [...new Set(snaps.filter((s) => s.exists).map((s) => s.data()!.personId as string))];
    const owned = new Set<string>();
    if (personIds.length) {
      for (const snap of await this.db.getAll(...personIds.map((id) => this.persons.doc(id)))) {
        if (snap.exists && snap.data()!.phoneKey) owned.add(snap.data()!.phoneKey as string);
        if (snap.exists && snap.data()!.emailKey) owned.add(snap.data()!.emailKey as string);
      }
      for (const id of personIds) for (const d of (await this.identities.where('personId', '==', id).get()).docs) owned.add(d.id);
    }
    return { personIds, keys: [...owned] };
  }

  /** Records that nothing may be sent for these contact details. Written before anything is cleared. */
  async suppress(keys: string[], now: Date = new Date(), source = 'withdrawal'): Promise<void> {
    for (let i = 0; i < keys.length; i += 400) {
      const batch = this.db.batch();
      for (const k of keys.slice(i, i + 400)) batch.set(this.suppressions.doc(k), { createdAt: now, source });
      await batch.commit();
    }
  }

  /** Marks website profiles as having declined advertising use. */
  async markDeclined(personIds: string[], now: Date = new Date(), source = 'withdrawal'): Promise<void> {
    for (let i = 0; i < personIds.length; i += 400) {
      const batch = this.db.batch();
      for (const id of personIds.slice(i, i + 400)) batch.set(this.persons.doc(id), { consent: { ads: false, updatedAt: now, source } }, { merge: true });
      await batch.commit();
    }
  }
}
