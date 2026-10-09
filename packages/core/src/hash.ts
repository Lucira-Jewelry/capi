import { createHash } from 'node:crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Phone to E.164 (+919876543210), or null if it is not a valid number. */
export function normalizePhone(raw: string | null | undefined, defaultCountry: CountryCode = 'IN'): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164 with leading +
}

/** Trim and lowercase. Returns null for anything that is clearly not an email. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/**
 * Google's rule (Data Manager API, "Format user data"): for gmail.com and googlemail.com remove every dot in the
 * local part AND the first plus sign with everything after it; other domains are left alone.
 * cloudy.sanfrancisco+shopping@gmail.com -> cloudysanfrancisco@gmail.com
 */
export function normalizeEmailForGoogle(raw: string | null | undefined): string | null {
  const email = normalizeEmail(raw);
  if (!email) return null;
  const [local, domain] = email.split('@') as [string, string];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const withoutSuffix = local.split('+')[0] ?? '';
    const cleaned = withoutSuffix.replace(/\./g, '');
    return cleaned ? `${cleaned}@${domain}` : null;
  }
  return email;
}

/** Meta wants digits only, country code included, no leading plus. VERIFY against Meta's docs. */
export function hashPhoneForMeta(raw: string | null | undefined, defaultCountry: CountryCode = 'IN'): string | null {
  const e164 = normalizePhone(raw, defaultCountry);
  return e164 ? sha256Hex(e164.slice(1)) : null;
}

/** Google wants E.164 including the plus. VERIFY against Google's docs. */
export function hashPhoneForGoogle(raw: string | null | undefined, defaultCountry: CountryCode = 'IN'): string | null {
  const e164 = normalizePhone(raw, defaultCountry);
  return e164 ? sha256Hex(e164) : null;
}

export function hashEmailForMeta(raw: string | null | undefined): string | null {
  const email = normalizeEmail(raw);
  return email ? sha256Hex(email) : null;
}

export function hashEmailForGoogle(raw: string | null | undefined): string | null {
  const email = normalizeEmailForGoogle(raw);
  return email ? sha256Hex(email) : null;
}

/**
 * Stable internal key used to look a person up in our store (identities/{key}).
 * Based on E.164 / lowercased email, so the same person resolves from any source.
 */
export function identityKeyForPhone(raw: string | null | undefined, defaultCountry: CountryCode = 'IN'): string | null {
  const e164 = normalizePhone(raw, defaultCountry);
  return e164 ? sha256Hex(`phone:${e164}`) : null;
}

export function identityKeyForEmail(raw: string | null | undefined): string | null {
  const email = normalizeEmail(raw);
  return email ? sha256Hex(`email:${email}`) : null;
}
