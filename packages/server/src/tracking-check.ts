import { lookup, resolveCname as dnsResolveCname } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { cookieName } from './first-party';

/**
 * "Check setup" for a brand's own tracking address. Runs from OUR server and tests the things that decide whether the
 * address works, in the order they usually break: the DNS record, HTTPS, the script file, cross-site permission, the
 * first-party cookie, and whether the script tag is actually on the brand's website.
 */
export interface SiteToCheck {
  key: string;
  trackingHost: string;
  /** Pages the brand's tag may run on. The first is used to test cross-site permission. */
  origins: string[];
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckItem {
  id: 'dns' | 'https' | 'script' | 'cors' | 'cookie' | 'tag';
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a failure, in plain words. */
  fix?: string;
}

export interface CheckResult {
  /** True when nothing failed (warnings are fine). */
  ok: boolean;
  checks: CheckItem[];
}

export interface HttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface CheckDeps {
  resolveCname(host: string): Promise<string[]>;
  lookupAddresses(host: string): Promise<string[]>;
  /** One request, no redirects followed. Must refuse private or loopback addresses (except *.localhost, for local testing). */
  request(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<HttpReply>;
}

const isLocalName = (host: string) => /\.localhost(:\d+)?$/.test(host);
const hostOnly = (host: string) => host.replace(/:\d+$/, '');
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Ranges a public website never lives in: this machine, private networks, link-local (cloud metadata), carrier NAT,
// benchmarking, multicast and reserved. Documentation ranges are allowed: they are not routable, so they cannot reach anything.
const V4_BLOCKED: Array<[number, number]> = (
  [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as Array<[string, number]>
).map(([ip, bits]) => [ipv4ToInt(ip)!, bits]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/** The eight 16-bit groups of an IPv6 address, or null if it cannot be read. */
function expandIpv6(ip: string): number[] | null {
  let a = ip.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1]!);
    if (v4 === null) return null;
    a = a.slice(0, a.length - dotted[1]!.length) + `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip)!;
    return V4_BLOCKED.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  if (kind !== 6) return true; // not an address we can reason about: do not connect
  const g = expandIpv6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1 (and the old IPv4-compatible form)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6]!, g[7]!); // ::ffff:1.2.3.4, an IPv4 address in IPv6 clothes
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || v4(g[6]!, g[7]!); // NAT64: 64:ff9b::/96 carries an IPv4 address
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 6to4 carries an IPv4 address
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

const blocked = () => Object.assign(new Error('blocked_private_address'), { code: 'BLOCKED' });

/**
 * Looks the name up and refuses it unless every address is public, and hands that same answer to the connection.
 * Checking first and connecting separately would let a name change its answer in between (DNS rebinding).
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }).then(
    (addrs) => {
      if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) return callback(blocked(), '', 0);
      if (options.all) callback(null, addrs);
      else callback(null, addrs[0]!.address, addrs[0]!.family);
    },
    (err) => callback(err, '', 0),
  );
};

const MAX_BODY = 1_000_000;

function sendRequest(
  u: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  connect: { host?: string; lookup?: LookupFunction },
): Promise<HttpReply> {
  return new Promise<HttpReply>((resolve, reject) => {
    const make = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = make(
      u,
      { method: init.method ?? 'GET', headers: init.headers, timeout: init.timeoutMs ?? 8000, ...(connect.host ? { host: connect.host } : {}), ...(connect.lookup ? { lookup: connect.lookup } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        };
        res.on('data', (c: Buffer) => {
          if (done) return;
          chunks.push(c);
          size += c.length;
          if (size >= MAX_BODY) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', (e) => (done ? undefined : reject(e)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * The real thing: system DNS and real HTTP. Only public addresses are contacted, so the setup check cannot be used to
 * probe a private network or the cloud metadata service. A `*.localhost` test name is reached on this machine with its
 * Host header, but only when `allowLocalNames` is set (a development server), never on a deployed one.
 */
export function defaultCheckDeps(opts: { allowLocalNames?: boolean } = {}): CheckDeps {
  return {
    resolveCname: (host) => dnsResolveCname(host),
    lookupAddresses: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    async request(url, init = {}) {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blocked();
      if (u.username || u.password) throw blocked();
      if (opts.allowLocalNames && isLocalName(u.host)) {
        return sendRequest(new URL(`http://127.0.0.1:${u.port || 80}${u.pathname}${u.search}`), { ...init, headers: { ...init.headers, host: u.host } }, {});
      }
      // An address typed in as a number never goes through a DNS lookup, so it is checked here.
      const literal = u.hostname.replace(/^\[|\]$/g, '');
      if (isIP(literal) && isPrivateAddress(literal)) throw blocked();
      return sendRequest(u, init, { lookup: safeLookup });
    },
  };
}

/** Say what went wrong with a failed request in words a person can act on. */
function describeNetworkError(err: unknown): { text: string; certificate: boolean } {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  const code = e.cause?.code ?? e.code ?? '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_TLS/.test(code)) return { text: `the certificate was refused (${code})`, certificate: true };
  if (code === 'ENOTFOUND' || code === 'ENODATA') return { text: 'the name does not resolve yet', certificate: false };
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return { text: `nothing answered on that address (${code})`, certificate: false };
  if (code === 'BLOCKED') return { text: 'the address points to a private network, which is not allowed', certificate: false };
  if (/timeout|abort/i.test(`${e.message} ${code}`)) return { text: 'it did not answer in time', certificate: false };
  return { text: e.message ?? 'the request failed', certificate: false };
}

export async function runTrackingCheck(args: {
  site: SiteToCheck;
  /** Our collector's public base URL, for the expected DNS target. */
  publicUrl: string;
  deps: CheckDeps;
  now?: () => Date;
}): Promise<CheckResult> {
  const { site, deps } = args;
  const now = args.now ?? (() => new Date());
  const checks: CheckItem[] = [];
  const add = (c: CheckItem) => checks.push(c);

  const host = site.trackingHost;
  const scheme = isLocalName(host) ? 'http' : 'https';
  const base = `${scheme}://${host}`;
  const target = new URL(args.publicUrl).hostname;
  const origin = site.origins[0];

  // 1. DNS
  if (isLocalName(host)) {
    add({ id: 'dns', label: 'DNS record', status: 'pass', detail: 'A local test name: it resolves on this machine, no DNS record is needed.' });
  } else {
    const name = hostOnly(host);
    let cnames: string[] = [];
    try {
      cnames = await deps.resolveCname(name);
    } catch {
      cnames = [];
    }
    if (cnames.some((c) => c.toLowerCase().replace(/\.$/, '') === target.toLowerCase())) {
      add({ id: 'dns', label: 'DNS record', status: 'pass', detail: `${name} points to ${target}.` });
    } else if (cnames.length > 0) {
      add({
        id: 'dns', label: 'DNS record', status: 'fail',
        detail: `${name} points to ${cnames[0]}, not to ${target}.`,
        fix: `Change the record for ${name} so it is a CNAME to ${target}. A name can have only one CNAME and no other records.`,
      });
    } else {
      // No CNAME: maybe the DNS provider flattens it to addresses. Accept if the addresses match ours.
      let theirs: string[] = [];
      let ours: string[] = [];
      try {
        [theirs, ours] = await Promise.all([deps.lookupAddresses(name), deps.lookupAddresses(target)]);
      } catch {
        theirs = [];
      }
      if (theirs.length > 0 && theirs.some((a) => ours.includes(a))) {
        add({ id: 'dns', label: 'DNS record', status: 'pass', detail: `${name} resolves to the same addresses as ${target} (the DNS provider flattens the CNAME).` });
      } else {
        add({
          id: 'dns', label: 'DNS record', status: 'fail',
          detail: theirs.length ? `${name} resolves, but not to our servers.` : `${name} does not resolve yet.`,
          fix: `Add a CNAME record named ${name.split('.')[0]} (full name ${name}) pointing to ${target}. New records can take from a few minutes to a few hours to appear. If the domain is on Cloudflare, set the record to "DNS only".`,
        });
      }
    }
  }

  // 2. HTTPS and routing: does the address reach our collector, and does it recognise itself as this brand's address?
  let reachable = false;
  try {
    const r = await deps.request(`${base}/trackcheck?key=${encodeURIComponent(site.key)}`);
    let body: { ok?: boolean; hostMatches?: boolean; siteKnown?: boolean; secure?: boolean } = {};
    try {
      body = JSON.parse(r.body);
    } catch {
      /* not our collector */
    }
    if (r.status >= 300 && r.status < 400) {
      add({ id: 'https', label: scheme === 'https' ? 'HTTPS and routing' : 'Routing', status: 'fail', detail: `The address redirects (${r.status}).`, fix: 'The address must answer directly, without redirecting. If the DNS provider or a CDN redirects it, turn that off for this name.' });
    } else if (r.status !== 200 || body.ok !== true) {
      add({ id: 'https', label: scheme === 'https' ? 'HTTPS and routing' : 'Routing', status: 'fail', detail: `The address answered with ${r.status} but not from our collector.`, fix: `Make sure the DNS record points to ${target} and that this name is set up on our server.` });
    } else if (body.siteKnown !== true) {
      add({ id: 'https', label: 'HTTPS and routing', status: 'fail', detail: 'Our collector answered, but does not know this site key.', fix: 'Check the site key in the script tag.' });
    } else if (body.hostMatches !== true) {
      add({ id: 'https', label: 'HTTPS and routing', status: 'fail', detail: 'Our collector answered, but it does not recognise this address as the brand\'s tracking address.', fix: 'The tracking address saved for this site key must be exactly this name.' });
    } else {
      reachable = true;
      add({ id: 'https', label: scheme === 'https' ? 'HTTPS and routing' : 'Routing', status: 'pass', detail: scheme === 'https' ? 'The address answers over HTTPS with a valid certificate, and reaches our collector.' : 'The address reaches our collector.' });
    }
  } catch (err) {
    const d = describeNetworkError(err);
    add({
      id: 'https', label: 'HTTPS and routing', status: 'fail',
      detail: `Could not reach ${base}: ${d.text}.`,
      fix: d.certificate
        ? `Our server does not have a valid certificate for ${hostOnly(host)} yet. This is set up on our side when the name is added; the brand does not need to do anything more.`
        : 'Check the DNS record first. If it is correct, the address may not be set up on our server yet.',
    });
  }

  const skipIfUnreachable = (id: CheckItem['id'], label: string): boolean => {
    if (reachable) return false;
    add({ id, label, status: 'skip', detail: 'Skipped until the address can be reached.' });
    return true;
  };

  // 3. The script file
  if (!skipIfUnreachable('script', 'Script file')) {
    try {
      const r = await deps.request(`${base}/tracker.js`);
      const type = String(first(r.headers['content-type']) ?? '');
      add(
        r.status === 200 && /javascript/.test(type) && r.body.length > 500
          ? { id: 'script', label: 'Script file', status: 'pass', detail: `${base}/tracker.js loads (${Math.round(r.body.length / 100) / 10} KB).` }
          : { id: 'script', label: 'Script file', status: 'fail', detail: `${base}/tracker.js answered ${r.status} ${type}.`, fix: 'Our collector must serve the script at this address.' },
      );
    } catch (err) {
      add({ id: 'script', label: 'Script file', status: 'fail', detail: `Could not load the script: ${describeNetworkError(err).text}.` });
    }
  }

  // One real test click, sent the way the brand's script sends it. It answers two questions: may the page talk to this
  // address (the permission headers on the real answer, not just on the browser's preliminary question), and is the
  // first-party cookie set.
  let post: HttpReply | undefined;
  let postError: unknown;
  if (reachable) {
    try {
      post = await deps.request(`${base}/touch`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ key: site.key, consent: true, touch: { clickedAt: now().getTime(), gclid: 'setup-check' } }),
      });
    } catch (err) {
      postError = err;
    }
  }

  // 4. Cross-site permission: may the brand's pages talk to this address with cookies?
  if (!skipIfUnreachable('cors', 'Permission for the website')) {
    if (!origin) {
      add({ id: 'cors', label: 'Permission for the website', status: 'skip', detail: 'No website address is saved for this site key, so there is nothing to test.', fix: 'Add the brand\'s website address to the site key.' });
    } else {
      try {
        const r = await deps.request(`${base}/touch`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
        const csv = (v: string | string[] | undefined) => String(first(v) ?? '').toLowerCase().split(',').map((x) => x.trim());
        const allows = (h: Record<string, string | string[] | undefined>) => first(h['access-control-allow-origin']) === origin && first(h['access-control-allow-credentials']) === 'true';
        const preflightOk = r.status >= 200 && r.status < 300 && allows(r.headers) && csv(r.headers['access-control-allow-methods']).includes('post') && csv(r.headers['access-control-allow-headers']).includes('content-type');
        if (!preflightOk) {
          add({ id: 'cors', label: 'Permission for the website', status: 'fail', detail: `${origin} was not given permission (answer ${r.status}).`, fix: 'Something in front of our collector (a CDN or proxy) may be removing the permission headers.' });
        } else if (postError) {
          add({ id: 'cors', label: 'Permission for the website', status: 'fail', detail: describeNetworkError(postError).text });
        } else if (!post || !allows(post.headers)) {
          add({ id: 'cors', label: 'Permission for the website', status: 'fail', detail: `The browser's preliminary question was answered, but the real request from ${origin} came back without permission, so the browser would discard it.`, fix: 'Something in front of our collector (a CDN or proxy) is removing the permission headers from the real answer.' });
        } else {
          add({ id: 'cors', label: 'Permission for the website', status: 'pass', detail: `${origin} is allowed to send data (with cookies) to this address.` });
        }
      } catch (err) {
        add({ id: 'cors', label: 'Permission for the website', status: 'fail', detail: describeNetworkError(err).text });
      }
    }
  }

  // 5. The first-party cookie: does the collector set it on this address? (A test click; nothing is stored on our side.)
  if (!skipIfUnreachable('cookie', 'First-party cookie')) {
    try {
      if (postError) throw postError;
      const r = post!;
      const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
      const ours = cookies.find((c) => c.startsWith(`${cookieName(site.key)}=`));
      let reason = '';
      try {
        reason = (JSON.parse(r.body) as { reason?: string }).reason ?? '';
      } catch {
        /* ignore */
      }
      if (ours && /HttpOnly/i.test(ours) && (scheme === 'http' || /Secure/i.test(ours))) {
        add({ id: 'cookie', label: 'First-party cookie', status: 'pass', detail: 'The collector sets the first-party cookie on this address (HttpOnly' + (scheme === 'https' ? ', Secure' : '') + ').' });
      } else if (r.status === 403) {
        add({ id: 'cookie', label: 'First-party cookie', status: 'fail', detail: 'The collector refused the test because the website address is not allowed for this site key.', fix: 'Check the allowed website addresses on the site key.' });
      } else if (reason === 'not_first_party_host') {
        add({ id: 'cookie', label: 'First-party cookie', status: 'fail', detail: 'The collector does not treat this as the brand\'s tracking address, so it set no cookie.', fix: 'The tracking address saved for this site key must be exactly this name.' });
      } else if (ours && scheme === 'https' && !/Secure/i.test(ours)) {
        add({ id: 'cookie', label: 'First-party cookie', status: 'fail', detail: 'The cookie was set without the Secure flag.', fix: 'The proxy in front of our collector must pass on that the connection is HTTPS (the X-Forwarded-Proto header).' });
      } else {
        add({ id: 'cookie', label: 'First-party cookie', status: 'fail', detail: `No cookie was set (answer ${r.status}${reason ? `, ${reason}` : ''}).` });
      }
    } catch (err) {
      add({ id: 'cookie', label: 'First-party cookie', status: 'fail', detail: describeNetworkError(err).text });
    }
  }

  // 6. Is the tag on the brand's website? Looks in the page's HTML (a tag added later by a script, such as Google Tag Manager, is not visible here).
  if (site.origins.length === 0) {
    add({ id: 'tag', label: 'Script tag on the website', status: 'skip', detail: 'No website address is saved for this site key.', fix: 'Add the brand\'s website address to the site key.' });
  } else {
    const found: string[] = [];
    const notFound: string[] = [];
    const unreadable: string[] = [];
    const wrongAddress: string[] = [];
    for (const o of site.origins.slice(0, 3)) {
      try {
        let url = `${o}/`;
        let html = '';
        for (let hop = 0; hop < 4; hop++) {
          const r = await deps.request(url, { headers: { accept: 'text/html', 'user-agent': 'ConversionsSetupCheck/1.0' } });
          const loc = first(r.headers.location);
          if (r.status >= 300 && r.status < 400 && loc) {
            url = new URL(loc, url).toString();
            continue;
          }
          if (r.status !== 200) throw Object.assign(new Error(`answered ${r.status}`), { code: 'STATUS' });
          html = r.body;
          break;
        }
        const tag = findScriptTag(html, site.key);
        if (!tag) notFound.push(o);
        else {
          // The tag must also send its data to the brand's tracking address, or the first-party cookie is never used.
          const sentTo = endpointHost(tag);
          if (sentTo === site.trackingHost.toLowerCase()) found.push(o);
          else wrongAddress.push(`${o} (its tag sends data to ${sentTo ?? 'no address'})`);
        }
      } catch (err) {
        unreadable.push(`${o} (${describeNetworkError(err).text})`);
      }
    }
    if (wrongAddress.length) {
      add({
        id: 'tag', label: 'Script tag on the website', status: 'fail',
        detail: `The script tag is on the website, but not set to use ${site.trackingHost}: ${wrongAddress.join('; ')}.`,
        fix: 'Replace the tag on the site with the current one from “Install script”, so the data goes to the brand\'s own address.',
      });
    } else if (found.length === site.origins.slice(0, 3).length) {
      add({ id: 'tag', label: 'Script tag on the website', status: 'pass', detail: `The script tag with this site key is on ${found.join(', ')}.` });
    } else {
      const parts = [
        found.length ? `Found on ${found.join(', ')}.` : '',
        notFound.length ? `Not found in the page source of ${notFound.join(', ')}.` : '',
        unreadable.length ? `Could not read ${unreadable.join('; ')}.` : '',
      ].filter(Boolean);
      add({
        id: 'tag', label: 'Script tag on the website', status: 'warn', detail: parts.join(' '),
        fix: 'Paste the script tag into the site\'s pages (before </head>). If it is loaded through Google Tag Manager or a similar tool, this check cannot see it: open the site and, in the browser console, check that typeof window.datahash is "object" (and that the browser loaded tracker.js from the tracking address).',
      });
    }
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');
const attribute = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};

/** The <script> tag for this site key, if one really is in the page (a mention of the key in text or a comment is not enough). */
export function findScriptTag(html: string, key: string): string | null {
  for (const m of withoutComments(html).matchAll(/<script\b[^>]*>/gi)) if (attribute(m[0], 'data-key') === key) return m[0];
  return null;
}

/** The host a tag sends its data to (its data-endpoint), or undefined if it has none. */
function endpointHost(tag: string): string | undefined {
  const raw = attribute(tag, 'data-endpoint');
  if (!raw) return undefined;
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** What `GET /trackcheck` answers: just enough for the check to see it reached the right place. No data about visitors. */
export function trackCheckBody(args: { siteKnown: boolean; hostMatches: boolean; secure: boolean }) {
  return { ok: true, ...args };
}
