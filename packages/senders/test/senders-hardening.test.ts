import { beforeEach, describe, expect, it } from 'vitest';
import type { SaleRecord } from '@datahash/store';
import { clearGoogleTokenCache, googleAccessToken, sendGoogle, sendMeta, type SendContext } from '../src';

const sale: SaleRecord = {
  source: 'zoho', eventId: 'deal-1', eventName: 'Purchase', channel: 'store', occurredAt: new Date('2026-10-07T09:30:00Z'),
  value: 100, currency: 'INR', personId: null, hashes: { metaPhone: 'mp', googlePhone: 'gp' }, consentAds: true,
};
const ctx: SendContext = { saleKey: 'k', sale, touch: null };
const meta = { settings: { datasetId: '999' }, token: 'TOKEN' };
const google = { settings: { customerId: '1234567890', conversionActionId: '77' }, refreshToken: 'RT' };
const app = { clientId: 'cid', clientSecret: 'cs' };

/** A 200 whose body is not JSON, like an error page from a proxy. */
const html = (headers: Record<string, string> = {}) =>
  ({ ok: true, status: 200, headers: { get: (k: string) => headers[k] ?? null }, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({ ok: status < 400, status, headers: { get: (k: string) => headers[k] ?? null }, json: async () => body }) as unknown as Response;

describe('a reply we cannot read is never reported as sent', () => {
  beforeEach(() => clearGoogleTokenCache());

  it('Meta: unreadable 200 -> retry with the same event ID', async () => {
    const res = await sendMeta(ctx, meta, { fetchImpl: (async () => html()) as never });
    expect(res).toMatchObject({ outcome: 'retry' });
  });

  it('Google: unreadable 200 -> retry with the same transaction ID', async () => {
    const fetchImpl = async (url: string | URL | Request) => (String(url).includes('oauth2') ? json({ access_token: 'AT', expires_in: 3600 }) : html());
    expect(await sendGoogle(ctx, google, app, { fetchImpl: fetchImpl as never })).toMatchObject({ outcome: 'retry' });
  });

  it('Google: a success without a request ID cannot be tracked, so it is retried rather than trusted', async () => {
    const fetchImpl = async (url: string | URL | Request) =>
      String(url).includes('oauth2') ? json({ access_token: 'AT', expires_in: 3600 }) : json({});
    expect(await sendGoogle(ctx, google, app, { fetchImpl: fetchImpl as never })).toMatchObject({ outcome: 'retry' });
  });
});

describe('Google OAuth failures', () => {
  beforeEach(() => clearGoogleTokenCache());

  it('a revoked grant needs the brand to reconnect; rate limits and outages are temporary', async () => {
    const run = (status: number, error: string) => googleAccessToken('RT', app, { fetchImpl: (async () => json({ error }, status)) as never });
    expect(await run(400, 'invalid_grant')).toMatchObject({ ok: false, authError: true });
    expect(await run(401, 'invalid_client')).toMatchObject({ ok: false, authError: true });
    expect(await run(429, 'rate_limit_exceeded')).toMatchObject({ ok: false, authError: false });
    expect(await run(500, 'internal')).toMatchObject({ ok: false, authError: false });
    expect(await run(503, 'unavailable')).toMatchObject({ ok: false, authError: false });
  });

  it('an OAuth rate limit makes the delivery retry instead of flagging the connection', async () => {
    const res = await sendGoogle(ctx, google, app, { fetchImpl: (async () => json({ error: 'rate_limit_exceeded' }, 429)) as never });
    expect(res).toMatchObject({ outcome: 'retry' });
    expect(res).not.toHaveProperty('authError');
  });
});
