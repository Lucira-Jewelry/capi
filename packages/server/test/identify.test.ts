import { describe, expect, it, vi } from 'vitest';
import type { IdentifyInput, IdentifyResult } from '@datahash/store';
import { handleIdentify, handleWithdraw, type SiteLookup } from '../src';

const NOW = new Date('2026-10-08T12:00:00Z');

const sites: Record<string, SiteLookup> = {
  k_optin: {
    tenantId: 'brand-a',
    origins: ['https://www.brand-a.com'],
    consentMode: 'opt_in',
    retentionDays: 90,
    defaultCountry: 'IN',
  },
  k_optout: { tenantId: 'brand-b', origins: [], consentMode: 'opt_out', retentionDays: 90, defaultCountry: 'IN' },
};

function setup() {
  const identify = vi.fn(
    async (_input: IdentifyInput): Promise<IdentifyResult> => ({
      status: 'ok',
      personId: 'p1',
      created: true,
      merged: false,
      touchesWritten: 1,
    }),
  );
  const deps = { findSite: async (key: string) => sites[key] ?? null, storeFor: () => ({ identify }), now: () => NOW };
  return { identify, deps };
}

const origin = 'https://www.brand-a.com';
const good = {
  key: 'k_optin',
  phone: '98765 43210',
  consent: { ads: true },
  touches: [{ clickedAt: NOW.getTime() - 1000, gclid: 'G1', utm: { utm_source: 'google', evil: 'x' } }],
};

describe('handleIdentify', () => {
  it('accepts a valid call (also as a text/plain JSON string) and passes clean input to the store', async () => {
    const { identify, deps } = setup();
    const res = await handleIdentify({ body: JSON.stringify(good), origin }, deps);
    expect(res).toEqual({ status: 200, body: { status: 'ok', created: true, merged: false, touches: 1 } });
    const input = identify.mock.calls[0]![0];
    expect(input.phone).toBe('98765 43210');
    expect(input.consent).toEqual({ ads: true, source: 'tracker' });
    expect(input.touches?.[0]).toMatchObject({ gclid: 'G1', utm: { utm_source: 'google' } });
    expect(input.touches?.[0]?.utm).not.toHaveProperty('evil');
  });

  it('rejects unknown keys, bad JSON and disallowed origins', async () => {
    const { deps } = setup();
    expect((await handleIdentify({ body: { ...good, key: 'nope' }, origin }, deps)).status).toBe(401);
    expect((await handleIdentify({ body: '{not json', origin }, deps)).status).toBe(400);
    expect((await handleIdentify({ body: good, origin: 'https://evil.example' }, deps)).status).toBe(403);
    expect((await handleIdentify({ body: good }, deps)).status).toBe(403);
  });

  it('opt_in tenants store nothing without an explicit yes', async () => {
    const { identify, deps } = setup();
    const noConsent = await handleIdentify({ body: { ...good, consent: undefined }, origin }, deps);
    const declined = await handleIdentify({ body: { ...good, consent: { ads: false } }, origin }, deps);
    expect(noConsent).toEqual({ status: 202, body: { status: 'skipped', reason: 'no_consent' } });
    expect(declined.status).toBe(202);
    expect(identify).not.toHaveBeenCalled();
  });

  it('opt_out tenants store unless the visitor declined', async () => {
    const { identify, deps } = setup();
    const body = { key: 'k_optout', email: 'priya@example.com' };
    expect((await handleIdentify({ body }, deps)).status).toBe(200);
    expect((await handleIdentify({ body: { ...body, consent: { ads: false } } }, deps)).status).toBe(202);
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it('validates contacts and touches', async () => {
    const { deps } = setup();
    const call = (extra: object) => handleIdentify({ body: { ...good, ...extra }, origin }, deps);
    expect((await call({ phone: undefined })).status).toBe(400); // no contact
    expect((await call({ phone: 12345 })).status).toBe(400);
    expect((await call({ touches: 'x' })).status).toBe(400);
    expect((await call({ touches: Array(11).fill({ clickedAt: NOW.getTime(), gclid: 'g' }) })).status).toBe(400);
    expect((await call({ touches: [{ clickedAt: NOW.getTime() + 3_600_000, gclid: 'g' }] })).status).toBe(400);
    // a click older than the brand keeps customer data (90 days here) is ignored, not an error: a returning visitor may carry one
    expect((await call({ touches: [{ clickedAt: NOW.getTime() - 500 * 86_400_000, gclid: 'g' }] })).status).toBe(200);
    expect((await call({ touches: [{ clickedAt: NOW.getTime(), gclid: 'x'.repeat(600) }] })).status).toBe(400);
  });

  it('returns 422 when the store finds no usable phone or email', async () => {
    const identify = vi.fn(async (): Promise<IdentifyResult> => ({ status: 'rejected', reason: 'no_valid_identifier' }));
    const res = await handleIdentify(
      { body: { ...good, phone: '123' }, origin },
      { findSite: async (key) => sites[key] ?? null, storeFor: () => ({ identify }), now: () => NOW },
    );
    expect(res).toEqual({ status: 422, body: { error: 'no_valid_identifier' } });
  });
});

describe('withdrawal of consent', () => {
  const withdraw = vi.fn(async () => ({ keys: 2, personFound: true }));
  const setupW = () => {
    withdraw.mockClear();
    const identify = vi.fn(async (): Promise<IdentifyResult> => ({ status: 'ok', personId: 'p1', created: true, merged: false, touchesWritten: 0 }));
    return { identify, deps: { findSite: async (k: string) => sites[k] ?? null, storeFor: () => ({ identify, withdraw }), now: () => NOW } };
  };

  it('an explicit "no" at identify time is recorded as a withdrawal, in both consent modes, and stores nothing else', async () => {
    const { identify, deps } = setupW();
    const declined = { ...good, consent: { ads: false } };
    expect((await handleIdentify({ body: declined, origin }, deps)).status).toBe(202);
    expect(withdraw).toHaveBeenCalledWith({ phone: '98765 43210', defaultCountry: 'IN' }, NOW);

    await handleIdentify({ body: { key: 'k_optout', email: 'a@b.com', consent: { ads: false } } }, deps);
    expect(withdraw).toHaveBeenCalledTimes(2);
    expect(identify).not.toHaveBeenCalled();
  });

  it('silence (no consent field) on an opt-in brand is skipped but is not a withdrawal', async () => {
    const { identify, deps } = setupW();
    const res = await handleIdentify({ body: { ...good, consent: undefined }, origin }, deps);
    expect(res).toEqual({ status: 202, body: { status: 'skipped', reason: 'no_consent' } });
    expect(withdraw).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
  });

  it('/consent records a withdrawal for the brand behind a valid site key and origin', async () => {
    const { deps } = setupW();
    const res = await handleWithdraw({ body: JSON.stringify({ key: 'k_optin', email: 'priya@example.com' }), origin }, deps);
    expect(res).toEqual({ status: 200, body: { status: 'withdrawn', keys: 2, personFound: true } });
    expect(withdraw).toHaveBeenCalledWith({ email: 'priya@example.com', defaultCountry: 'IN' }, NOW);
  });

  it('/consent refuses unknown keys, other origins and unusable contacts', async () => {
    const { deps } = setupW();
    expect((await handleWithdraw({ body: { key: 'nope', phone: '1' }, origin }, deps)).status).toBe(401);
    expect((await handleWithdraw({ body: { key: 'k_optin', phone: '98765 43210' }, origin: 'https://evil.example' }, deps)).status).toBe(403);
    expect((await handleWithdraw({ body: { key: 'k_optin' }, origin }, deps)).status).toBe(400);
    expect((await handleWithdraw({ body: { key: 'k_optin', phone: 5 }, origin }, deps)).status).toBe(400);
    expect((await handleWithdraw({ body: '{nope', origin }, deps)).status).toBe(400);
    expect(withdraw).not.toHaveBeenCalled();
  });
});
