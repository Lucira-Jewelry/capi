// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Win = { datahash?: unknown };

/** Load the browser entry as if `script` were the element the browser is running right now. */
async function runAs(script: HTMLScriptElement) {
  vi.resetModules();
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
  await import('../src/entry');
}

beforeEach(() => {
  delete (window as Win).datahash;
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => null });
});

describe('browser entry', () => {
  it('starts when the script element has its settings, however they were put there', async () => {
    // the way the Tag Manager loader builds it: createElement + setAttribute
    const viaLoader = document.createElement('script');
    viaLoader.setAttribute('data-key', 'pk_test');
    viaLoader.setAttribute('data-endpoint', 'https://track.brand.com');
    viaLoader.setAttribute('data-consent-mode', 'opt_out');
    await runAs(viaLoader);
    expect(typeof (window as Win).datahash).toBe('object');
    expect(typeof ((window as Win).datahash as { identify: unknown }).identify).toBe('function');
  });

  it('does nothing, and says nothing, when the settings are missing', async () => {
    const bare = document.createElement('script');
    bare.src = 'https://track.brand.com/tracker.js';
    await runAs(bare);
    expect((window as Win).datahash).toBeUndefined();
  });
});
