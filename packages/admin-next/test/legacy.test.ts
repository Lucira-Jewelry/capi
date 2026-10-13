import { describe, expect, it } from 'vitest';
import { legacyTarget } from '@/lib/legacy';

describe('old console addresses', () => {
  it('open the page that replaced them', () => {
    expect(legacyTarget('#/brand/acme-1/sales')).toBe('/brand/?id=acme-1&tab=sales');
    expect(legacyTarget('#/brand/acme-1/connections')).toBe('/brand/?id=acme-1&tab=connections');
    expect(legacyTarget('#/brand/acme-1/overview')).toBe('/brand/?id=acme-1&tab=overview');
  });

  it('a brand with no tab, or an unknown one, opens its overview', () => {
    expect(legacyTarget('#/brand/acme-1')).toBe('/brand/?id=acme-1&tab=overview');
    expect(legacyTarget('#/brand/acme-1/nonsense')).toBe('/brand/?id=acme-1&tab=overview');
  });

  it('the old import address lands on Sales, where Import is now a button', () => {
    expect(legacyTarget('#/brand/acme-1/import')).toBe('/brand/?id=acme-1&tab=sales');
  });

  it('keeps unusual ids intact, and leaves anything else alone', () => {
    expect(legacyTarget('#/brand/a%20b%26c/crm')).toBe('/brand/?id=a%20b%26c&tab=crm');
    expect(legacyTarget('#/brand/%E0%A4%A/crm')).toBeNull(); // not decodable
    expect(legacyTarget('')).toBeNull();
    expect(legacyTarget('#/')).toBeNull();
    expect(legacyTarget('#something-else')).toBeNull();
  });
});
