const TOKEN_KEY = 'console_token';

export const getToken = (): string | null => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setToken = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token then only lasts until the page is reloaded */
  }
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

const MESSAGES: Record<string, string> = {
  unauthorized: 'Wrong or missing admin token.',
  not_connected: 'Connect this platform first.',
  unknown_tenant: 'That brand no longer exists.',
};

export async function api<T = unknown>(method: string, path: string, body?: unknown, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? getToken();
  // Always the same address: the collector serves both. In `next dev`, next.config.mjs passes /admin/api on to it.
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (res.status === 401 && !tokenOverride) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? (data.error ? MESSAGES[data.error] : undefined) ?? `Request failed (${res.status})`);
  return data as T;
}
