import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentifyInput, IdentifyResult } from '@datahash/store';
import {
  cookieName,
  createHttpServer,
  defaultCheckDeps,
  dnsInstructions,
  isPrivateAddress,
  runTrackingCheck,
  type CheckDeps,
  type CheckItem,
  type HttpReply,
} from '../src';

const KEY = 'pk_cccccccccccccccccccccccc';
const HOST = 'track.lucirajewelry.com';
const ORIGIN = 'https://www.lucirajewelry.com';
const PUBLIC = 'https://collector.product.com';
const site = { key: KEY, trackingHost: HOST, origins: [ORIGIN] };
const NOW = new Date('2026-10-09T12:00:00Z');

const reply = (status: number, body = '', headers: HttpReply['headers'] = {}): HttpReply => ({ status, body, headers });
const json = (status: number, body: unknown, headers: HttpReply['headers'] = {}) => reply(status, JSON.stringify(body), headers);

/** A world where everything is set up correctly. Tests override one piece at a time. */
function healthy(over: Partial<CheckDeps> & { respond?: (url: string, init?: Parameters<CheckDeps['request']>[1]) => HttpReply | undefined } = {}): CheckDeps {
  return {
    resolveCname: async () => ['collector.product.com.'],
    lookupAddresses: async () => ['203.0.113.7'],
    request: async (url, init) => {
      const custom = over.respond?.(url, init);
      if (custom) return custom;
      const u = new URL(url);
      if (u.pathname === '/trackcheck') return json(200, { ok: true, siteKnown: true, hostMatches: true, secure: true });
      if (u.pathname === '/tracker.js') return reply(200, 'x'.repeat(6000), { 'content-type': 'application/javascript' });
      if (u.pathname === '/touch' && init?.method === 'OPTIONS') {
        return reply(204, '', { 'access-control-allow-origin': init.headers?.origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
      }
      if (u.pathname === '/touch') {
        return json(200, { status: 'ok' }, { 'access-control-allow-origin': init?.headers?.origin, 'access-control-allow-credentials': 'true', 'set-cookie': [`${cookieName(KEY)}=v1.x.y; Max-Age=100; Path=/; HttpOnly; SameSite=Lax; Secure`] });
      }
      if (u.hostname === 'www.lucirajewelry.com') return reply(200, TAG_PAGE);
      return reply(404);
    },
    ...(over.resolveCname ? { resolveCname: over.resolveCname } : {}),
    ...(over.lookupAddresses ? { lookupAddresses: over.lookupAddresses } : {}),
  };
}

const TAG_PAGE = `<html><head><script src="https://${HOST}/tracker.js" data-key="${KEY}" data-endpoint="https://${HOST}" async></script></head></html>`;
const run = (deps: CheckDeps, s = site, now: () => Date = () => NOW) => runTrackingCheck({ site: s, publicUrl: PUBLIC, deps, now });
const get = (r: { checks: CheckItem[] }, id: CheckItem['id']) => r.checks.find((c) => c.id === id)!;
const netError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

describe('runTrackingCheck: everything set up', () => {
  it('passes every check and is ok', async () => {
    const r = await run(healthy());
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([['dns', 'pass'], ['https', 'pass'], ['script', 'pass'], ['cors', 'pass'], ['cookie', 'pass'], ['tag', 'pass']]);
  });

  it('tests the cookie with a throwaway click, as the brand\'s site would', async () => {
    const seen: Array<{ url: string; init?: Parameters<CheckDeps['request']>[1] }> = [];
    await run(healthy({ respond: (url, init) => { seen.push({ url, init }); return undefined; } }));
    const touch = seen.find((s) => s.url.endsWith('/touch') && s.init?.method === 'POST')!;
    expect(touch.init?.headers?.origin).toBe(ORIGIN);
    expect(JSON.parse(touch.init!.body!)).toMatchObject({ key: KEY, consent: true, touch: { clickedAt: NOW.getTime(), gclid: 'setup-check' } });
  });
});

describe('DNS', () => {
  it('a CNAME to someone else is explained', async () => {
    const r = await run(healthy({ resolveCname: async () => ['old-host.example.net'] }));
    expect(get(r, 'dns')).toMatchObject({ status: 'fail', detail: expect.stringContaining('old-host.example.net') });
    expect(get(r, 'dns').fix).toContain('collector.product.com');
    expect(r.ok).toBe(false);
  });

  it('no record yet tells the brand what to add and that it can take time', async () => {
    const r = await run(healthy({ resolveCname: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); }, lookupAddresses: async (h) => { if (h === HOST) throw new Error('ENOTFOUND'); return ['203.0.113.7']; } }));
    const dns = get(r, 'dns');
    expect(dns.status).toBe('fail');
    expect(dns.fix).toContain('CNAME');
    expect(dns.fix).toContain('track');
    expect(dns.fix).toContain('collector.product.com');
    expect(dns.fix).toContain('Cloudflare');
  });

  it('a DNS provider that flattens the CNAME to addresses is accepted when they match ours', async () => {
    const flat = await run(healthy({ resolveCname: async () => [], lookupAddresses: async () => ['203.0.113.7'] }));
    expect(get(flat, 'dns')).toMatchObject({ status: 'pass', detail: expect.stringContaining('flattens') });
    const other = await run(healthy({ resolveCname: async () => [], lookupAddresses: async (h) => (h === HOST ? ['198.51.100.9'] : ['203.0.113.7']) }));
    expect(get(other, 'dns')).toMatchObject({ status: 'fail', detail: expect.stringContaining('not to our servers') });
  });

  it('a local test name needs no DNS record', async () => {
    const r = await run(healthy(), { ...site, trackingHost: 'track.brand.localhost:8787' });
    expect(get(r, 'dns')).toMatchObject({ status: 'pass', detail: expect.stringContaining('local test name') });
  });
});

describe('HTTPS and routing', () => {
  it('a missing or wrong certificate is reported as something we fix, not the brand', async () => {
    const r = await run(healthy({ respond: (url) => { if (url.includes('/trackcheck')) throw netError('ERR_TLS_CERT_ALTNAME_INVALID'); return undefined; } }));
    const https = get(r, 'https');
    expect(https.status).toBe('fail');
    expect(https.detail).toContain('certificate was refused');
    expect(https.fix).toContain('on our side');
    // everything that needs the address to work is skipped, not failed
    expect(r.checks.filter((c) => ['script', 'cors', 'cookie'].includes(c.id)).map((c) => c.status)).toEqual(['skip', 'skip', 'skip']);
  });

  it.each([
    ['ENOTFOUND', 'does not resolve'],
    ['ECONNREFUSED', 'nothing answered'],
  ])('%s is explained', async (code, text) => {
    const r = await run(healthy({ respond: (url) => { if (url.includes('/trackcheck')) throw netError(code); return undefined; } }));
    expect(get(r, 'https').detail).toContain(text);
  });

  it('a redirect, a non-collector answer, an unknown key and a wrong address each get their own message', async () => {
    const at = (res: HttpReply) => run(healthy({ respond: (url) => (url.includes('/trackcheck') ? res : undefined) }));
    expect(get(await at(reply(301, '', { location: 'https://elsewhere' })), 'https')).toMatchObject({ status: 'fail', detail: expect.stringContaining('redirects') });
    expect(get(await at(reply(200, '<html>parked domain</html>')), 'https')).toMatchObject({ status: 'fail', detail: expect.stringContaining('not from our collector') });
    expect(get(await at(json(200, { ok: true, siteKnown: false, hostMatches: false })), 'https').detail).toContain('does not know this site key');
    expect(get(await at(json(200, { ok: true, siteKnown: true, hostMatches: false })), 'https').detail).toContain('does not recognise this address');
  });
});

describe('script, permission and cookie', () => {
  it('a script file served as HTML (a parked page, a CDN error) fails', async () => {
    const r = await run(healthy({ respond: (url) => (url.endsWith('/tracker.js') ? reply(200, '<html>' + 'x'.repeat(2000), { 'content-type': 'text/html' }) : undefined) }));
    expect(get(r, 'script').status).toBe('fail');
  });

  it('missing permission headers (often a CDN stripping them) fail; no saved website address skips', async () => {
    const r = await run(healthy({ respond: (url, init) => (url.endsWith('/touch') && init?.method === 'OPTIONS' ? reply(204) : undefined) }));
    expect(get(r, 'cors')).toMatchObject({ status: 'fail', fix: expect.stringContaining('CDN') });
    const none = await run(healthy(), { ...site, origins: [] });
    expect(get(none, 'cors').status).toBe('skip');
  });

  it('no cookie because the address is not recognised, a Secure flag lost behind a proxy, and a refused origin', async () => {
    const touch = (res: HttpReply) => run(healthy({ respond: (url, init) => (url.endsWith('/touch') && init?.method === 'POST' ? res : undefined) }));
    expect(get(await touch(json(200, { status: 'skipped', reason: 'not_first_party_host' })), 'cookie').detail).toContain('does not treat this as the brand');
    expect(get(await touch(json(200, { status: 'ok' }, { 'set-cookie': [`${cookieName(KEY)}=v1.x.y; Path=/; HttpOnly`] })), 'cookie')).toMatchObject({ status: 'fail', fix: expect.stringContaining('X-Forwarded-Proto') });
    expect(get(await touch(json(403, { error: 'origin_not_allowed' })), 'cookie').detail).toContain('not allowed');
  });
});

describe('the script tag on the website', () => {
  it('not found in the page source is a warning, not a failure (a tag manager adds tags later)', async () => {
    const r = await run(healthy({ respond: (url) => (url.startsWith(ORIGIN) ? reply(200, '<html><head></head></html>') : undefined) }));
    expect(get(r, 'tag')).toMatchObject({ status: 'warn', fix: expect.stringContaining('Google Tag Manager') });
    expect(r.ok).toBe(true);
  });

  it('follows redirects (non-www to www, http to https) and says when a page cannot be read', async () => {
    const redirected = await run(healthy({
      respond: (url) => {
        if (url === `${ORIGIN}/`) return reply(301, '', { location: 'https://www.lucirajewelry.com/en/' });
        if (url === 'https://www.lucirajewelry.com/en/') return reply(200, TAG_PAGE);
        return undefined;
      },
    }));
    expect(get(redirected, 'tag').status).toBe('pass');

    const blocked = await run(healthy({ respond: (url) => (url.startsWith(ORIGIN) ? reply(403) : undefined) }));
    expect(get(blocked, 'tag')).toMatchObject({ status: 'warn', detail: expect.stringContaining('Could not read') });
  });

  it('a mention of the key in text or a comment is not the script tag', async () => {
    for (const page of [`<p>our key is ${KEY}</p>`, `<!-- <script data-key="${KEY}" data-endpoint="https://${HOST}"></script> -->`, `<div data-key="${KEY}"></div>`]) {
      const r = await run(healthy({ respond: (url) => (url.startsWith(ORIGIN) ? reply(200, page) : undefined) }));
      expect(get(r, 'tag').status).toBe('warn');
    }
  });

  it('a tag that sends its data somewhere other than the tracking address is a failure', async () => {
    for (const endpoint of ['data-endpoint="https://collector.product.com"', '']) {
      const page = `<script src="https://collector.product.com/tracker.js" data-key="${KEY}" ${endpoint} async></script>`;
      const r = await run(healthy({ respond: (url) => (url.startsWith(ORIGIN) ? reply(200, page) : undefined) }));
      expect(get(r, 'tag')).toMatchObject({ status: 'fail', detail: expect.stringContaining(HOST), fix: expect.stringContaining('Install script') });
      expect(r.ok).toBe(false);
    }
  });

  it('accepts attributes in any order, single quotes, and the key on a later script', async () => {
    const page = `<script>var a=1</script><script async data-endpoint='https://${HOST}' data-key='${KEY}'></script>`;
    const r = await run(healthy({ respond: (url) => (url.startsWith(ORIGIN) ? reply(200, page) : undefined) }));
    expect(get(r, 'tag').status).toBe('pass');
  });

  it('checks each allowed website, up to three', async () => {
    const seen: string[] = [];
    await run(healthy({ respond: (url) => { if (/^https:\/\/(a|b|c|d)\.example\.com/.test(url)) seen.push(url); return /example\.com/.test(url) ? reply(200, KEY) : undefined; } }), {
      ...site, origins: ['https://a.example.com', 'https://b.example.com', 'https://c.example.com', 'https://d.example.com'],
    });
    expect(seen).toEqual(['https://a.example.com/', 'https://b.example.com/', 'https://c.example.com/']);
  });
});

describe('permission for the website (CORS)', () => {
  const answered = (over: { preflight?: HttpReply['headers']; post?: HttpReply['headers']; preflightStatus?: number }) => healthy({
    respond: (url, init) => {
      const origin = init?.headers?.origin;
      if (url.endsWith('/touch') && init?.method === 'OPTIONS') {
        return reply(over.preflightStatus ?? 204, '', { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', ...over.preflight });
      }
      if (url.endsWith('/touch') && over.post) {
        return json(200, { status: 'ok' }, { 'set-cookie': [`${cookieName(KEY)}=v1.x.y; Path=/; HttpOnly; Secure`], ...over.post });
      }
      return undefined;
    },
  });

  it('passes when the preliminary question and the real answer both carry permission', async () => {
    expect(get(await run(answered({})), 'cors').status).toBe('pass');
  });

  it('fails when the real answer has no permission headers even though the preliminary question was fine', async () => {
    const r = await run(answered({ post: { 'access-control-allow-origin': undefined, 'access-control-allow-credentials': undefined } }));
    expect(get(r, 'cors')).toMatchObject({ status: 'fail', detail: expect.stringContaining('real request') });
    expect(r.ok).toBe(false);
  });

  it('fails when the real answer allows another origin, or no cookies', async () => {
    expect(get(await run(answered({ post: { 'access-control-allow-origin': 'https://other.example' } })), 'cors').status).toBe('fail');
    expect(get(await run(answered({ post: { 'access-control-allow-credentials': 'false' } })), 'cors').status).toBe('fail');
  });

  it('fails when the preliminary question does not allow POST or the content-type header, or is refused', async () => {
    expect(get(await run(answered({ preflight: { 'access-control-allow-methods': 'GET' } })), 'cors').status).toBe('fail');
    expect(get(await run(answered({ preflight: { 'access-control-allow-headers': 'x-other' } })), 'cors').status).toBe('fail');
    expect(get(await run(answered({ preflightStatus: 403 })), 'cors').status).toBe('fail');
  });

  it('sends one real test click, used for both this check and the cookie check', async () => {
    const seen: string[] = [];
    await run(healthy({ respond: (url, init) => { if (url.endsWith('/touch')) seen.push(init?.method ?? 'GET'); return undefined; } }));
    expect(seen.filter((m) => m === 'POST')).toHaveLength(1);
  });
});

describe('safety', () => {
  it('private and loopback addresses are recognised', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.0.9', '172.16.5.5', '172.31.255.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('addresses that hide a private one inside IPv6, and reserved ranges, are recognised too', () => {
    for (const ip of [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:192.168.1.1',
      '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:c0a8:101::', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '::', '0:0:0:0:0:0:0:1', 'fec0::1', 'ff02::1', '100::1', 'fe80::1%eth0',
      '224.0.0.1', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.8', '0.1.2.3',
      'not an address', '', '1.2.3', '999.1.1.1',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::', '2a00:1450:4001:81b::200e', '1.1.1.1', '93.184.216.34']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('a number typed in place of a name is refused before any connection, in every spelling', async () => {
    const deps = defaultCheckDeps();
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]:9/', 'http://[::ffff:a9fe:a9fe]/', 'http://10.0.0.5/', 'https://[fd00::1]/']) {
      await expect(deps.request(url), url).rejects.toMatchObject({ code: 'BLOCKED' });
    }
  });

  it('other kinds of address and addresses with a login in them are refused', async () => {
    const deps = defaultCheckDeps();
    await expect(deps.request('file:///etc/passwd')).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(deps.request('ftp://example.com/')).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(deps.request('https://user:pw@example.com/')).rejects.toMatchObject({ code: 'BLOCKED' });
  });

  it('a local test name is only reachable when the server was started for local development', async () => {
    const server = createHttpServer({ findSite: async () => null, storeFor: () => ({ identify: async () => ({ status: 'ok', personId: 'p', created: true, merged: false, touchesWritten: 0 }) }) });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const url = `http://anything.brand.localhost:${port}/health`;
      await expect(defaultCheckDeps().request(url)).rejects.toMatchObject({ code: 'BLOCKED' }); // a deployed server
      await expect(defaultCheckDeps({ allowLocalNames: false }).request(url)).rejects.toMatchObject({ code: 'BLOCKED' });
      const local = await defaultCheckDeps({ allowLocalNames: true }).request(url);
      expect(local.status).toBeGreaterThan(0); // reached this machine
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('the real request function refuses to contact private addresses', async () => {
    const deps = defaultCheckDeps();
    await expect(deps.request('http://127.0.0.1:9/')).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(deps.request('https://localhost/')).rejects.toMatchObject({ code: 'BLOCKED' });
  });
});

describe('DNS instructions shown to the operator', () => {
  it('a CNAME with the short name many DNS panels want, and whether it can be handed out yet', () => {
    expect(dnsInstructions('track.lucirajewelry.com', 'https://collector.product.com')).toEqual({
      type: 'CNAME', name: 'track.lucirajewelry.com', short: 'track', target: 'collector.product.com', local: false, ready: true,
    });
    expect(dnsInstructions('t.shop.brand.co.in', 'https://collector.product.com')).toMatchObject({ short: 't', name: 't.shop.brand.co.in' });
    // the server does not know its own public address yet: do not hand out a record pointing at localhost
    expect(dnsInstructions('track.lucirajewelry.com', 'http://localhost:8787')).toMatchObject({ target: 'localhost', ready: false });
    expect(dnsInstructions('track.lucirajewelry.com', 'http://203.0.113.7:8787')).toMatchObject({ ready: false });
    expect(dnsInstructions('track.brand.localhost:8787', 'http://localhost:8787')).toMatchObject({ local: true, ready: true, name: 'track.brand.localhost' });
  });
});

describe('against a real collector (local test name, real HTTP)', () => {
  let server: ReturnType<typeof createHttpServer>;
  let port = 0;
  const identify = async (_i: IdentifyInput): Promise<IdentifyResult> => ({ status: 'ok', personId: 'p', created: true, merged: false, touchesWritten: 0 });

  beforeAll(async () => {
    server = createHttpServer({
      findSite: async (k) => (k === KEY ? { tenantId: 'brand', origins: [ORIGIN], consentMode: 'opt_in', retentionDays: 90, defaultCountry: 'IN', trackingHost: `track-real.brand.localhost:${port}` } : null),
      storeFor: () => ({ identify }),
      cookieSecret: 'secret',
      trackerFile: new URL('../../tracker/dist/tracker.js', import.meta.url).pathname,
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  /** Real HTTP to the collector; the brand's public website is faked so the test needs no internet. */
  const deps = (): CheckDeps => {
    const real = defaultCheckDeps({ allowLocalNames: true });
    return { ...real, request: (url, init) => (new URL(url).hostname.endsWith('.localhost') ? real.request(url, init) : Promise.resolve(reply(200, `<script data-key="${KEY}" data-endpoint="http://track-real.brand.localhost:${port}">`))) };
  };

  it('every check passes when the address is the brand\'s tracking address', async () => {
    // the collector judges the test click against the real clock, so these two use it too
    const r = await run(deps(), { key: KEY, trackingHost: `track-real.brand.localhost:${port}`, origins: [ORIGIN] }, () => new Date());
    expect(r.checks.map((c) => `${c.id}:${c.status}`)).toEqual(['dns:pass', 'https:pass', 'script:pass', 'cors:pass', 'cookie:pass', 'tag:pass']);
    expect(r.ok).toBe(true);
  });

  it('fails the routing check, and says so, when the saved address is a different name', async () => {
    const r = await run(deps(), { key: KEY, trackingHost: `other.brand.localhost:${port}`, origins: [ORIGIN] }, () => new Date());
    expect(get(r, 'https')).toMatchObject({ status: 'fail', detail: expect.stringContaining('does not recognise this address') });
    expect(r.ok).toBe(false);
  });
});
