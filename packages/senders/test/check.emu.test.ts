import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsRepo, createFirestore, SecretBox } from '@datahash/store';
import { checkGoogleConnection, checkMetaConnection, clearGoogleTokenCache } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
const box = new SecretBox(SecretBox.generateKey());

afterAll(async () => {
  if (emulator) await db.terminate();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body }) as unknown as Response;
const app = { clientId: 'cid', clientSecret: 'cs' };

function fake(ingest: () => Response) {
  return vi.fn(async (url: string | URL | Request) => (String(url).includes('oauth2') ? json({ access_token: 'AT', expires_in: 3600 }) : ingest()));
}

describe.skipIf(!emulator)('checkGoogleConnection (Firestore emulator)', () => {
  beforeEach(() => clearGoogleTokenCache());
  const connected = async () => {
    const connections = new ConnectionsRepo(db, box, `chk-${randomUUID()}`);
    await connections.set('google_ads', { customerId: '1234567890', conversionActionId: '77' }, 'RT');
    return connections;
  };

  it('success: validates only (nothing is ingested) and marks the connection healthy', async () => {
    const connections = await connected();
    await connections.markStatus('google_ads', 'error', 'earlier problem');
    const fetchImpl = fake(() => json({ requestId: 'unused' }));
    const r = await checkGoogleConnection({ connections, google: app, http: { fetchImpl: fetchImpl as never } });

    expect(r.ok).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.validateOnly).toBe(true);
    expect(body.events[0].transactionId).toBe('connection-check');
    expect(JSON.stringify(body)).not.toMatch(/@|\+91/); // only a hash of a made-up address
    expect((await connections.get('google_ads'))?.status).toBe('active');
  });

  it('a wrong conversion action type is reported in plain terms and does not flag the connection', async () => {
    const connections = await connected();
    const fetchImpl = fake(() =>
      json({ error: { status: 'INVALID_ARGUMENT', message: 'bad action', details: [{ reason: 'INVALID_CONVERSION_ACTION_TYPE' }] } }, 400),
    );
    const r = await checkGoogleConnection({ connections, google: app, http: { fetchImpl: fetchImpl as never } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('INVALID_CONVERSION_ACTION_TYPE');
    expect((await connections.get('google_ads'))?.status).toBe('active');
  });

  it('no access to the account flags the connection as needing attention', async () => {
    const connections = await connected();
    const fetchImpl = fake(() => json({ error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }, 403));
    const r = await checkGoogleConnection({ connections, google: app, http: { fetchImpl: fetchImpl as never } });
    expect(r.ok).toBe(false);
    expect((await connections.get('google_ads'))?.status).toBe('error');
  });

  it('a temporary problem is not blamed on the brand', async () => {
    const connections = await connected();
    const r = await checkGoogleConnection({ connections, google: app, http: { fetchImpl: fake(() => json({}, 503)) as never } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('try again') });
    expect((await connections.get('google_ads'))?.status).toBe('active');
  });

  it('says what is missing: no connection, no OAuth client, unreadable token', async () => {
    const none = new ConnectionsRepo(db, box, `chk-${randomUUID()}`);
    expect(await checkGoogleConnection({ connections: none, google: app })).toMatchObject({ ok: false, message: expect.stringContaining('not connected') });

    const connections = await connected();
    expect(await checkGoogleConnection({ connections })).toMatchObject({ ok: false, message: expect.stringContaining('GOOGLE_CLIENT_ID') });

    const wrongKey = new ConnectionsRepo(db, new SecretBox(SecretBox.generateKey()), (connections as unknown as { col: { parent: { id: string } } }).col.parent.id);
    expect(await checkGoogleConnection({ connections: wrongKey, google: app })).toMatchObject({ ok: false, message: expect.stringContaining('decrypted') });
  });
});

describe.skipIf(!emulator)('checkMetaConnection (Firestore emulator)', () => {
  const connected = async (settings: { datasetId: string; testEventCode?: string }) => {
    const connections = new ConnectionsRepo(db, box, `chk-${randomUUID()}`);
    await connections.set('meta', settings, 'EAAG-secret-token');
    return connections;
  };
  const bodyOf = (f: ReturnType<typeof vi.fn>) => JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

  it('sends nothing at all without a test event code, so a fake purchase can never reach the live data', async () => {
    const connections = await connected({ datasetId: '999' });
    const fetchImpl = vi.fn();
    const r = await checkMetaConnection({ connections, http: { fetchImpl: fetchImpl as never } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Test event code');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with a test code, sends one made-up purchase to Test Events only and says where to look', async () => {
    const connections = await connected({ datasetId: '999', testEventCode: 'TEST66528' });
    await connections.markStatus('meta', 'error', 'earlier problem');
    const fetchImpl = vi.fn(async () => json({ events_received: 1, fbtrace_id: 'TRACE9' }));
    const r = await checkMetaConnection({ connections, http: { fetchImpl: fetchImpl as never }, now: () => new Date('2026-10-13T10:00:00Z') });

    expect(r).toMatchObject({ ok: true, datasetId: '999', testEventCode: 'TEST66528', detail: expect.stringContaining('events_received=1') });
    expect(r.message).toContain('Test Events');
    expect(r.message).toContain('TEST66528');
    const body = bodyOf(fetchImpl);
    expect(body.test_event_code).toBe('TEST66528');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event_id).toBe(`connection-check-${new Date('2026-10-13T10:00:00Z').getTime()}`);
    expect(JSON.stringify(body)).not.toMatch(/@|\+91/); // only a hash of a made-up address
    expect(JSON.stringify(r)).not.toContain('EAAG-secret-token');
    expect((await connections.get('meta'))?.status).toBe('active');
  });

  it('a wrong token flags the connection; a temporary problem does not blame the brand', async () => {
    const connections = await connected({ datasetId: '999', testEventCode: 'TEST1' });
    const bad = await checkMetaConnection({ connections, http: { fetchImpl: (async () => json({ error: { code: 190, message: 'Invalid OAuth access token' } }, 401)) as never } });
    expect(bad.ok).toBe(false);
    expect((await connections.get('meta'))?.status).toBe('error');

    const fine = await connected({ datasetId: '999', testEventCode: 'TEST1' });
    const down = await checkMetaConnection({ connections: fine, http: { fetchImpl: (async () => json({ error: { code: 2, message: 'Service temporarily unavailable' } }, 503)) as never } });
    expect(down).toMatchObject({ ok: false, message: expect.stringContaining('try again') });
    expect((await fine.get('meta'))?.status).toBe('active');
  });

  it('says what is missing: no connection, unreadable token', async () => {
    const none = new ConnectionsRepo(db, box, `chk-${randomUUID()}`);
    expect(await checkMetaConnection({ connections: none })).toMatchObject({ ok: false, message: expect.stringContaining('not connected') });

    const connections = await connected({ datasetId: '999', testEventCode: 'TEST1' });
    const otherKey = new ConnectionsRepo(db, new SecretBox(SecretBox.generateKey()), (connections as unknown as { col: { parent: { id: string } } }).col.parent.id);
    expect(await checkMetaConnection({ connections: otherKey })).toMatchObject({ ok: false, message: expect.stringContaining('cannot be decrypted') });
  });
});
