import type { SalesRepo, Store } from '@datahash/store';

type Contact = { phone?: string | null; email?: string | null; defaultCountry?: 'IN' | 'US' | 'GB' | 'AE' | 'SG' };
type StoreLike = Pick<Store, 'keysFor' | 'profilesForKeys' | 'suppress' | 'markDeclined' | 'deletePerson'>;
type SalesLike = Pick<SalesRepo, 'linkedTo' | 'anonymizeCustomer'>;

/** Most contact details one request may touch. More means a shared number or email, not one customer. */
export const MAX_LINKED_CONTACTS = 50;
const MAX_ROUNDS = 6;

export class TooManyLinkedContacts extends Error {
  constructor() {
    super('too_many_linked_contacts');
  }
}

/**
 * Everything we know to belong to the same customer as this contact: their phone and email as given, the other contact
 * details on their website profile, and the other contact details on any sale that carried one of them, repeated until
 * nothing new turns up. (A customer who only ever bought in store has no website profile: it is the sale that says their
 * phone and their email go together.) Only reads. Gives up, changing nothing, if the group grows past
 * MAX_LINKED_CONTACTS: that is a number or an email shared by many people, and treating them all as one person would
 * stop sending for strangers.
 */
export async function linkedIdentity(deps: { store: StoreLike; sales: SalesLike }, contact: Contact): Promise<{ keys: string[]; personIds: string[] }> {
  const keys = new Set(deps.store.keysFor(contact));
  const persons = new Set<string>();
  if (keys.size === 0) return { keys: [], personIds: [] };
  const askedKeys = new Set<string>();
  const askedPersons = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const profiles = await deps.store.profilesForKeys([...keys]);
    profiles.keys.forEach((k) => keys.add(k));
    profiles.personIds.forEach((p) => persons.add(p));

    const newKeys = [...keys].filter((k) => !askedKeys.has(k));
    const newPersons = [...persons].filter((p) => !askedPersons.has(p));
    if (newKeys.length === 0 && newPersons.length === 0) break;
    newKeys.forEach((k) => askedKeys.add(k));
    newPersons.forEach((p) => askedPersons.add(p));

    const onSales = await deps.sales.linkedTo(newKeys, newPersons);
    onSales.keys.forEach((k) => keys.add(k));
    onSales.personIds.forEach((p) => persons.add(p));
    if (keys.size > MAX_LINKED_CONTACTS) throw new TooManyLinkedContacts();
  }
  if (keys.size > MAX_LINKED_CONTACTS) throw new TooManyLinkedContacts();
  return { keys: [...keys], personIds: [...persons] };
}

export interface EraseResult {
  /** The phone or email could be read, so there was a customer to act on. */
  found: boolean;
  /** How many contact details (phones and emails) were treated as this customer's. */
  contactDetails: number;
  /** Website profile records removed (profile, clicks, identities). */
  persons: number;
  touches: number;
  identities: number;
  /** Sales made anonymous, and queued sends that were cancelled. */
  sales: number;
  deliveriesCancelled: number;
}

/**
 * Erase one customer. First records that nothing may be sent for ANY of their contact details (so a later sale under
 * only the email, or only the phone, is held back too), and only then deletes their website profile and clicks and
 * strips their contact hashes from the sales, cancelling anything not yet sent.
 *
 * It cannot reach data already sent to Meta or Google: that has to be deleted in those platforms.
 */
export async function eraseCustomer(deps: { store: StoreLike; sales: SalesLike }, contact: Contact, now: Date = new Date()): Promise<EraseResult> {
  const linked = await linkedIdentity(deps, contact);
  if (linked.keys.length === 0) return { found: false, contactDetails: 0, persons: 0, touches: 0, identities: 0, sales: 0, deliveriesCancelled: 0 };

  await deps.store.suppress(linked.keys, now, 'erasure'); // before anything is cleared

  let touches = 0;
  let identities = 0;
  for (const id of linked.personIds) {
    const r = await deps.store.deletePerson(id);
    touches += r.touches;
    identities += r.identities;
  }
  const sales = await deps.sales.anonymizeCustomer(linked.keys, linked.personIds, now);
  return { found: true, contactDetails: linked.keys.length, persons: linked.personIds.length, touches, identities, ...sales };
}

/**
 * The operator records that a customer asked to stop being used for advertising. Same reach as erasure (every contact
 * detail known to belong to them is suppressed) but nothing is deleted.
 */
export async function withdrawCustomer(deps: { store: StoreLike; sales: SalesLike }, contact: Contact, now: Date = new Date()): Promise<{ keys: number; personFound: boolean }> {
  const linked = await linkedIdentity(deps, contact);
  if (linked.keys.length === 0) return { keys: 0, personFound: false };
  await deps.store.suppress(linked.keys, now, 'withdrawal');
  await deps.store.markDeclined(linked.personIds, now, 'withdrawal');
  return { keys: linked.keys.length, personFound: linked.personIds.length > 0 };
}
