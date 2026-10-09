import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Touch } from '@datahash/core';
import type { SaleRecord } from '@datahash/store';
import {
  buildGoogleEvent,
  buildGoogleRequest,
  buildMetaEvent,
  clearGoogleTokenCache,
  googleAccessToken,
  retrieveGoogleRequestStatus,
  sendGoogle,
  sendMeta,
  type SendContext,
} from '../src';

const occurredAt = new Date('2026-10-07T09:30:00Z');

const sale = (over: Partial<SaleRecord> = {}): SaleRecord => ({
  source: 'zoho',
  eventId: 'deal-1',
  eventName: 'Purchase',
  channel: 'store',
  occurredAt,
  value: 85000,
  currency: 'INR',
  personId: 'p1',
  hashes: { metaPhone: 'mp', googlePhone: 'gp', metaEmail: 'me', googleEmail: 'ge' },
  consentAds: true,
  ...over,
});

const touch = (over: Partial<Touch> = {}): Touch => ({ id: 't1', clickedAt: new Date('2026-09-30T10:00:00Z'), ...over });
const ctx = (s: SaleRecord = sale(), t: Touch | null = null): SendContext => ({ saleKey: 'k', sale: s, touch: t });

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const meta = { settings: { datasetId: '999', testEventCode: undefined as string | undefined }, token: 'TOKEN' };
const google = { settings: { customerId: '1234567890', conversionActionId: '77' }, refreshToken: 'RT' };
const app = { clientId: 'cid', clientSecret: 'cs' };

describe('buildMetaEvent', () => {
  it('builds a store sale with hashed contact details and the stable event ID', () => {
    expect(buildMetaEvent(ctx())).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(occurredAt.getTime() / 1000),
      event_id: 'deal-1',
      action_source: 'physical_store',
      user_data: { ph: ['mp'], em: ['me'] },
      custom_data: { value: 85000, currency: 'INR' },
    });
  });

  it('adds the click: stored fbc, or one rebuilt from fbclid with the ORIGINAL click time', () => {
    const t1 = buildMetaEvent(ctx(sale(), touch({ fbc: 'fb.1.111.F1', fbclid: 'F1' })));
    expect(t1?.user_data.fbc).toBe('fb.1.111.F1');
    const t2 = buildMetaEvent(ctx(sale(), touch({ fbclid: 'F2' })));
    expect(t2?.user_data.fbc).toBe(`fb.1.${new Date('2026-09-30T10:00:00Z').getTime()}.F2`);
  });

  it('WhatsApp sales use business_messaging with the ctwa_clid', () => {
    const e = buildMetaEvent(ctx(sale({ channel: 'whatsapp' }), touch({ ctwaClid: 'C1' })));
    expect(e).toMatchObject({ action_source: 'business_messaging', messaging_channel: 'whatsapp', user_data: { ctwa_clid: 'C1' } });
  });

  it('omits custom_data without a value and returns null with nothing to match on', () => {
    const { value: _v, currency: _c, ...noValue } = sale();
    expect(buildMetaEvent(ctx(noValue as SaleRecord))?.custom_data).toBeUndefined();
    expect(buildMetaEvent(ctx(sale({ hashes: {} })))).toBeNull();
  });
});

describe('sendMeta', () => {
  it('posts to the dataset with the token and test code, and reports success', async () => {
    const fetchImpl = vi.fn(async () => json({ events_received: 1, fbtrace_id: 'TRACE1' }));
    const res = await sendMeta(ctx(), { ...meta, settings: { datasetId: '999', testEventCode: 'TEST1' } }, { fetchImpl: fetchImpl as never, apiVersion: 'v99.0' });
    expect(res).toEqual({ outcome: 'sent', response: 'events_received=1 trace=TRACE1' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v99.0/999/events?access_token=TOKEN');
    const body = JSON.parse(init.body as string);
    expect(body.test_event_code).toBe('TEST1');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event_id).toBe('deal-1');
  });

  it('classifies errors: auth -> failed+authError, rate limit/outage -> retry, bad data -> failed', async () => {
    const run = (status: number, error: object) =>
      sendMeta(ctx(), meta, { fetchImpl: (async () => json({ error }, status)) as never });

    expect(await run(400, { code: 190, message: 'Invalid OAuth access token' })).toMatchObject({ outcome: 'failed', authError: true });
    expect(await run(400, { code: 4, message: 'rate limit' })).toMatchObject({ outcome: 'retry' });
    expect(await run(500, { message: 'oops' })).toMatchObject({ outcome: 'retry' });
    expect(await run(400, { code: 100, message: 'Invalid parameter', is_transient: true })).toMatchObject({ outcome: 'retry' });
    const bad = await run(400, { code: 100, message: 'Invalid parameter' });
    expect(bad).toMatchObject({ outcome: 'failed' });
    expect(bad).not.toHaveProperty('authError');
  });

  it('retries on network errors and fails events Meta did not receive', async () => {
    const down = await sendMeta(ctx(), meta, { fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as never });
    expect(down).toEqual({ outcome: 'retry', error: 'network: ECONNRESET' });
    const zero = await sendMeta(ctx(), meta, { fetchImpl: (async () => json({ events_received: 0 })) as never });
    expect(zero.outcome).toBe('failed');
  });

  it('never puts the token in an error message', async () => {
    const res = await sendMeta(ctx(), meta, { fetchImpl: (async () => json({ error: { code: 100, message: 'bad' } }, 400)) as never });
    expect(JSON.stringify(res)).not.toContain('TOKEN');
  });

  it('refuses to send an event with nothing to match on', async () => {
    const fetchImpl = vi.fn();
    const res = await sendMeta(ctx(sale({ hashes: {} })), meta, { fetchImpl: fetchImpl as never });
    expect(res.outcome).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('buildGoogleEvent / buildGoogleRequest (Data Manager API)', () => {
  it('a store sale with a click: IN_STORE, UTC timestamp, transaction ID, click ID and lowercase-hex identifiers', () => {
    expect(buildGoogleEvent(ctx(sale(), touch({ gclid: 'G1' })))).toEqual({
      eventTimestamp: '2026-10-07T09:30:00.000Z',
      transactionId: 'deal-1',
      eventSource: 'IN_STORE',
      conversionValue: 85000,
      currency: 'INR',
      adIdentifiers: { gclid: 'G1' },
      userData: { userIdentifiers: [{ emailAddress: 'ge' }, { phoneNumber: 'gp' }] },
    });
  });

  it('event source follows the channel', () => {
    const source = (channel: SaleRecord['channel']) => buildGoogleEvent(ctx(sale({ channel })))?.eventSource;
    expect(source('store')).toBe('IN_STORE');
    expect(source('whatsapp')).toBe('MESSAGE');
    expect(source('online')).toBe('WEB');
    expect(source('web_lead')).toBe('WEB');
  });

  it('no click ID: matches on hashed identifiers only; no value: no currency either', () => {
    const { value: _v, currency: _c, ...noValue } = sale();
    const e = buildGoogleEvent(ctx(noValue as SaleRecord));
    expect(e?.adIdentifiers).toBeUndefined();
    expect(e?.userData?.userIdentifiers).toHaveLength(2);
    expect(e?.conversionValue).toBeUndefined();
    expect(e?.currency).toBeUndefined();
  });

  it('gclid wins over gbraid and wbraid; braid-only clicks are sent without user data (conservative, VERIFY)', () => {
    expect(buildGoogleEvent(ctx(sale(), touch({ gclid: 'G', gbraid: 'B', wbraid: 'W' })))?.adIdentifiers).toEqual({ gclid: 'G' });
    const braid = buildGoogleEvent(ctx(sale(), touch({ gbraid: 'B1' })));
    expect(braid?.adIdentifiers).toEqual({ gbraid: 'B1' });
    expect(braid?.userData).toBeUndefined();
    expect(buildGoogleEvent(ctx(sale(), touch({ wbraid: 'W1' })))?.adIdentifiers).toEqual({ wbraid: 'W1' });
  });

  it('nothing to match on means nothing is built', () => {
    expect(buildGoogleEvent(ctx(sale({ hashes: {} })))).toBeNull();
    expect(buildGoogleRequest(ctx(sale({ hashes: {} })), google.settings)).toBeNull();
    // a braid-only click for a sale whose only identifiers are suppressed with it also has nothing left
    expect(buildGoogleEvent(ctx(sale({ hashes: { googlePhone: 'gp' } }), touch({ gbraid: 'B' })))?.adIdentifiers).toEqual({ gbraid: 'B' });
  });

  it('request: destination names the account and the conversion action; login account is the manager when set', () => {
    const direct = buildGoogleRequest(ctx(sale(), touch({ gclid: 'G1' })), google.settings)!;
    expect(direct.destinations).toEqual([
      {
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' },
        loginAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' },
        productDestinationId: '77',
      },
    ]);
    expect(direct.encoding).toBe('HEX');
    expect(direct.validateOnly).toBe(false);

    const viaManager = buildGoogleRequest(ctx(sale(), touch({ gclid: 'G1' })), { ...google.settings, loginCustomerId: '9876543210' })!;
    expect(viaManager.destinations[0]).toMatchObject({
      operatingAccount: { accountId: '1234567890' },
      loginAccount: { accountId: '9876543210' },
    });
  });

  it('consent: only an explicit yes is stated, and only for ad user data; unknown consent is not guessed', () => {
    expect(buildGoogleRequest(ctx(sale({ consentAds: true })), google.settings)?.consent).toEqual({ adUserData: 'CONSENT_GRANTED' });
    expect(buildGoogleRequest(ctx(sale({ consentAds: null })), google.settings)?.consent).toBeUndefined();
  });

  it('no encoding is stated when no hashed identifiers are sent', () => {
    const r = buildGoogleRequest(ctx(sale({ hashes: {} }), touch({ gclid: 'G1' })), google.settings)!;
    expect(r.encoding).toBeUndefined();
    expect(r.events[0]?.userData).toBeUndefined();
  });
});

describe('sendGoogle (Data Manager API)', () => {
  beforeEach(() => clearGoogleTokenCache());

  function fakeGoogle(ingest: () => Response) {
    return vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2.googleapis.com') ? json({ access_token: 'AT', expires_in: 3600 }) : ingest(),
    );
  }

  it('posts to events:ingest with the bearer token and reports the request ID', async () => {
    const fetchImpl = fakeGoogle(() => json({ requestId: 'REQ-1', fieldWarnings: [] }));
    const res = await sendGoogle(ctx(sale(), touch({ gclid: 'G1' })), google, app, { fetchImpl: fetchImpl as never });
    expect(res).toEqual({ outcome: 'sent', response: 'accepted request=REQ-1', requestId: 'REQ-1' });

    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer AT');
    expect(JSON.parse(init.body as string)).toMatchObject({ validateOnly: false, events: [{ transactionId: 'deal-1', adIdentifiers: { gclid: 'G1' } }] });
  });

  it('warnings are counted in the summary', async () => {
    const fetchImpl = fakeGoogle(() => json({ requestId: 'REQ-2', fieldWarnings: [{}, {}] }));
    const res = await sendGoogle(ctx(), google, app, { fetchImpl: fetchImpl as never });
    expect(res).toMatchObject({ outcome: 'sent', response: 'accepted request=REQ-2 warnings=2' });
  });

  it('validateOnly checks access and the conversion action without ingesting anything', async () => {
    const fetchImpl = fakeGoogle(() => json({}));
    const res = await sendGoogle(ctx(), google, app, { fetchImpl: fetchImpl as never, validateOnly: true });
    expect(res).toEqual({ outcome: 'sent', response: 'validated (nothing was sent)' });
    expect(JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).validateOnly).toBe(true);
  });

  it('reuses the access token between sends', async () => {
    const fetchImpl = fakeGoogle(() => json({ requestId: 'R' }));
    for (let i = 0; i < 3; i++) await sendGoogle(ctx(), google, app, { fetchImpl: fetchImpl as never });
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('oauth2')).length).toBe(1);
  });

  it('classifies failures: access problems need a person, rate limits and outages retry, bad data fails, reasons are shown', async () => {
    const run = (status: number, error: object) => {
      clearGoogleTokenCache();
      return sendGoogle(ctx(), google, app, { fetchImpl: fakeGoogle(() => json({ error }, status)) as never });
    };
    expect(await run(403, { status: 'PERMISSION_DENIED', message: 'no access' })).toMatchObject({ outcome: 'failed', authError: true });
    expect(await run(401, { status: 'UNAUTHENTICATED', message: 'bad token' })).toMatchObject({ outcome: 'failed', authError: true });
    expect(await run(429, { status: 'RESOURCE_EXHAUSTED', message: 'quota' })).toMatchObject({ outcome: 'retry' });
    expect(await run(503, { status: 'UNAVAILABLE', message: 'down' })).toMatchObject({ outcome: 'retry' });

    const bad = await run(400, {
      status: 'INVALID_ARGUMENT',
      message: 'bad conversion action',
      details: [{ reason: 'INVALID_CONVERSION_ACTION_TYPE', fieldViolations: [{ field: 'destinations[0].productDestinationId', description: 'must be UPLOAD_CLICKS' }] }],
    });
    expect(bad).toMatchObject({ outcome: 'failed' });
    expect(bad).not.toHaveProperty('authError');
    expect((bad as { error: string }).error).toContain('INVALID_CONVERSION_ACTION_TYPE');
    expect((bad as { error: string }).error).toContain('must be UPLOAD_CLICKS');
  });

  it('sends nothing when there is nothing to match on', async () => {
    const fetchImpl = vi.fn();
    const res = await sendGoogle(ctx(sale({ hashes: {} })), google, app, { fetchImpl: fetchImpl as never });
    expect(res).toMatchObject({ outcome: 'failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a revoked grant needs a reconnect; an OAuth outage is temporary; tokens never leak into results', async () => {
    const revoked = await sendGoogle(ctx(), google, app, { fetchImpl: (async () => json({ error: 'invalid_grant' }, 400)) as never });
    expect(revoked).toMatchObject({ outcome: 'failed', authError: true });
    clearGoogleTokenCache();
    const outage = await sendGoogle(ctx(), google, app, { fetchImpl: (async () => json({}, 503)) as never });
    expect(outage).toMatchObject({ outcome: 'retry' });
    expect(JSON.stringify([revoked, outage])).not.toMatch(/RT"/);
  });
});

describe('googleAccessToken', () => {
  beforeEach(() => clearGoogleTokenCache());
  it('a refused grant means reconnect; rate limits and outages are temporary', async () => {
    const run = (status: number, error: string) => googleAccessToken('RT', app, { fetchImpl: (async () => json({ error }, status)) as never });
    expect(await run(400, 'invalid_grant')).toMatchObject({ ok: false, authError: true });
    expect(await run(429, 'rate_limit_exceeded')).toMatchObject({ ok: false, authError: false });
    expect(await run(503, 'unavailable')).toMatchObject({ ok: false, authError: false });
  });
});

describe('retrieveGoogleRequestStatus', () => {
  beforeEach(() => clearGoogleTokenCache());
  const lookup = (body: unknown, status = 200) =>
    retrieveGoogleRequestStatus('REQ 1', 'RT', app, {
      fetchImpl: (async (url: string | URL | Request) => (String(url).includes('oauth2') ? json({ access_token: 'AT', expires_in: 3600 }) : json(body, status))) as never,
    });

  it('asks for the request by ID with the token', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (String(url).includes('oauth2') ? json({ access_token: 'AT', expires_in: 3600 }) : json({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] })));
    await retrieveGoogleRequestStatus('REQ 1', 'RT', app, { fetchImpl: fetchImpl as never });
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=REQ%201');
    expect(init.method).toBe('GET');
  });

  it('maps the status and collects reasons with counts', async () => {
    expect(await lookup({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] })).toMatchObject({ ok: true, status: 'SUCCESS' });
    expect(await lookup({ requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }] })).toMatchObject({ ok: true, status: 'PROCESSING' });

    const failed = await lookup({
      requestStatusPerDestination: [
        {
          requestStatus: 'PARTIAL_SUCCESS',
          errorInfo: { errorCounts: [{ reason: 'INVALID_CONVERSION_ACTION_TYPE', recordCount: '3' }] },
          warningInfo: { warningCounts: [{ reason: 'SOMETHING_IGNORED', recordCount: 1 }] },
        },
      ],
    });
    expect(failed).toEqual({
      ok: true,
      status: 'PARTIAL_SUCCESS',
      errors: [{ reason: 'INVALID_CONVERSION_ACTION_TYPE', count: 3 }],
      warnings: [{ reason: 'SOMETHING_IGNORED', count: 1 }],
    });
  });

  it('with several destinations the worst result wins; an empty answer is unknown', async () => {
    const r = await lookup({ requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }, { requestStatus: 'FAILED' }, { requestStatus: 'PROCESSING' }] });
    expect(r).toMatchObject({ ok: true, status: 'FAILED' });
    expect(await lookup({})).toMatchObject({ ok: true, status: 'UNKNOWN' });
  });

  it('lookup failures say whether access is the problem', async () => {
    expect(await lookup({ error: { status: 'PERMISSION_DENIED', message: 'no' } }, 403)).toMatchObject({ ok: false, authError: true });
    expect(await lookup({ error: { status: 'UNAVAILABLE', message: 'later' } }, 503)).toMatchObject({ ok: false, authError: false });
    expect(await lookup({ error: { status: 'NOT_FOUND', message: 'no such request' } }, 404)).toMatchObject({ ok: false, authError: false });
  });
});
