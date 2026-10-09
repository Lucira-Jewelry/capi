import { createSign } from 'node:crypto';
import { DATA_MANAGER_SCOPE } from './google-oauth';
import { timedFetch, type HttpOptions } from './types';

/** The fields we need from a Google service account key file (the JSON you download from Google Cloud). */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Read a key file's JSON text. Returns a short reason when it is not usable, never the key itself. */
export function parseServiceAccountKey(text: string): { ok: true; key: ServiceAccountKey } | { ok: false; error: string } {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'The service account key is not valid JSON.' };
  }
  const email = json.client_email;
  const pem = json.private_key;
  if (typeof email !== 'string' || !email.includes('@')) return { ok: false, error: 'The service account key has no client_email.' };
  if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) return { ok: false, error: 'The service account key has no private_key.' };
  const tokenUri = typeof json.token_uri === 'string' ? json.token_uri : undefined;
  return { ok: true, key: { client_email: email, private_key: pem, ...(tokenUri ? { token_uri: tokenUri } : {}) } };
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A signed assertion Google exchanges for an access token (RS256 JWT bearer grant). */
export function signServiceAccountJwt(key: ServiceAccountKey, nowMs: number, scope = DATA_MANAGER_SCOPE): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, scope, aud: key.token_uri ?? 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

const cache = new Map<string, { token: string; expiresAt: number }>();

export type ServiceAccountToken = { ok: true; token: string } | { ok: false; error: string; temporary: boolean };

/**
 * Access token for the product's own service account. One token serves every brand: the brand only has to have
 * given this account access (added its email as a user, or linked the manager account).
 */
export async function serviceAccountAccessToken(key: ServiceAccountKey, opts: HttpOptions & { now?: () => number } = {}): Promise<ServiceAccountToken> {
  const now = (opts.now ?? Date.now)();
  const cached = cache.get(key.client_email);
  if (cached && cached.expiresAt > now) return { ok: true, token: cached.token };

  let assertion: string;
  try {
    assertion = signServiceAccountJwt(key, now);
  } catch {
    return { ok: false, error: 'The service account private key could not be used to sign. Check GOOGLE_SERVICE_ACCOUNT_JSON.', temporary: false };
  }

  let res: Response;
  try {
    res = await timedFetch(
      key.token_uri ?? 'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      },
      opts,
    );
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : 'error'}`, temporary: true };
  }
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    // 400-403: Google refused our key (revoked, wrong project, clock far off): a platform problem, not the brand's.
    const refused = res.status === 400 || res.status === 401 || res.status === 403;
    return {
      ok: false,
      error: `google service account ${res.status}: ${json.error ?? 'error'}${json.error_description ? ` (${json.error_description})` : ''}`,
      temporary: !refused,
    };
  }
  cache.set(key.client_email, { token: json.access_token, expiresAt: now + ((json.expires_in ?? 3600) - 60) * 1000 });
  return { ok: true, token: json.access_token };
}

/** Drop the cached token, for example after Google answered 401. */
export function forgetServiceAccountToken(clientEmail: string) {
  cache.delete(clientEmail);
}

/** For tests. */
export function clearServiceAccountTokenCache() {
  cache.clear();
}
