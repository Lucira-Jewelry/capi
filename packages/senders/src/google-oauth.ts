import { timedFetch, type HttpOptions } from './types';
/** The product's OAuth client (for the optional per-brand OAuth route). */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The one scope the Data Manager API needs. A refresh token granted for another scope (such as the old Google Ads one) is refused. */
export const DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';

/** The address to send a brand's Google user to, to grant access. `access_type=offline` + `prompt=consent` make Google issue a refresh token. */
export function googleAuthUrl(app: Pick<OAuthClient, 'clientId'>, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DATA_MANAGER_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Trade the code Google returned for a refresh token. */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  app: OAuthClient,
  opts: HttpOptions = {},
): Promise<{ ok: true; refreshToken: string; scope: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await timedFetch(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      },
      opts,
    );
  } catch (err) {
    return { ok: false, error: `network: ${err instanceof Error ? err.message : 'error'}` };
  }
  const json = (await res.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok) return { ok: false, error: `google oauth ${res.status}: ${json.error ?? 'error'}${json.error_description ? ` (${json.error_description})` : ''}` };
  if (!json.refresh_token) {
    return { ok: false, error: 'Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and try again.' };
  }
  if (!(json.scope ?? '').split(' ').includes(DATA_MANAGER_SCOPE)) {
    return { ok: false, error: `The token was granted without the Data Manager scope (${json.scope ?? 'none'}).` };
  }
  return { ok: true, refreshToken: json.refresh_token, scope: json.scope ?? '' };
}
