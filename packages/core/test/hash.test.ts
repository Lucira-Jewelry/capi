import { describe, expect, it } from 'vitest';
import {
  hashEmailForGoogle,
  hashEmailForMeta,
  hashPhoneForGoogle,
  hashPhoneForMeta,
  identityKeyForEmail,
  identityKeyForPhone,
  normalizeEmail,
  normalizeEmailForGoogle,
  normalizePhone,
  sha256Hex,
} from '../src';

describe('sha256Hex', () => {
  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('normalizePhone (default country IN)', () => {
  it.each([
    ['+91 98765 43210', '+919876543210'],
    ['9876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['91-98765-43210', '+919876543210'],
    ['(+91) 98765 43210', '+919876543210'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it('keeps other countries when the code is given', () => {
    expect(normalizePhone('+1 415 555 2671')).toBe('+14155552671');
  });

  it.each([[''], [null], [undefined], ['12345'], ['not a phone']])('rejects %s', (raw) => {
    expect(normalizePhone(raw as string | null | undefined)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Priya.S@Example.COM ')).toBe('priya.s@example.com');
  });
  it('rejects invalid input', () => {
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
  it('google variant: gmail/googlemail lose dots and the +suffix; other domains are untouched', () => {
    expect(normalizeEmailForGoogle('Priya.S@gmail.com')).toBe('priyas@gmail.com');
    expect(normalizeEmailForGoogle('cloudy.sanfrancisco+shopping@gmail.com')).toBe('cloudysanfrancisco@gmail.com');
    expect(normalizeEmailForGoogle('a.b+c+d@googlemail.com')).toBe('ab@googlemail.com');
    expect(normalizeEmailForGoogle('user.name+NYC@Example.com')).toBe('user.name+nyc@example.com');
    expect(normalizeEmailForGoogle('+only@gmail.com')).toBeNull(); // nothing left before the plus
  });
  it('meta variant keeps dots and plus suffixes (only trim + lowercase)', () => {
    expect(hashEmailForMeta('Cloudy.SanFrancisco+Shopping@gmail.com')).toBe(sha256Hex('cloudy.sanfrancisco+shopping@gmail.com'));
  });
});

describe('platform hashes', () => {
  it('meta phone hash uses digits without the plus', () => {
    expect(hashPhoneForMeta('98765 43210')).toBe(sha256Hex('919876543210'));
  });
  it('google phone hash uses E.164 with the plus', () => {
    expect(hashPhoneForGoogle('98765 43210')).toBe(sha256Hex('+919876543210'));
  });
  it('same person from different formats gives the same hash', () => {
    expect(hashPhoneForMeta('+91 98765 43210')).toBe(hashPhoneForMeta('09876543210'));
  });
  it('email hashes', () => {
    expect(hashEmailForMeta('A@B.com')).toBe(sha256Hex('a@b.com'));
    expect(hashEmailForGoogle('a.b@gmail.com')).toBe(sha256Hex('ab@gmail.com'));
  });
  it('returns null for unusable input', () => {
    expect(hashPhoneForMeta('abc')).toBeNull();
    expect(hashEmailForMeta('abc')).toBeNull();
  });
});

describe('identity keys', () => {
  it('are stable across formats and distinct for phone vs email', () => {
    expect(identityKeyForPhone('98765 43210')).toBe(identityKeyForPhone('+919876543210'));
    expect(identityKeyForEmail('A@b.com')).toBe(identityKeyForEmail('a@b.com'));
    expect(identityKeyForPhone('9876543210')).not.toBe(identityKeyForEmail('a@b.com'));
  });
});
