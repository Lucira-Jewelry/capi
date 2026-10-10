// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeAttr, installSnippets, jsString } from '../src';

const base = { trackerUrl: 'https://track.brand.com/tracker.js', key: 'pk_abc123', endpoint: 'https://track.brand.com', consentMode: 'opt_in' as const };

/** Run the Tag Manager loader the way the browser would and return the script element it added. */
function runLoader(code: string): HTMLScriptElement {
  document.head.innerHTML = '';
  const body = /^<script>\n([\s\S]*)\n<\/script>$/.exec(code)?.[1];
  expect(body).toBeDefined();
  new Function(body!)();
  return document.head.querySelector('script') as HTMLScriptElement;
}

describe('direct script tag', () => {
  it('is the same tag as before for an opt-in brand (nothing about consent is written)', () => {
    expect(installSnippets(base).script).toBe('<script src="https://track.brand.com/tracker.js" data-key="pk_abc123" data-endpoint="https://track.brand.com" async></script>');
  });

  it('says opt-out only for an opt-out brand', () => {
    expect(installSnippets({ ...base, consentMode: 'opt_out' }).script).toContain(' data-consent-mode="opt_out" async>');
  });

  it('carries the country and the server-cookie setting only when they are set', () => {
    const s = installSnippets({ ...base, country: 'in', serverCookie: false }).script;
    expect(s).toContain('data-country="IN"');
    expect(s).toContain('data-server-cookie="false"');
    const plain = installSnippets({ ...base, serverCookie: true }).script;
    expect(plain).not.toContain('data-server-cookie');
    expect(plain).not.toContain('data-country');
    expect(installSnippets({ ...base, country: 'India' }).script).not.toContain('data-country'); // not a two-letter code
  });
});

describe('Google Tag Manager loader', () => {
  it('builds the script element, sets every attribute, then adds it to the page', () => {
    const el = runLoader(installSnippets({ ...base, consentMode: 'opt_out', country: 'IN', serverCookie: false }).gtm);
    expect(el.getAttribute('data-key')).toBe('pk_abc123');
    expect(el.getAttribute('data-endpoint')).toBe('https://track.brand.com');
    expect(el.getAttribute('data-consent-mode')).toBe('opt_out');
    expect(el.getAttribute('data-country')).toBe('IN');
    expect(el.getAttribute('data-server-cookie')).toBe('false');
    expect(el.src).toBe('https://track.brand.com/tracker.js');
    expect(el.async).toBe(true);
    expect(el.parentElement).toBe(document.head);
  });

  it('writes the same settings as the direct tag, for the same brand', () => {
    for (const cfg of [base, { ...base, consentMode: 'opt_out' as const }, { ...base, country: 'AE', serverCookie: false }]) {
      const { script, gtm } = installSnippets(cfg);
      const fromTag = new DOMParser().parseFromString(script, 'text/html').querySelector('script')!;
      const fromLoader = runLoader(gtm);
      const attrs = (e: Element) => Object.fromEntries(Array.from(e.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value]));
      expect(attrs(fromLoader)).toEqual(attrs(fromTag));
      expect(fromLoader.src).toBe(fromTag.src);
    }
  });

  it('the opt-in default is not written out, so the loader does not change it', () => {
    expect(runLoader(installSnippets(base).gtm).hasAttribute('data-consent-mode')).toBe(false);
  });
});

describe('escaping', () => {
  const hostile = `a"b'c<d>e&f\\g\nh</script><script>alert(1)</script>\u2028\u2029`;

  it('an attribute value cannot end the tag or add attributes', () => {
    const { script } = installSnippets({ ...base, key: hostile, endpoint: hostile, trackerUrl: hostile });
    const doc = new DOMParser().parseFromString(script, 'text/html');
    const scripts = doc.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.getAttribute('data-key')).toBe(hostile);
    expect(Array.from(scripts[0]!.attributes).map((a) => a.name).sort()).toEqual(['async', 'data-endpoint', 'data-key', 'src']);
    expect(escapeAttr(hostile)).not.toMatch(/["'<>]/);
  });

  it('a string in the loader cannot close the script or the string, and reads back exactly', () => {
    const { gtm } = installSnippets({ ...base, key: hostile, endpoint: hostile, trackerUrl: 'https://track.brand.com/tracker.js' });
    expect(gtm.match(/<\/script>/g)).toHaveLength(1); // only the real closing tag
    expect(gtm).not.toMatch(/\u2028|\u2029/);
    const el = runLoader(gtm);
    expect(el.getAttribute('data-key')).toBe(hostile);
    expect(el.getAttribute('data-endpoint')).toBe(hostile);
  });

  it('jsString survives being evaluated', () => {
    for (const v of ['plain', "it's", 'back\\slash', 'line\nbreak', '</script>', '\u2028']) {
      expect(new Function(`return ${jsString(v)}`)()).toBe(v);
      expect(jsString(v)).not.toContain('<');
    }
  });
});
