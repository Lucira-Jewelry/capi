import { describe, expect, it } from 'vitest';
import { buildFbc, hasClickId, parseClickIds } from '../src';

describe('parseClickIds', () => {
  it('reads click IDs and UTMs from a URL', () => {
    const ids = parseClickIds('https://brand.example/rings?gclid=G123&fbclid=F456&utm_source=google&utm_campaign=diwali#top');
    expect(ids.gclid).toBe('G123');
    expect(ids.fbclid).toBe('F456');
    expect(ids.utm).toEqual({ utm_source: 'google', utm_campaign: 'diwali' });
  });

  it('accepts a bare query string and ctwa_clid / gbraid / wbraid', () => {
    const ids = parseClickIds('gbraid=B1&wbraid=W1&ctwa_clid=C1');
    expect(ids.gbraid).toBe('B1');
    expect(ids.wbraid).toBe('W1');
    expect(ids.ctwaClid).toBe('C1');
  });

  it('returns nothing for organic landings', () => {
    const ids = parseClickIds('https://brand.example/rings?ref=home');
    expect(hasClickId(ids)).toBe(false);
  });
});

describe('buildFbc', () => {
  it('uses the original click time', () => {
    expect(buildFbc('F456', 1759600000000)).toBe('fb.1.1759600000000.F456');
  });
});
