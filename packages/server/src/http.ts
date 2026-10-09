import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { handleIdentify, handleWithdraw, type HandlerDeps, type HandlerResponse } from './identify';
import { handleTouch } from './touch';
import { trackCheckBody } from './tracking-check';
import { onTrackingHost } from './identify';
import { handleWebhook, type WebhookDeps } from './webhook';
import { handleAdmin, type AdminDeps } from './admin';
import { clientIp, FailureLimiter, RateLimiter } from './rate-limit';

const MAX_BODY = 64 * 1024;
const MAX_ADMIN_BODY = 2 * 1024 * 1024; // CSV imports

function readBody(req: IncomingMessage, maxBytes = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, origin?: string, setCookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) {
    // The browser sends cookies with these calls, which is only allowed with an exact origin and this header.
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers.vary = 'Origin';
  }
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** Is the connection HTTPS, directly or through a proxy that says so? Decides whether the cookie is marked Secure. */
const isSecure = (req: IncomingMessage) =>
  (req.socket as { encrypted?: boolean }).encrypted === true || req.headers['x-forwarded-proto'] === 'https';

const reply = (res: ServerResponse, r: HandlerResponse, origin: string | undefined) =>
  send(res, r.status, r.body, r.status < 400 ? origin : undefined, r.setCookie);

export interface ServerOptions extends HandlerDeps {
  /** Path to the built tracker.js, served at /tracker.js (handy for local testing). */
  trackerFile?: string;
  /** CRM / system webhooks at /webhooks/{tenantId}/{zoho|generic}. */
  webhook?: WebhookDeps;
  /** Operator admin API at /admin/api/* (needs ADMIN_TOKEN). */
  admin?: AdminDeps;
  /** Folder with the built admin UI (index.html, app.js, app.css), served at /admin. */
  adminUiDir?: string;
  /** Called by a scheduler (POST /internal/dispatch with x-internal-token) to send everything that is due. */
  internal?: { token: string; dispatchAll: () => Promise<unknown> };
  /** Slows down guessing of the admin and scheduler tokens. A default one is used if not given. */
  limiter?: FailureLimiter;
  /** Request budgets per address per minute for the public endpoints. Defaults: 300 for the website script, 1200 for CRM webhooks. */
  publicLimits?: { browserPerMin?: number; webhookPerMin?: number };
  /** How many proxies of ours sit in front (for the client's address in X-Forwarded-For). 1 = Cloud Run directly. */
  trustedProxyHops?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

const sameToken = (a: string | undefined, b: string) =>
  Boolean(a && b) && timingSafeEqual(createHash('sha256').update(a!).digest(), createHash('sha256').update(b).digest());

const tooManyAttempts = (res: ServerResponse, seconds: number) => {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(seconds), 'cache-control': 'no-store' });
  const minutes = Math.ceil(seconds / 60);
  res.end(JSON.stringify({ error: 'too_many_attempts', message: `Too many wrong tokens from this address. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` }));
};

export function createHttpServer(options: ServerOptions): Server {
  const limiter = options.limiter ?? new FailureLimiter();
  // The website script and CRMs call these without any login, so each address gets a generous budget, and an address
  // that keeps sending wrong webhook secrets is paused for a few minutes (the secrets are unguessable; this saves lookups).
  const browserBudget = new RateLimiter({ limit: options.publicLimits?.browserPerMin ?? 300 });
  const webhookBudget = new RateLimiter({ limit: options.publicLimits?.webhookPerMin ?? 1200 });
  const webhookFailures = new FailureLimiter({ maxFailures: 30, lockMs: 5 * 60_000 });
  const overBudget = (res: ServerResponse, seconds: number) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(seconds), 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'rate_limited' }));
  };
  return createServer(async (req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}),
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        });
        return res.end();
      }
      if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url === '/tracker.js' && options.trackerFile) {
        const js = await readFile(options.trackerFile);
        res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache' });
        return res.end(js);
      }
      if (url === '/identify' || url === '/consent' || url === '/touch' || url === '/trackcheck') {
        const wait = browserBudget.take(clientIp(req, options.trustedProxyHops));
        if (wait > 0) return overBudget(res, wait);
      }
      if (req.method === 'POST' && url === '/identify') {
        const raw = await readBody(req);
        const result = await handleIdentify(
          { body: raw, origin, host: req.headers.host, cookieHeader: req.headers.cookie },
          options,
        );
        // Only echo CORS for the origin that was accepted.
        return reply(res, result, origin);
      }
      if (req.method === 'POST' && url === '/consent') {
        const raw = await readBody(req);
        return reply(res, await handleWithdraw({ body: raw, origin, host: req.headers.host, secure: isSecure(req) }, options), origin);
      }
      if (req.method === 'GET' && url === '/trackcheck') {
        // Used by "Check setup": says whether a request reached us on the brand's tracking address. No visitor data.
        const key = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? '';
        const site = await options.findSite(key);
        return send(res, 200, trackCheckBody({ siteKnown: Boolean(site), hostMatches: Boolean(site && onTrackingHost(site, req.headers.host)), secure: isSecure(req) }));
      }
      if ((req.method === 'POST' || req.method === 'GET') && url === '/touch') {
        const touchInput = {
          method: req.method,
          origin,
          host: req.headers.host,
          cookieHeader: req.headers.cookie,
          secure: isSecure(req),
        };
        if (req.method === 'GET') {
          const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
          return reply(res, await handleTouch({ ...touchInput, query }, options), origin);
        }
        return reply(res, await handleTouch({ ...touchInput, body: await readBody(req) }, options), origin);
      }
      if (url?.startsWith('/admin/api/') && options.admin) {
        const who = `admin:${clientIp(req, options.trustedProxyHops)}`;
        const wait = limiter.retryAfterSec(who);
        if (wait > 0) return tooManyAttempts(res, wait);
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        const auth = req.headers.authorization;
        let body: unknown = undefined;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          const raw = await readBody(req, MAX_ADMIN_BODY);
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            return send(res, 400, { error: 'invalid_json' });
          }
        }
        const result = await handleAdmin(
          {
            method: req.method ?? 'GET',
            path: parsed.pathname.slice('/admin/api'.length),
            query: parsed.searchParams,
            body,
            token: auth?.startsWith('Bearer ') ? auth.slice(7) : undefined,
          },
          options.admin,
        );
        // The token is checked first, so a 401 is always a wrong token and anything else means it was right.
        if (result.status === 401) limiter.fail(who);
        else limiter.succeed(who);
        res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(result.body));
      }
      if (req.method === 'GET' && (url === '/admin' || url?.startsWith('/admin/')) && options.adminUiDir) {
        const rel = url === '/admin' || url === '/admin/' ? 'index.html' : normalize(url!.slice('/admin/'.length));
        if (rel.startsWith('..')) return send(res, 400, { error: 'bad_path' });
        try {
          const file = await readFile(join(options.adminUiDir, rel));
          res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
          return res.end(file);
        } catch {
          return send(res, 404, { error: 'not_found' });
        }
      }
      if (req.method === 'POST' && url === '/internal/dispatch' && options.internal) {
        const who = `internal:${clientIp(req, options.trustedProxyHops)}`;
        const wait = limiter.retryAfterSec(who);
        if (wait > 0) return tooManyAttempts(res, wait);
        const given = req.headers['x-internal-token'];
        if (!sameToken(typeof given === 'string' ? given : undefined, options.internal.token)) {
          limiter.fail(who);
          return send(res, 401, { error: 'unauthorized' });
        }
        limiter.succeed(who);
        return send(res, 200, await options.internal.dispatchAll());
      }
      const hook = req.method === 'POST' ? /^\/webhooks\/([^/]+)\/([^/]+)$/.exec(url ?? '') : null;
      if (hook && options.webhook) {
        const who = clientIp(req, options.trustedProxyHops);
        const wait = webhookFailures.retryAfterSec(who) || webhookBudget.take(who);
        if (wait > 0) return overBudget(res, wait);
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        const header = req.headers['x-webhook-secret'];
        const secret = (typeof header === 'string' ? header : undefined) ?? parsed.searchParams.get('secret') ?? undefined;
        const result = await handleWebhook(
          {
            tenantId: decodeURIComponent(hook[1]!),
            source: hook[2]!,
            secret,
            body: await readBody(req),
            contentType: req.headers['content-type'],
          },
          options.webhook,
        );
        if (result.status === 401) webhookFailures.fail(who);
        else webhookFailures.succeed(who);
        return send(res, result.status, result.body);
      }
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'error';
      return send(res, message === 'body_too_large' ? 413 : 500, { error: message === 'body_too_large' ? message : 'internal_error' });
    }
  });
}
