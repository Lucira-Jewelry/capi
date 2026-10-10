import { describe, expect, it } from 'vitest';
import {
  hashCountryForMeta,
  hashExternalId,
  hashNameForGoogle,
  hashNameForMeta,
  hashPlaceForMeta,
  hashPostalCodeForMeta,
  normalizeCountry,
  normalizeFbp,
  normalizePostalCode,
  hashStateForMeta,
  stateCode,
  sha256Hex,
} from '../src';

describe('customer details for matching', () => {
  it('Meta names are lowercase with no punctuation', () => {
    expect(hashNameForMeta("  O'Brien-Smith ")).toBe(sha256Hex('obriensmith'));
    expect(hashNameForMeta('Priya')).toBe(sha256Hex('priya'));
    expect(hashNameForMeta('   ')).toBeNull();
    expect(hashNameForMeta('1234')).toBeNull();
  });

  it('Google names are lowercase with no punctuation, no title on a first name and no suffix on a last name', () => {
    expect(hashNameForGoogle(" O'Brien ")).toBe(sha256Hex('obrien'));
    expect(hashNameForGoogle('Mrs. Priya')).toBe(sha256Hex('priya'));
    expect(hashNameForGoogle('Shah Jr.', 'family')).toBe(sha256Hex('shah'));
    expect(hashNameForGoogle('Jr', 'family')).toBe(sha256Hex('jr'));
    expect(hashNameForGoogle('Shah Jr.', 'given')).toBe(sha256Hex('shah jr'));
  });

  it('city and state lose spaces and punctuation', () => {
    expect(hashPlaceForMeta('New Delhi')).toBe(sha256Hex('newdelhi'));
    expect(hashPlaceForMeta('St. Louis')).toBe(sha256Hex('stlouis'));
    expect(hashPlaceForMeta('')).toBeNull();
  });

  it('postal codes lose spaces and dashes', () => {
    expect(normalizePostalCode('411 001')).toBe('411001');
    expect(normalizePostalCode('SW1A 1AA')).toBe('sw1a1aa');
    expect(hashPostalCodeForMeta('411-001')).toBe(sha256Hex('411001'));
    expect(normalizePostalCode('x'.repeat(40))).toBeNull();
  });

  it('countries come from a code or an English name', () => {
    expect(normalizeCountry('in')).toBe('IN');
    expect(normalizeCountry('India')).toBe('IN');
    expect(normalizeCountry('united arab emirates')).toBe('AE');
    expect(normalizeCountry('Narnia')).toBeNull();
    expect(hashCountryForMeta('IN')).toBe(sha256Hex('in'));
    expect(hashCountryForMeta('India')).toBeNull();
  });

  it('state names become codes, and the Meta hash uses the lowercase code', () => {
    expect(stateCode('Maharashtra')).toBe('MH');
    expect(stateCode('  tamil nadu ')).toBe('TN');
    expect(stateCode('Jammu & Kashmir')).toBe('JK');
    expect(stateCode('mh')).toBe('MH');
    expect(stateCode('Texas')).toBe('TX');
    expect(stateCode('Georgia', 'IN')).toBeNull();
    expect(stateCode('zz')).toBeNull();
    expect(stateCode('Atlantis')).toBeNull();
    expect(hashStateForMeta('Maharashtra', 'IN')).toBe(sha256Hex('mh'));
    expect(hashStateForMeta('MH')).toBe(sha256Hex('mh'));
    expect(hashStateForMeta('Some Region')).toBe(sha256Hex('someregion'));
    expect(hashStateForMeta('')).toBeNull();
  });

  it('the customer ID keeps its case', () => {
    expect(hashExternalId(' Abc123 ')).toBe(sha256Hex('Abc123'));
    expect(hashExternalId('')).toBeNull();
  });

  it('only a well-formed fbp is accepted', () => {
    expect(normalizeFbp('fb.1.1700000000000.1234567890')).toBe('fb.1.1700000000000.1234567890');
    expect(normalizeFbp('fb.1.abc.123')).toBeNull();
    expect(normalizeFbp('<script>')).toBeNull();
    expect(normalizeFbp(undefined)).toBeNull();
  });
});
