import { describe, expect, it } from 'vitest';
import { DATA_MANAGER_SCOPE, exchangeGoogleCode, googleAuthUrl } from '../src';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const app = { clientId: 'cid', clientSecret: 'cs' };

describe('googleAuthUrl', () => {
  it('asks for the Data Manager scope, offline access and a fresh consent, and carries the state', () => {
    const url = new URL(googleAuthUrl({ clientId: 'cid' }, 'http://localhost:8788/callback', 'STATE1'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'http://localhost:8788/callback',
      response_type: 'code',
      scope: DATA_MANAGER_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state: 'STATE1',
    });
  });
});

describe('exchangeGoogleCode', () => {
  it('returns the refresh token and posts the code with the client credentials', async () => {
    let body = '';
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return json({ refresh_token: 'RT-1', scope: DATA_MANAGER_SCOPE, access_token: 'AT' });
    };
    expect(await exchangeGoogleCode('CODE', 'http://localhost:8788/callback', app, { fetchImpl: fetchImpl as never })).toEqual({
      ok: true,
      refreshToken: 'RT-1',
      scope: DATA_MANAGER_SCOPE,
    });
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({ code: 'CODE', client_id: 'cid', client_secret: 'cs', grant_type: 'authorization_code' });
  });

  it('explains the usual failures', async () => {
    const run = (res: Response) => exchangeGoogleCode('C', 'http://localhost/cb', app, { fetchImpl: (async () => res) as never });
    expect(await run(json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400))).toMatchObject({ ok: false, error: expect.stringContaining('invalid_grant') });
    expect(await run(json({ access_token: 'AT', scope: DATA_MANAGER_SCOPE }))).toMatchObject({ ok: false, error: expect.stringContaining('refresh token') });
    expect(await run(json({ refresh_token: 'RT', scope: 'https://www.googleapis.com/auth/adwords' }))).toMatchObject({ ok: false, error: expect.stringContaining('Data Manager scope') });
    expect(await exchangeGoogleCode('C', 'x', app, { fetchImpl: (async () => { throw new Error('offline'); }) as never })).toMatchObject({ ok: false });
  });
});
