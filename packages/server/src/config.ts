import { existsSync } from 'node:fs';

/** Tokens that are known to be placeholders. */
const WEAK_TOKENS = new Set(['dev-admin-token', 'admin', 'password', 'changeme', 'secret', 'test', 'token']);
const DEV_SECRETS_KEY = 'ZGV2LW9ubHktc2VjcmV0cy1rZXktMzItYnl0ZXMhISE=';

/**
 * What is wrong with the settings for a real deployment (NODE_ENV=production). An empty list means they are safe to
 * start with. Every problem is listed at once so one failed start tells you everything to fix.
 *
 * Development and tests do not go through this: the local stack uses the emulator and a throwaway key on purpose.
 */
export function productionProblems(env: Record<string, string | undefined>, fileExists: (path: string) => boolean = existsSync): string[] {
  const problems: string[] = [];
  const v = (name: string) => env[name]?.trim() || undefined;

  if (v('FIRESTORE_EMULATOR_HOST')) problems.push('FIRESTORE_EMULATOR_HOST is set: production must use the real Firestore, not the emulator.');
  if (!v('GOOGLE_CLOUD_PROJECT')) problems.push('GOOGLE_CLOUD_PROJECT is not set: say which project\'s Firestore to use (otherwise a default development name would be used).');

  const key = v('SECRETS_KEY');
  if (!key) problems.push('SECRETS_KEY is not set (32 random bytes, base64). Keep it the same on every deployment, or saved ad-account tokens become unreadable.');
  else if (key === DEV_SECRETS_KEY) problems.push('SECRETS_KEY is the development key from the repository: generate a real one.');
  else if (Buffer.from(key, 'base64').length !== 32) problems.push('SECRETS_KEY must be 32 bytes encoded as base64.');

  const admin = v('ADMIN_TOKEN');
  if (!admin) problems.push('ADMIN_TOKEN is not set.');
  else if (WEAK_TOKENS.has(admin.toLowerCase()) || admin.length < 32) problems.push('ADMIN_TOKEN must be a long random value (at least 32 characters) and not a placeholder.');

  const internal = v('INTERNAL_TOKEN');
  if (internal && (WEAK_TOKENS.has(internal.toLowerCase()) || internal.length < 32)) problems.push('INTERNAL_TOKEN must be a long random value (at least 32 characters).');
  if (internal && admin && internal === admin) problems.push('INTERNAL_TOKEN must differ from ADMIN_TOKEN.');

  const publicUrl = v('PUBLIC_URL');
  if (!publicUrl) problems.push('PUBLIC_URL is not set: it is the HTTPS address brands\' DNS records and script tags point to.');
  else {
    try {
      const u = new URL(publicUrl);
      if (u.protocol !== 'https:') problems.push('PUBLIC_URL must be an https:// address.');
      if (/^(localhost|127\.|\[::1\])/.test(u.hostname) || u.hostname.endsWith('.localhost')) problems.push('PUBLIC_URL must be the real public address, not localhost.');
    } catch {
      problems.push('PUBLIC_URL is not a valid address.');
    }
  }

  if (Number(v('DISPATCH_INTERVAL_SECONDS') ?? 0) > 0) problems.push('DISPATCH_INTERVAL_SECONDS is for local use only: in production a scheduler calls POST /internal/dispatch (an in-process timer stops when the instance scales to zero).');

  for (const [name, label] of [['TRACKER_FILE', 'the website script'], ['ADMIN_UI_DIR', 'the admin console']] as const) {
    const path = v(name);
    if (!path) problems.push(`${name} is not set (the built files for ${label}).`);
    else if (!fileExists(path)) problems.push(`${name} points to ${path}, which does not exist: the release is missing ${label}.`);
  }

  const hops = v('TRUSTED_PROXY_HOPS');
  if (hops !== undefined && !/^[0-9]$/.test(hops)) problems.push('TRUSTED_PROXY_HOPS must be a small whole number (1 for Cloud Run, 2 behind a load balancer).');
  return problems;
}

/** Throws a message listing everything wrong, or returns. */
export function assertProductionConfig(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV !== 'production') return;
  const problems = productionProblems(env);
  if (problems.length) throw new Error(`Refusing to start with unsafe production settings:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}
