import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DocumentData, Firestore } from '@google-cloud/firestore';
import { parseTrackingHost, type Channel, type CountryCode, type Destination, type SiteKeyRecord, type TenantConfig, type ZohoMapping } from '@datahash/core';

export interface CreateTenantInput {
  name: string;
  /** Optional fixed ID; otherwise made from the name plus a random suffix. */
  tenantId?: string;
  /** Page origins allowed for the first site key. */
  origins?: string[];
  /** The brand's own tracking address for the first site key, e.g. track.brand.com. */
  trackingHost?: string;
  consentMode?: 'opt_in' | 'opt_out';
  allowedChannels?: Channel[];
  destinations?: Destination[];
  defaultCountry?: CountryCode;
  retentionDays?: number;
  zoho?: ZohoMapping;
}

export interface CreatedTenant {
  tenant: TenantConfig;
  siteKey: string;
  /** Shown once. Only its hash is stored. */
  webhookSecret: string;
}

export interface TenantRegistryOptions {
  /** How long lookups are cached in memory. Default 60 s. */
  cacheMs?: number;
  now?: () => number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'tenant';

/** A site key as stored, with removed optional fields (stored as null) left out. */
function toSite(key: string, d: DocumentData): SiteKeyRecord {
  return {
    key,
    tenantId: d.tenantId,
    origins: d.origins ?? [],
    ...(d.label ? { label: d.label } : {}),
    ...(d.trackingHost ? { trackingHost: d.trackingHost } : {}),
  };
}

function toTenant(id: string, d: DocumentData): TenantConfig {
  return {
    tenantId: id,
    name: d.name,
    status: d.status,
    consentPolicy: d.consentPolicy,
    allowedChannels: d.allowedChannels,
    destinations: d.destinations,
    defaultCountry: d.defaultCountry,
    retentionDays: d.retentionDays,
    sources: d.sources ?? {},
    // A Firestore Timestamp when read back, a plain Date when built in memory at creation.
    createdAt: d.createdAt instanceof Date ? d.createdAt : d.createdAt.toDate(),
  };
}

/**
 * Brands (tenants) and their settings, kept in Firestore. Servers read them through this registry
 * with a short in-memory cache, so onboarding a brand needs no deploy or restart.
 */
export class TenantRegistry {
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly tenantCache = new Map<string, { at: number; value: TenantConfig | null }>();
  private readonly siteCache = new Map<string, { at: number; value: SiteKeyRecord | null }>();

  constructor(private readonly db: Firestore, opts: TenantRegistryOptions = {}) {
    this.cacheMs = opts.cacheMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private get tenants() {
    return this.db.collection('tenants');
  }
  private get siteKeys() {
    return this.db.collection('site_keys');
  }
  private secretsDoc(tenantId: string) {
    return this.tenants.doc(tenantId).collection('private').doc('webhook');
  }

  async createTenant(input: CreateTenantInput): Promise<CreatedTenant> {
    const tenantId = input.tenantId ?? `${slug(input.name)}-${randomBytes(3).toString('hex')}`;
    const ref = this.tenants.doc(tenantId);
    if ((await ref.get()).exists) throw new Error('tenant_exists');

    const createdAt = new Date(this.now());
    const config = {
      name: input.name,
      status: 'active' as const,
      consentPolicy: { mode: input.consentMode ?? 'opt_in' },
      // Offline channels only by default: online sales are usually reported by the store platform's own apps.
      allowedChannels: input.allowedChannels ?? (['store', 'whatsapp'] as Channel[]),
      destinations: input.destinations ?? (['meta', 'google_ads'] as Destination[]),
      defaultCountry: input.defaultCountry ?? 'IN',
      retentionDays: input.retentionDays ?? 90,
      sources: input.zoho ? { zoho: input.zoho } : {},
      createdAt,
    };
    const webhookSecret = randomBytes(24).toString('base64url');
    await ref.create(config);
    await this.secretsDoc(tenantId).set({ webhookSecretHash: sha256(webhookSecret), rotatedAt: createdAt });
    const siteKey = await this.addSiteKey(tenantId, input.origins ?? [], undefined, input.trackingHost);
    this.tenantCache.delete(tenantId);
    return { tenant: toTenant(tenantId, config as never), siteKey, webhookSecret };
  }

  /** `fresh` skips the short-lived cache: for decisions that must not lag, such as "may this brand send right now?". */
  async getTenant(tenantId: string, opts: { fresh?: boolean } = {}): Promise<TenantConfig | null> {
    const hit = this.tenantCache.get(tenantId);
    if (!opts.fresh && hit && this.now() - hit.at < this.cacheMs) return hit.value;
    const snap = await this.tenants.doc(tenantId).get();
    const value = snap.exists && snap.data()?.name ? toTenant(tenantId, snap.data()!) : null;
    this.tenantCache.set(tenantId, { at: this.now(), value });
    return value;
  }

  /** All brands (for the admin list and the dispatcher). Fine for hundreds of brands; add paging beyond that. */
  async listTenants(): Promise<TenantConfig[]> {
    const snap = await this.tenants.get();
    return snap.docs.filter((d) => d.data().name).map((d) => toTenant(d.id, d.data()));
  }

  async addSiteKey(tenantId: string, origins: string[], label?: string, trackingHost?: string): Promise<string> {
    const host = await this.checkedTrackingHost(trackingHost);
    const key = `pk_${randomBytes(12).toString('hex')}`;
    await this.siteKeys.doc(key).set({ tenantId, origins, ...(label ? { label } : {}), ...(host ? { trackingHost: host } : {}) });
    return key;
  }

  /** Change a site key's allowed sites, label or tracking address. `trackingHost: null` removes the address. */
  async updateSiteKey(
    tenantId: string,
    key: string,
    patch: { origins?: string[]; label?: string; trackingHost?: string | null },
  ): Promise<void> {
    const ref = this.siteKeys.doc(key);
    const snap = await ref.get();
    if (!snap.exists || snap.data()!.tenantId !== tenantId) throw new Error('unknown_site_key');
    const update: Record<string, unknown> = {};
    if (patch.origins) update.origins = patch.origins;
    if (patch.label !== undefined) update.label = patch.label;
    if (patch.trackingHost === null) update.trackingHost = null;
    else if (patch.trackingHost !== undefined) update.trackingHost = await this.checkedTrackingHost(patch.trackingHost, key);
    await ref.update(update);
    this.siteCache.delete(key);
  }

  /** Validates the address and makes sure no other site key already uses it. */
  private async checkedTrackingHost(raw: string | undefined, exceptKey?: string): Promise<string | undefined> {
    if (!raw) return undefined;
    const parsed = parseTrackingHost(raw);
    if (!parsed.ok) throw new Error('invalid_tracking_host');
    const taken = await this.siteKeys.where('trackingHost', '==', parsed.host).limit(2).get();
    if (taken.docs.some((d) => d.id !== exceptKey)) throw new Error('tracking_host_taken');
    return parsed.host;
  }

  async listSiteKeys(tenantId: string): Promise<SiteKeyRecord[]> {
    const snap = await this.siteKeys.where('tenantId', '==', tenantId).get();
    return snap.docs.map((d) => toSite(d.id, d.data()));
  }

  /** Resolve a website script key to its tenant, or null if unknown or the tenant is suspended. */
  async findSite(key: string): Promise<{ site: SiteKeyRecord; tenant: TenantConfig } | null> {
    if (!/^pk_[a-f0-9]{24}$/.test(key)) return null;
    let site: SiteKeyRecord | null;
    const hit = this.siteCache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) {
      site = hit.value;
    } else {
      const snap = await this.siteKeys.doc(key).get();
      site = snap.exists ? toSite(key, snap.data()!) : null;
      this.siteCache.set(key, { at: this.now(), value: site });
    }
    if (!site) return null;
    const tenant = await this.getTenant(site.tenantId);
    if (!tenant || tenant.status !== 'active') return null;
    return { site, tenant };
  }

  async verifyWebhookSecret(tenantId: string, secret: string | undefined): Promise<boolean> {
    if (!secret) return false;
    const snap = await this.secretsDoc(tenantId).get();
    if (!snap.exists) return false;
    const stored = Buffer.from(snap.data()!.webhookSecretHash as string, 'hex');
    const given = Buffer.from(sha256(secret), 'hex');
    return stored.length === given.length && timingSafeEqual(stored, given);
  }

  async rotateWebhookSecret(tenantId: string): Promise<string> {
    if (!(await this.getTenant(tenantId))) throw new Error('unknown_tenant');
    const secret = randomBytes(24).toString('base64url');
    await this.secretsDoc(tenantId).set({ webhookSecretHash: sha256(secret), rotatedAt: new Date(this.now()) });
    return secret;
  }

  async setSourceMapping(tenantId: string, source: 'zoho', mapping: ZohoMapping): Promise<void> {
    if (!(await this.getTenant(tenantId))) throw new Error('unknown_tenant');
    await this.tenants.doc(tenantId).update({ [`sources.${source}`]: mapping });
    this.tenantCache.delete(tenantId);
  }

  async update(
    tenantId: string,
    patch: Partial<Pick<TenantConfig, 'name' | 'status' | 'consentPolicy' | 'allowedChannels' | 'destinations' | 'defaultCountry' | 'retentionDays'>>,
  ): Promise<void> {
    if (!(await this.getTenant(tenantId))) throw new Error('unknown_tenant');
    await this.tenants.doc(tenantId).update(patch);
    this.tenantCache.delete(tenantId);
  }
}
