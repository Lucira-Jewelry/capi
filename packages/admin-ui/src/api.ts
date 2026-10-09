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

export async function api<T = unknown>(method: string, path: string, body?: unknown, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? getToken();
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (res.status === 401 && !tokenOverride) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? friendly(data.error) ?? `Request failed (${res.status})`);
  return data as T;
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'Wrong or missing admin token.',
  invalid_dataset_id: 'The dataset ID must contain digits.',
  invalid_customer_id: 'The Google Ads customer ID looks too short (it has 10 digits).',
  invalid_conversion_action_id: 'The conversion action ID must contain digits.',
  secret_required: 'A token is required the first time you connect.',
  not_resendable: 'Only failed, retrying or sent deliveries can be resent.',
  unknown_tenant: 'That brand no longer exists.',
};
const friendly = (code?: string) => (code ? MESSAGES[code] : undefined);
