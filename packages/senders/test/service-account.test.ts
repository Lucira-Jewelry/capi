import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaleRecord } from '@datahash/store';
import {
  clearGoogleTokenCache,
  clearServiceAccountTokenCache,
  googleAccessFor,
  parseServiceAccountKey,
  retrieveGoogleRequestStatus,
  sendGoogle,
  serviceAccountAccessToken,
  signServiceAccountJwt,
  DATA_MANAGER_SCOPE,
  type SendContext,
  type ServiceAccountKey,
} from '../src';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const key: ServiceAccountKey = { client_email: 'sender@my-project.iam.gserviceaccount.com', private_key: privateKey };

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body }) as unknown as Response;
const NOW = new Date('2026-10-09T10:00:00Z').getTime();

const sale: SaleRecord = {
  source: 'zoho', eventId: 'deal-1', eventName: 'Purchase', channel: 'store', occurredAt: new Date('2026-10-07T09:30:00Z'),
  value: 100, currency: 'INR', personId: null, hashes: { googleEmail: 'ge' }, consentAds: true,
};
const ctx: SendContext = { saleKey: 'k', sale, touch: null };
const saConnection = (extra = {}) => ({ settings: { customerId: '1234567890', conversionActionId: '77', authMethod: 'service_account' as const, ...extra }, refreshToken: '' });

beforeEach(() => {
  clearGoogleTokenCache();
  clearServiceAccountTokenCache();
});

describe('parseServiceAccountKey', () => {
  it('accepts a key file and keeps only what it needs', () => {
    const text = JSON.stringify({ type: 'service_account', project_id: 'p', client_email: key.client_email, private_key: privateKey, client_id: '1' });
    expect(parseServiceAccountKey(text)).toEqual({ ok: true, key: { client_email: key.client_email, private_key: privateKey } });
  });
  it('explains what is wrong without echoing the key', () => {
    expect(parseServiceAccountKey('not json')).toMatchObject({ ok: false });
    expect(parseServiceAccountKey('{"private_key":"-----BEGIN PRIVATE KEY-----x"}')).toMatchObject({ ok: false, error: expect.stringContaining('client_email') });
    const r = parseServiceAccountKey('{"client_email":"a@b.c","private_key":"SECRETVALUE"}');
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain('SECRETVALUE');
  });
});

describe('signServiceAccountJwt', () => {
  it('produces a correctly signed RS256 assertion for the Data Manager scope', () => {
    const jwt = signServiceAccountJwt(key, NOW);
    const [h, c, sig] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iss: key.client_email,
      scope: DATA_MANAGER_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey(publicKey), Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('serviceAccountAccessToken', () => {
  it('exchanges the assertion with the jwt-bearer grant, and caches the token', async () => {
    let body = '';
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return json({ access_token: 'SA-AT', expires_in: 3600 });
    });
    const opts = { fetchImpl: fetchImpl as never, now: () => NOW };
    expect(await serviceAccountAccessToken(key, opts)).toEqual({ ok: true, token: 'SA-AT' });
    expect(await serviceAccountAccessToken(key, opts)).toEqual({ ok: true, token: 'SA-AT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')?.split('.')).toHaveLength(3);
  });

  it('a refused key is a platform problem; an outage is temporary; a bad key file is reported without leaking it', async () => {
    const refused = await serviceAccountAccessToken(key, { fetchImpl: (async () => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)) as never, now: () => NOW });
    expect(refused).toMatchObject({ ok: false, temporary: false, error: expect.stringContaining('invalid_grant') });
    const outage = await serviceAccountAccessToken(key, { fetchImpl: (async () => json({}, 503)) as never, now: () => NOW });
    expect(outage).toMatchObject({ ok: false, temporary: true });
    const rateLimited = await serviceAccountAccessToken(key, { fetchImpl: (async () => json({}, 429)) as never, now: () => NOW });
    expect(rateLimited).toMatchObject({ ok: false, temporary: true });
    const broken = await serviceAccountAccessToken({ client_email: 'x@y.z', private_key: 'garbage' }, { fetchImpl: vi.fn() as never, now: () => NOW });
    expect(broken).toMatchObject({ ok: false, temporary: false });
    expect(JSON.stringify(broken)).not.toContain('garbage');
  });
});

describe('googleAccessFor', () => {
  it('service-account connections need the server to have a key; OAuth ones need the client', async () => {
    expect(await googleAccessFor({ method: 'service_account' }, {})).toMatchObject({ ok: false, kind: 'platform', error: expect.stringContaining('service_account_not_configured') });
    expect(await googleAccessFor({ method: 'oauth', refreshToken: 'RT' }, { serviceAccount: key })).toMatchObject({ ok: false, kind: 'platform', error: expect.stringContaining('google_oauth_client_not_configured') });
  });
});

describe('sendGoogle with the service account', () => {
  const app = { serviceAccount: key };
  const fake = (ingest: () => Response) =>
    vi.fn(async (url: string | URL | Request) => (String(url).includes('oauth2.googleapis.com') ? json({ access_token: 'SA-AT', expires_in: 3600 }) : ingest()));

  it('logs in with the service account, with no per-brand token', async () => {
    const fetchImpl = fake(() => json({ requestId: 'REQ-SA' }));
    const res = await sendGoogle(ctx, saConnection(), app, { fetchImpl: fetchImpl as never });
    expect(res).toMatchObject({ outcome: 'sent', requestId: 'REQ-SA' });

    const tokenCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(tokenCall[1].body)).toContain('jwt-bearer');
    const ingest = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((ingest[1].headers as Record<string, string>).authorization).toBe('Bearer SA-AT');
  });

  it('one token serves every brand', async () => {
    const fetchImpl = fake(() => json({ requestId: 'R' }));
    await sendGoogle(ctx, saConnection(), app, { fetchImpl: fetchImpl as never });
    await sendGoogle(ctx, saConnection({ customerId: '5555555555' }), app, { fetchImpl: fetchImpl as never });
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('oauth2')).length).toBe(1);
  });

  it('no access to the brand account: tells the operator exactly what the brand must do', async () => {
    const res = await sendGoogle(ctx, saConnection({ loginCustomerId: '9876543210' }), app, {
      fetchImpl: fake(() => json({ error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }, 403)) as never,
    });
    expect(res).toMatchObject({ outcome: 'failed', authError: true });
    const error = (res as { error: string }).error;
    expect(error).toContain(key.client_email);
    expect(error).toContain('add');
    expect(error).toContain('9876543210');
  });

  it('a problem with our own key is not blamed on the brand', async () => {
    const res = await sendGoogle(ctx, saConnection(), app, { fetchImpl: (async () => json({ error: 'invalid_grant' }, 400)) as never });
    expect(res).toMatchObject({ outcome: 'failed' });
    expect(res).not.toHaveProperty('authError');
    const unconfigured = await sendGoogle(ctx, saConnection(), {}, { fetchImpl: vi.fn() as never });
    expect(unconfigured).toMatchObject({ outcome: 'failed', error: expect.stringContaining('service_account_not_configured') });
    expect(unconfigured).not.toHaveProperty('authError');
    const outage = await sendGoogle(ctx, saConnection(), app, { fetchImpl: (async () => json({}, 503)) as never });
    expect(outage).toMatchObject({ outcome: 'retry' });
  });

  it('an OAuth connection is unaffected by a service account being present', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2.googleapis.com') ? json({ access_token: 'OAUTH-AT', expires_in: 3600 }) : json({ requestId: 'R' }),
    );
    const res = await sendGoogle(ctx, { settings: { customerId: '1234567890', conversionActionId: '77' }, refreshToken: 'RT' }, { clientId: 'cid', clientSecret: 'cs', serviceAccount: key }, { fetchImpl: fetchImpl as never });
    expect(res).toMatchObject({ outcome: 'sent' });
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain('refresh_token');
  });
});

describe('retrieveGoogleRequestStatus with the service account', () => {
  it('looks up the result without any refresh token', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2') ? json({ access_token: 'SA-AT', expires_in: 3600 }) : json({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] }),
    );
    const r = await retrieveGoogleRequestStatus('REQ-1', { serviceAccount: true }, { serviceAccount: key }, { fetchImpl: fetchImpl as never });
    expect(r).toMatchObject({ ok: true, status: 'SUCCESS' });
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain('jwt-bearer');
  });
});
