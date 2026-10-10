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

// ---- Extra customer details (name, place, customer ID) ----------------------------------------------------------
// Each one raises the share of sales an ad platform can match to a person. VERIFY every rule below against the
// platforms' current "customer information parameters" / "format user data" pages before relying on a match rate.

const clean = (raw: string | null | undefined): string | null => {
  const s = (raw ?? '').normalize('NFKC').trim().toLowerCase();
  return s || null;
};

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

/** Lowercase, no punctuation or digits, single spaces. Shared by Meta and Google (both say "no punctuation"). */
function plainName(raw: string | null | undefined, drop?: { titles?: boolean; suffixes?: boolean }): string | null {
  const stripped = clean(raw)?.replace(/[\p{P}\p{S}\d]/gu, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return null;
  const words = stripped.split(' ');
  // Only titles/suffixes written as separate words are dropped ("Mrs. Shah", "Shah Jr."), and never the last word left.
  while (drop?.titles && words.length > 1 && TITLES.has(words[0]!)) words.shift();
  while (drop?.suffixes && words.length > 1 && SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(' ') || null;
}

/** Meta: lowercase, no punctuation. A multi-word name keeps single spaces. */
export function hashNameForMeta(raw: string | null | undefined): string | null {
  const s = plainName(raw);
  return s ? sha256Hex(s) : null;
}

/** Google: lowercase, no punctuation, no title ("Mrs.") in a first name and no suffix ("Jr.") in a last name. */
export function hashNameForGoogle(raw: string | null | undefined, part: 'given' | 'family' = 'given'): string | null {
  const s = plainName(raw, part === 'given' ? { titles: true } : { suffixes: true });
  return s ? sha256Hex(s) : null;
}

/** Meta city and state: lowercase, letters and digits only (no spaces or punctuation). */
export function hashPlaceForMeta(raw: string | null | undefined): string | null {
  const s = clean(raw)?.replace(/[^\p{L}\p{N}]/gu, '');
  return s ? sha256Hex(s) : null;
}

/** Postal code as the platforms want it written: no spaces or dashes. Meta hashes it lowercase; Google takes it plain. */
export function normalizePostalCode(raw: string | null | undefined): string | null {
  const s = clean(raw)?.replace(/[\s-]/g, '');
  return s && s.length <= 12 ? s : null;
}

export function hashPostalCodeForMeta(raw: string | null | undefined): string | null {
  const s = normalizePostalCode(raw);
  return s ? sha256Hex(s) : null;
}

let regionByName: Map<string, string> | undefined;
/** Two-letter country code (upper case) from a code ("in") or an English name ("India"); null if not recognised. */
export function normalizeCountry(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (!regionByName) {
    regionByName = new Map();
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const name = names.of(code);
          if (name && name !== code) regionByName.set(name.toLowerCase(), code);
        }
      }
    } catch {
      /* no region names available: only two-letter codes are understood */
    }
  }
  return regionByName.get(s.toLowerCase()) ?? null;
}

/** Meta wants the country as a lowercase two-letter code, hashed. */
export function hashCountryForMeta(code: string | null | undefined): string | null {
  return code && /^[A-Za-z]{2}$/.test(code) ? sha256Hex(code.toLowerCase()) : null;
}

/** The brand's own customer ID (the CRM contact), hashed. Case matters, so it is only trimmed. */
export function hashExternalId(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  return s && s.length <= 128 ? sha256Hex(s) : null;
}

/** Meta's browser ID cookie (`_fbp`): sent exactly as it is. */
export function normalizeFbp(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  return /^fb\.\d\.\d{10,13}\.\d{1,20}$/.test(s) ? s : null;
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
