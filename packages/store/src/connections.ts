import type { DocumentData, Firestore } from '@google-cloud/firestore';
import type { SecretBox } from './secrets';

export type ConnectionKind = 'meta' | 'google_ads';

export interface MetaSettings {
  /** Meta dataset (pixel) ID that receives the events. */
  datasetId: string;
  /** Events Manager "Test Events" code. While set, events show up there and do not count. */
  testEventCode?: string;
}

export interface GoogleAdsSettings {
  /** The Google Ads customer (account) ID, digits only. */
  customerId: string;
  /** Manager (MCC) account ID if access is through one. */
  loginCustomerId?: string;
  /** ID of the conversion action offline conversions are credited to. */
  conversionActionId: string;
  /**
   * How we log in to this brand's account. 'service_account' (recommended): the product's own service account, which
   * the brand has added as a user or linked through the manager account; nothing secret is stored per brand.
   * 'oauth' (default): a refresh token granted by one of the brand's Google users.
   */
  authMethod?: 'oauth' | 'service_account';
}

export type ConnectionSettings = { meta: MetaSettings; google_ads: GoogleAdsSettings };

export interface ConnectionStatus {
  status: 'active' | 'error';
  lastError?: string;
  updatedAt: Date;
}

/** What the admin sees: settings and status, never the secret. */
export type PublicConnection<K extends ConnectionKind = ConnectionKind> = { kind: K; secretSet: boolean } & ConnectionSettings[K] &
  ConnectionStatus;

const digits = (s: string) => s.replace(/\D/g, '');

export function normalizeSettings<K extends ConnectionKind>(kind: K, settings: ConnectionSettings[K]): ConnectionSettings[K] {
  if (kind === 'meta') {
    const s = settings as MetaSettings;
    const datasetId = digits(s.datasetId);
    if (!datasetId) throw new Error('invalid_dataset_id');
    return { datasetId, ...(s.testEventCode?.trim() ? { testEventCode: s.testEventCode.trim() } : {}) } as ConnectionSettings[K];
  }
  const s = settings as GoogleAdsSettings;
  const customerId = digits(s.customerId);
  const conversionActionId = digits(s.conversionActionId);
  if (customerId.length < 8) throw new Error('invalid_customer_id');
  if (!conversionActionId) throw new Error('invalid_conversion_action_id');
  if (s.authMethod !== undefined && s.authMethod !== 'oauth' && s.authMethod !== 'service_account') throw new Error('invalid_auth_method');
  const loginCustomerId = s.loginCustomerId ? digits(s.loginCustomerId) : '';
  return {
    customerId,
    conversionActionId,
    ...(loginCustomerId ? { loginCustomerId } : {}),
    // Stored only when it is not the default, so existing OAuth connections look exactly as before.
    ...(s.authMethod === 'service_account' ? { authMethod: 'service_account' as const } : {}),
  } as ConnectionSettings[K];
}

/** A brand's ad-platform connections. Tokens are encrypted; reads for the UI never include them. */
export class ConnectionsRepo {
  private readonly col;

  constructor(db: Firestore, private readonly box: SecretBox, tenantId: string) {
    this.col = db.collection('tenants').doc(tenantId).collection('connections');
  }

  /**
   * Save a connection. A token is required, except for a Google connection that uses the product's service account:
   * that one stores no secret at all (and drops one saved earlier).
   */
  async set<K extends ConnectionKind>(kind: K, settings: ConnectionSettings[K], secret?: string, now = new Date()): Promise<void> {
    const clean = normalizeSettings(kind, settings);
    const needsSecret = !(kind === 'google_ads' && (clean as GoogleAdsSettings).authMethod === 'service_account');
    if (needsSecret && !secret?.trim()) throw new Error('secret_required');
    await this.col.doc(kind).set({
      kind,
      ...clean,
      secret: needsSecret ? this.box.seal(secret!.trim()) : null,
      status: 'active',
      updatedAt: now,
    });
  }

  /** Server-side use only (senders): settings plus the decrypted secret. */
  async getWithSecret<K extends ConnectionKind>(kind: K): Promise<{ settings: ConnectionSettings[K]; secret: string } | null> {
    const snap = await this.col.doc(kind).get();
    if (!snap.exists) return null;
    const { kind: _k, secret, status: _s, lastError: _e, updatedAt: _u, ...settings } = snap.data()!;
    // No secret is stored for a service-account connection: callers get an empty string and must check authMethod.
    return { settings: settings as ConnectionSettings[K], secret: secret ? this.box.open(secret as string) : '' };
  }

  async get<K extends ConnectionKind>(kind: K): Promise<PublicConnection<K> | null> {
    const snap = await this.col.doc(kind).get();
    return snap.exists ? (this.toPublic(snap.data()!) as unknown as PublicConnection<K>) : null;
  }

  async list(): Promise<PublicConnection[]> {
    const snap = await this.col.get();
    return snap.docs.map((d) => this.toPublic(d.data()));
  }

  async remove(kind: ConnectionKind): Promise<void> {
    await this.col.doc(kind).delete();
  }

  async markStatus(kind: ConnectionKind, status: 'active' | 'error', lastError?: string, now = new Date()): Promise<void> {
    const ref = this.col.doc(kind);
    if (!(await ref.get()).exists) return;
    await ref.update({ status, updatedAt: now, ...(lastError ? { lastError: lastError.slice(0, 300) } : { lastError: null }) });
  }

  private toPublic(d: DocumentData): PublicConnection {
    const { secret, updatedAt, lastError, ...rest } = d;
    return {
      ...rest,
      secretSet: Boolean(secret),
      ...(lastError ? { lastError } : {}),
      updatedAt: updatedAt.toDate(),
    } as PublicConnection;
  }
}
