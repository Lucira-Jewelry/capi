import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCsv } from './import-helper';
import { eraseCustomer, processSale } from '@datahash/ingest';
import { ConnectionsRepo, createFirestore, SalesRepo, SecretBox, SendControl, Store, TenantRegistry } from '@datahash/store';
import { handleAdmin, type AdminDeps } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);

afterAll(async () => {
  if (emulator) await db.terminate();
});

describe.skipIf(!emulator)('admin hardening (Firestore emulator)', () => {
  const registry = emulator ? new TenantRegistry(db, { cacheMs: 0 }) : (null as never);
  const box = new SecretBox(SecretBox.generateKey());
  let deps: AdminDeps;
  const dispatched: string[] = [];
  const control = emulator ? new SendControl(db, { cacheMs: 0 }) : (null as never);

  beforeAll(() => {
    deps = {
      adminToken: 'tok',
      registry,
      connectionsFor: (id) => new ConnectionsRepo(db, box, id),
      salesFor: (id) => new SalesRepo(db, { tenantId: id }),
      processFor: (tenant, sale) => processSale(sale, tenant, { store: new Store(db, { tenantId: tenant.tenantId }), sales: new SalesRepo(db, { tenantId: tenant.tenantId }) }),
      dispatchFor: async (id) => {
        dispatched.push(id);
        return { considered: 0, sent: 0, retried: 0, failed: 0, notConnected: 0, lostClaim: 0, withdrawn: 0, lostLease: 0, suspended: false, blocked: 0, diagnostics: { checked: 0, success: 0, partial: 0, rejected: 0, stillProcessing: 0 } };
      },
      googleInfo: { serviceAccountEmail: 'sender@my-project.iam.gserviceaccount.com', oauthConfigured: false },
      checkGoogleFor: async () => ({ ok: true, message: 'ok' }),
      withdrawFor: (tenant, contact) => new Store(db, { tenantId: tenant.tenantId }).withdraw({ ...contact, defaultCountry: tenant.defaultCountry }),
      publicUrl: 'https://track.example.com',
      eraseFor: (tenant, contact) =>
        eraseCustomer({ store: new Store(db, { tenantId: tenant.tenantId }), sales: new SalesRepo(db, { tenantId: tenant.tenantId }) }, { ...contact, defaultCountry: tenant.defaultCountry }),
      sendControl: {
        overview: async () => { const p = await control.get(); return { enabled: true, paused: p.paused, ...(p.reason ? { reason: p.reason } : {}) }; },
        setPaused: async (paused, reason) => { const p = await control.set(paused, reason); return { enabled: true, paused: p.paused, ...(p.reason ? { reason: p.reason } : {}) }; },
      },
      sendingFor: async () => {
        const p = await control.get();
        return p.paused ? { allowed: false, reason: `Sending is paused by an operator${p.reason ? ` (${p.reason})` : ''}.` } : { allowed: true };
      },
    };
  });

  const call = (method: string, path: string, body?: unknown) =>
    handleAdmin({ method, path, query: new URLSearchParams(), body, token: 'tok' }, deps);

  it('an operator can pause all sending and resume it, and the brand page shows it at once', async () => {
    const created = (await call('POST', '/tenants', { name: 'Pause Co' })).body as { tenant: { tenantId: string } };
    const id = created.tenant.tenantId;
    expect((await call('GET', '/sending')).body).toMatchObject({ paused: false });

    const paused = await call('PUT', '/sending', { paused: true, reason: 'checking a mapping' });
    expect(paused.body).toMatchObject({ paused: true, reason: 'checking a mapping' });
    expect((await call('GET', `/tenants/${id}`)).body).toMatchObject({ sending: { allowed: false, reason: expect.stringContaining('checking a mapping') } });

    expect((await call('PUT', '/sending', { paused: false })).body).toMatchObject({ paused: false });
    expect((await call('GET', `/tenants/${id}`)).body).toMatchObject({ sending: { allowed: true } });
    expect(await call('PUT', '/sending', { paused: 'yes' })).toMatchObject({ status: 400, body: { error: 'paused_required' } });
    expect((await handleAdmin({ method: 'GET', path: '/sending', query: new URLSearchParams(), body: undefined, token: 'wrong' }, deps)).status).toBe(401);
  });

  it('a phone or email shared by many people is refused with an explanation, for erasure and for privacy requests', async () => {
    const created = (await call('POST', '/tenants', { name: 'Shared Co' })).body as { tenant: { tenantId: string } };
    const id = created.tenant.tenantId;
    const shared = { ...deps, eraseFor: async () => { throw new Error('too_many_linked_contacts'); }, withdrawFor: async () => { throw new Error('too_many_linked_contacts'); } };
    for (const path of ['customers/erase', 'consent/withdraw']) {
      const r = await handleAdmin({ method: 'POST', path: `/tenants/${id}/${path}`, query: new URLSearchParams(), body: { phone: '9876543210' }, token: 'tok' }, shared);
      expect(r).toMatchObject({ status: 409, body: { error: 'too_many_linked_contacts', message: expect.stringContaining('Nothing was changed') } });
    }
  });

  it('erasing a customer works through the console API, even for a suspended brand, and asks for a contact', async () => {
    const created = (await call('POST', '/tenants', { name: 'Erase Co' })).body as { tenant: { tenantId: string } };
    const id = created.tenant.tenantId;
    await importCsv(call, id, 'eventId,channel,occurredAt,phone\nA1,store,2026-10-07,9876543210');
    expect(((await call('GET', `/tenants/${id}/sales`)).body as { sales: unknown[] }).sales).toHaveLength(1);

    expect(await call('POST', `/tenants/${id}/customers/erase`, {})).toMatchObject({ status: 400, body: { error: 'contact_required' } });
    expect(await call('POST', `/tenants/${id}/customers/erase`, { phone: 'abc' })).toMatchObject({ status: 400, body: { error: 'invalid_contact' } });

    await call('PATCH', `/tenants/${id}`, { status: 'suspended' });
    const r = await call('POST', `/tenants/${id}/customers/erase`, { phone: '9876543210' });
    expect(r).toMatchObject({ status: 200, body: { found: true, sales: 1 } });
    const sale = ((await call('GET', `/tenants/${id}/sales`)).body as { sales: Array<{ deliveries: Array<{ status: string; skipReason?: string }> }> }).sales[0]!;
    expect(sale.deliveries.every((d) => d.status === 'skipped')).toBe(true);
  });

  it('the brand page tells the console whether this server may send for it', async () => {
    const created = (await call('POST', '/tenants', { name: 'Switch Co' })).body as { tenant: { tenantId: string } };
    const id = created.tenant.tenantId;
    expect((await call('GET', `/tenants/${id}`)).body).toMatchObject({ sending: { allowed: true } }); // no policy given: allowed

    const sendingFor = (tenantId: string) => (tenantId === id ? { allowed: false, reason: 'Sending is switched off on this server (OUTBOUND_SENDS is not "on"). Nothing was sent.' } : { allowed: true });
    const gated = { ...deps, sendingFor };
    const view = await handleAdmin({ method: 'GET', path: `/tenants/${id}`, query: new URLSearchParams(), body: undefined, token: 'tok' }, gated);
    expect(view.body).toMatchObject({ sending: { allowed: false, reason: expect.stringContaining('switched off') } });
  });

  it('a suspended brand cannot be dispatched or imported into, and the console says why', async () => {
    const created = (await call('POST', '/tenants', { name: 'Gate Co' })).body as { tenant: { tenantId: string } };
    const id = created.tenant.tenantId;
    const csv = 'eventId,channel,occurredAt\nA1,store,2026-10-07';

    expect((await call('POST', `/tenants/${id}/dispatch`)).status).toBe(200);
    await call('PATCH', `/tenants/${id}`, { status: 'suspended' });
    expect(await call('POST', `/tenants/${id}/dispatch`)).toMatchObject({ status: 409, body: { error: 'brand_suspended' } });
    expect(await call('POST', `/tenants/${id}/import`, { csv })).toMatchObject({ status: 409, body: { error: 'brand_suspended' } });
    expect(dispatched).toEqual([id]); // only the call made while the brand was active

    await call('PATCH', `/tenants/${id}`, { status: 'active' });
    expect((await call('POST', `/tenants/${id}/import`, { csv, dryRun: true })).status).toBe(200);
  });

  it('Google can be connected through the service account with no token, or through OAuth with one', async () => {
    const created = (await call('POST', '/tenants', { name: 'Sa Co' })).body as { tenant: { tenantId: string } };
    const id = created.tenant.tenantId;
    const path = `/tenants/${id}/connections/google_ads`;
    const repo = new ConnectionsRepo(db, box, id);

    // service account: no token needed
    const sa = await call('PUT', path, { authMethod: 'service_account', customerId: '123-456-7890', loginCustomerId: '987-654-3210', conversionActionId: '77' });
    expect(sa).toMatchObject({ status: 200, body: { kind: 'google_ads', authMethod: 'service_account', secretSet: false, customerId: '1234567890', loginCustomerId: '9876543210' } });

    // OAuth: a token is required, since the service-account connection has none to keep
    expect(await call('PUT', path, { customerId: '1234567890', conversionActionId: '77' })).toMatchObject({ status: 400, body: { error: 'secret_required' } });
    const oauth = await call('PUT', path, { authMethod: 'oauth', customerId: '1234567890', conversionActionId: '77', refreshToken: 'RT-1' });
    expect(oauth).toMatchObject({ status: 200, body: { secretSet: true } });
    expect(JSON.stringify(oauth.body)).not.toContain('RT-1');
    expect((await repo.getWithSecret('google_ads'))?.secret).toBe('RT-1');

    // leaving the token blank keeps it
    await call('PUT', path, { authMethod: 'oauth', customerId: '1234567890', conversionActionId: '78' });
    expect(await repo.getWithSecret('google_ads')).toMatchObject({ secret: 'RT-1', settings: { conversionActionId: '78' } });

    expect(await call('PUT', path, { authMethod: 'carrier-pigeon', customerId: '1234567890', conversionActionId: '77' })).toMatchObject({ status: 400, body: { error: 'invalid_auth_method' } });
  });

  it('the console is told which email to hand to brands, and whether OAuth is available', async () => {
    const meta = (await call('GET', '/meta')).body as { google: { serviceAccountEmail?: string; oauthConfigured: boolean } };
    expect(meta.google).toEqual({ serviceAccountEmail: 'sender@my-project.iam.gserviceaccount.com', oauthConfigured: false });
    const none = await handleAdmin({ method: 'GET', path: '/meta', query: new URLSearchParams(), body: undefined, token: 'tok' }, { ...deps, googleInfo: undefined });
    expect((none.body as { google: unknown }).google).toEqual({ oauthConfigured: false });
  });

  it('the connection check endpoint answers for a known brand and refuses unknown ones', async () => {
    const created = (await call('POST', '/tenants', { name: 'Check Co' })).body as { tenant: { tenantId: string } };
    expect(await call('POST', `/tenants/${created.tenant.tenantId}/connections/google_ads/check`)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await call('POST', '/tenants/nobody/connections/google_ads/check')).status).toBe(404);
  });

  it('the script tag tells the browser when a brand is opt-out', async () => {
    const optIn = (await call('POST', '/tenants', { name: 'In Co', origins: ['https://in.example.com'] })).body as { siteKeys: Array<{ snippet: string }> };
    const optOut = (await call('POST', '/tenants', { name: 'Out Co', consentMode: 'opt_out' })).body as { siteKeys: Array<{ snippet: string }> };
    expect(optIn.siteKeys[0]?.snippet).not.toContain('data-consent-mode');
    expect(optOut.siteKeys[0]?.snippet).toContain('data-consent-mode="opt_out"');
  });

  it('an operator can record a customer privacy request, which then suppresses their queued sales', async () => {
    const created = (await call('POST', '/tenants', { name: 'Privacy Co' })).body as { tenant: { tenantId: string } };
    const id = created.tenant.tenantId;
    const store = new Store(db, { tenantId: id });

    expect(await call('POST', `/tenants/${id}/consent/withdraw`, {})).toMatchObject({ status: 400, body: { error: 'contact_required' } });
    expect(await call('POST', `/tenants/${id}/consent/withdraw`, { phone: 'abc' })).toMatchObject({ status: 400, body: { error: 'invalid_contact' } });

    const ok = await call('POST', `/tenants/${id}/consent/withdraw`, { phone: '98765 43210' });
    expect(ok).toMatchObject({ status: 200, body: { keys: 1, personFound: false } });

    // A sale for that customer arriving afterwards is recorded but never queued for sending.
    const today = new Date().toISOString().slice(0, 10);
    await importCsv(call, id, `eventId,channel,occurredAt,phone,consent\nS1,store,${today},9876543210,yes`);
    const sales = (await call('GET', `/tenants/${id}/sales`)).body as { sales: Array<{ deliveries: Array<{ status: string; skipReason?: string }> }> };
    expect(sales.sales[0]?.deliveries.every((d) => d.status === 'skipped' && d.skipReason === 'consent_withdrawn')).toBe(true);
    expect(await store.isSuppressed([])).toBe(false);
  });
});
