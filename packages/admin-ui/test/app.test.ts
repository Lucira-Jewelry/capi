// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp } from '../src/app';
import { deferred, installBrowserShims, mockApi, tick } from './setup';

installBrowserShims();

const tenant = (id: string, name: string, status = 'active') => ({
  tenantId: id, name, status, consentPolicy: { mode: 'opt_in' }, allowedChannels: ['store'], destinations: ['meta'],
  defaultCountry: 'IN', retentionDays: 90, sources: {}, createdAt: '2026-10-01T00:00:00Z',
});
const brandView = (name = 'Brand One') => ({
  tenant: tenant('b1', name),
  siteKeys: [{ key: `pk_${'a'.repeat(24)}`, origins: ['https://www.brand.com'], snippet: '<script src="x"></script>' }],
  connections: [],
  webhooks: { zoho: 'https://c/webhooks/b1/zoho', generic: 'https://c/webhooks/b1/generic' },
});
const META = {
  channels: ['store', 'online', 'whatsapp', 'web_lead'], destinations: ['meta', 'google_ads'], countries: ['IN', 'US'],
  importColumns: ['eventId'], importTemplate: 'eventId\n', defaultZohoMapping: {}, google: { oauthConfigured: false },
};
const STATS = { sales: 7, matchedToPerson: 3, byChannel: {}, deliveries: {}, skipReasons: {}, processing: {}, withClickId: 2, contactOnly: 5 };

let app: { stop: () => void } | null = null;

function mount(hash: string) {
  document.body.innerHTML = '<div id="app"></div>';
  sessionStorage.setItem('console_token', 'good-token');
  location.hash = hash;
  app = startApp(document.getElementById('app')!);
}
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const content = () => q('.brand-content');
const settle = (ms = 40) => tick(ms);
const goto = async (hash: string, ms = 60) => {
  location.hash = hash;
  await settle(ms);
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  app?.stop();
  app = null;
  location.hash = '';
});

function standardApi(extra: Record<string, () => unknown> = {}) {
  return mockApi({
    'GET /me': () => ({ ok: true }),
    'GET /meta': () => META,
    'GET /tenants': () => ({ tenants: [tenant('b1', 'Brand One'), tenant('b2', 'Other Brand', 'suspended')] }),
    'GET /tenants/b1': () => brandView(),
    'GET /tenants/b1/stats': () => STATS,
    'GET /tenants/b1/sales': () => ({ sales: [] }),
    ...extra,
  });
}

describe('moving between tabs does not redraw the page', () => {
  it('keeps the top bar, the brand header and the tab bar; only the content below changes', async () => {
    standardApi();
    mount('#/brand/b1/overview');
    await settle(120);
    expect(content().textContent).toContain('Activity');

    const topbar = q('.topbar');
    const heading = q('h1');
    const tabs = q('.tabs');
    expect(heading.textContent).toBe('Brand One');

    await goto('#/brand/b1/sales');
    expect(q('.topbar')).toBe(topbar);
    expect(q('h1')).toBe(heading);
    expect(q('.tabs')).toBe(tabs);
    expect(content().textContent).toContain('Recent sales');

    await goto('#/brand/b1/settings');
    expect(q('.topbar')).toBe(topbar);
    expect(q('h1')).toBe(heading);
    expect(content().textContent).toContain('Brand name');
    expect(q('.tabs [aria-current="page"]').textContent).toBe('Settings');
  });

  it('does not ask the server for the brand again on a tab change', async () => {
    const { calls } = standardApi();
    mount('#/brand/b1/overview');
    await settle(120);
    const before = calls.filter((c) => c === 'GET /tenants/b1').length;
    await goto('#/brand/b1/sales');
    await goto('#/brand/b1/connections');
    expect(calls.filter((c) => c === 'GET /tenants/b1').length).toBe(before);
  });

  it('highlights the clicked tab at once, before its content has arrived', async () => {
    const slow = deferred<unknown>();
    standardApi({ 'GET /tenants/b1/sales': () => slow.promise });
    mount('#/brand/b1/overview');
    await settle(120);
    const salesTab = q<HTMLAnchorElement>('.tabs a[data-tab="sales"]');
    salesTab.click();
    expect(q('.tabs [aria-current="page"]').textContent).toBe('Sales'); // immediately
    expect(content().textContent).toContain('Activity'); // the old content is still there
    slow.resolve({ sales: [] });
    await settle(80);
    expect(content().textContent).toContain('Recent sales');
  });
});

describe('quick and slow loads', () => {
  it('a quick load swaps content with no blank screen and no skeleton in between', async () => {
    const hold = deferred<unknown>();
    standardApi({ 'GET /tenants/b1/sales': () => hold.promise });
    mount('#/brand/b1/overview');
    await settle(120);

    location.hash = '#/brand/b1/sales';
    await settle(60); // well under the moment after which a skeleton would appear
    expect(content().textContent).toContain('Activity'); // still the old content, not empty
    expect(content().querySelector('.skeleton')).toBeNull();

    hold.resolve({ sales: [] });
    await settle(60);
    expect(content().textContent).toContain('Recent sales');
    expect(content().querySelector('.skeleton')).toBeNull();
  });

  it('a slow load shows a skeleton after a moment, then the content', async () => {
    const hold = deferred<unknown>();
    standardApi({ 'GET /tenants/b1/sales': () => hold.promise });
    mount('#/brand/b1/overview');
    await settle(120);

    location.hash = '#/brand/b1/sales';
    await settle(300);
    expect(content().querySelector('.skeleton')).not.toBeNull();

    hold.resolve({ sales: [] });
    await settle(60);
    expect(content().querySelector('.skeleton')).toBeNull();
    expect(content().textContent).toContain('Recent sales');
  });

  it('an answer for a tab you already left is thrown away', async () => {
    const slowSales = deferred<unknown>();
    standardApi({ 'GET /tenants/b1/sales': () => slowSales.promise });
    mount('#/brand/b1/overview');
    await settle(120);

    await goto('#/brand/b1/sales', 20); // starts, does not finish
    await goto('#/brand/b1/settings', 80); // you moved on, and settings loads fine
    expect(content().textContent).toContain('Brand name');

    slowSales.resolve({ sales: [] });
    await settle(80);
    expect(content().textContent).toContain('Brand name'); // the late sales answer did not replace it
    expect(content().textContent).not.toContain('Recent sales');
    expect(q('.tabs [aria-current="page"]').textContent).toBe('Settings');
  });

  it('the first visit to a brand shows a skeleton in the frame, then the page', async () => {
    const hold = deferred<unknown>();
    standardApi({ 'GET /tenants/b1': () => hold.promise });
    mount('#/brand/b1/overview');
    await settle(300);
    expect(q('#view').querySelector('.skeleton')).not.toBeNull();
    expect(q('.topbar')).not.toBeNull(); // the top bar is already there while the page loads
    hold.resolve(brandView());
    await settle(120);
    expect(q('h1').textContent).toBe('Brand One');
  });
});

describe('saving redraws in place', () => {
  it('updates the header and the form without rebuilding the frame', async () => {
    let name = 'Brand One';
    const { calls } = mockApiWithPatch(() => name, (n) => (name = n));
    mount('#/brand/b1/settings');
    await settle(120);

    const topbar = q('.topbar');
    const heading = q('h1');
    const input = q<HTMLInputElement>('#st-name');
    input.value = 'Brand One Renamed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const save = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save settings')!;
    save.click();
    await settle(120);

    expect(calls).toContain('PATCH /tenants/b1');
    expect(q('.topbar')).toBe(topbar);
    expect(q('h1')).toBe(heading); // the same heading element, with new text
    expect(heading.textContent).toBe('Brand One Renamed');
    expect(q<HTMLInputElement>('#st-name').value).toBe('Brand One Renamed');
    expect(document.querySelector('.toast')?.textContent).toContain('Settings saved');
  });
});

/** Like standardApi, but the brand's name follows what was last saved. */
function mockApiWithPatch(get: () => string, set: (n: string) => void) {
  return mockApi({
    'GET /me': () => ({ ok: true }),
    'GET /meta': () => META,
    'GET /tenants': () => ({ tenants: [tenant('b1', get())] }),
    'GET /tenants/b1': () => brandView(get()),
    'GET /tenants/b1/stats': () => STATS,
    'PATCH /tenants/b1': (body: unknown) => {
      set((body as { name: string }).name);
      return brandView(get());
    },
  });
}

describe('the brands list', () => {
  it('lists brands, filters as you type, and opens one on click', async () => {
    standardApi();
    mount('#/');
    await settle(100);
    expect(document.title).toContain('Brands');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(q('[role="status"]').textContent).toBe('2 brands');

    const search = q<HTMLInputElement>('input[type="search"]');
    search.value = 'other';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(q('[role="status"]').textContent).toBe('1 of 2 brands');

    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    expect(q('#view').textContent).toContain('No brands match');
    (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Clear filters') as HTMLButtonElement).click();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);

    (document.querySelector('tbody tr') as HTMLElement).click();
    await settle(150);
    expect(location.hash).toBe('#/brand/b1/overview');
    expect(q('h1').textContent).toBe('Brand One');
  });

  it('a different page starts at the top, while a tab change keeps your place', async () => {
    standardApi();
    mount('#/brand/b1/overview');
    await settle(120);
    const scroll = window.scrollTo as unknown as ReturnType<typeof import('vitest').vi.fn>;
    scroll.mockClear();
    await goto('#/', 120);
    expect(scroll).toHaveBeenCalledWith(0, 0);

    await goto('#/brand/b1/sales', 150);
    scroll.mockClear();
    await goto('#/brand/b1/settings', 80); // same brand: not forced to the top (the tab bar is in view in jsdom, so no scroll at all)
    expect(scroll).not.toHaveBeenCalledWith(0, 0);
  });

  it('the tab title follows the page', async () => {
    standardApi();
    mount('#/brand/b1/sales');
    await settle(120);
    expect(document.title).toBe('Brand One · Sales · Conversions Console');
    await goto('#/brand/b1/settings');
    expect(document.title).toBe('Brand One · Settings · Conversions Console');
  });

  it('an unknown brand says so, with a way back', async () => {
    standardApi({ 'GET /tenants/ghost': () => ({ __status: 404, error: 'unknown_tenant' }) });
    mount('#/brand/ghost/overview');
    await settle(150);
    expect(q('#view').textContent).toContain('Brand not found');
    expect(q('#view a').getAttribute('href')).toBe('#/');
  });

  it('a server error shows a message and a Try again button', async () => {
    standardApi({ 'GET /tenants': () => ({ __status: 500, error: 'internal_error', message: 'The database is down' }) });
    mount('#/');
    await settle(100);
    expect(q('#view').textContent).toContain('The database is down');
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'Try again')).toBe(true);
  });
});

describe('signing in and out', () => {
  it('without a token the sign-in form appears, and a wrong token is explained in place', async () => {
    let good = false;
    mockApi({ 'GET /me': () => (good ? { ok: true } : { __status: 401, error: 'unauthorized' }), 'GET /meta': () => META, 'GET /tenants': () => ({ tenants: [tenant('b1', 'Brand One')] }) });
    document.body.innerHTML = '<div id="app"></div>';
    location.hash = '#/';
    app = startApp(document.getElementById('app')!);
    await settle(50);

    expect(q('.login')).not.toBeNull();
    expect(document.title).toContain('Sign in');
    expect(Array.from(document.querySelectorAll('.topbar button')).some((b) => b.textContent === 'Sign out' && !(b as HTMLElement).hidden)).toBe(false);
    expect(document.activeElement?.id).toBe('token');

    const token = q<HTMLInputElement>('#token');
    token.value = 'wrong';
    q<HTMLFormElement>('.login form').requestSubmit();
    await settle(60);
    expect(q('.login .alert').textContent).toBe('That token is not right.');
    expect(document.activeElement?.id).toBe('token'); // back in the box, ready to retype

    good = true;
    token.value = 'good-token';
    q<HTMLFormElement>('.login form').requestSubmit();
    await settle(150);
    expect(q('.login')).toBeNull();
    expect(q('#view').textContent).toContain('Brand One');
  });

  it('a token the server stops accepting signs you out with a message, not a broken page', async () => {
    standardApi({ 'GET /tenants': () => ({ __status: 401, error: 'unauthorized' }) });
    mount('#/');
    await settle(120);
    expect(q('.login')).not.toBeNull();
    expect(document.querySelector('.toast.bad')?.textContent).toContain('Signed out');
    expect(sessionStorage.getItem('console_token')).toBeNull();
  });

  it('Sign out returns to the form and forgets the token', async () => {
    standardApi();
    mount('#/');
    await settle(100);
    (Array.from(document.querySelectorAll('.topbar button')).find((b) => b.textContent === 'Sign out') as HTMLButtonElement).click();
    await settle(60);
    expect(q('.login')).not.toBeNull();
    expect(sessionStorage.getItem('console_token')).toBeNull();
  });
});

describe('theme', () => {
  it('the toggle switches the theme, remembers it, and swaps its icon', async () => {
    standardApi();
    mount('#/');
    await settle(100);
    const btn = q<HTMLButtonElement>('.topbar .icon-btn');
    const before = btn.innerHTML;
    document.documentElement.dataset.theme = 'light';
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('console_theme')).toBe('dark');
    expect(btn.innerHTML).not.toBe(before);
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('light');
    delete document.documentElement.dataset.theme;
  });
});
