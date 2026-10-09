// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp } from '../src/app';
import { installBrowserShims, mockApi, tick } from './setup';

installBrowserShims();

const tenant = { tenantId: 'b1', name: 'Brand One', status: 'active', consentPolicy: { mode: 'opt_in' }, allowedChannels: ['store'], destinations: ['meta', 'google_ads'], defaultCountry: 'IN', retentionDays: 90, sources: {}, createdAt: '2026-10-01T00:00:00Z' };
const site = { key: `pk_${'a'.repeat(24)}`, origins: ['https://www.brand.com'], snippet: '<script src="x"></script>' };
const META = { channels: ['store'], destinations: ['meta', 'google_ads'], countries: ['IN'], importColumns: ['eventId'], importTemplate: 'eventId\n', defaultZohoMapping: {}, google: { oauthConfigured: false } };
const STATS0 = { sales: 0, matchedToPerson: 0, byChannel: {}, deliveries: {}, skipReasons: {}, processing: {}, withClickId: 0, contactOnly: 0 };

let app: { stop: () => void } | null = null;
let view: { tenant: typeof tenant; siteKeys: unknown[]; connections: unknown[]; webhooks: object };
const fresh = () => (view = { tenant: { ...tenant }, siteKeys: [], connections: [], webhooks: { zoho: 'https://c/zoho', generic: 'https://c/generic' } });

function mount(hash: string, extra: Record<string, (body: unknown) => unknown> = {}) {
  const api = mockApi({
    'GET /me': () => ({ ok: true }),
    'GET /meta': () => META,
    'GET /tenants': () => ({ tenants: [tenant] }),
    'GET /tenants/b1': () => view,
    'GET /tenants/b1/stats': () => STATS0,
    'GET /tenants/b1/sales': () => ({ sales: [] }),
    ...extra,
  });
  document.body.innerHTML = '<div id="app"></div>';
  sessionStorage.setItem('console_token', 't');
  location.hash = hash;
  app = startApp(document.getElementById('app')!);
  return api;
}
const q = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;
const btn = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

beforeEach(() => { sessionStorage.clear(); fresh(); });
afterEach(() => { app?.stop(); app = null; document.querySelectorAll('dialog').forEach((d) => d.remove()); });

describe('a new brand is guided', () => {
  it('shows four numbered steps, with a strong button on the next one only, and no empty numbers', async () => {
    mount('#/brand/b1/overview');
    await tick(150);
    const steps = Array.from(document.querySelectorAll('.steps .step'));
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.querySelector('.step-title')!.textContent)).toEqual(['Add your website', 'Connect your CRM', 'Connect your ad accounts', 'Receive your first sale']);
    expect(document.querySelectorAll('.steps button.primary')).toHaveLength(1);
    expect(q('.steps .step.current').textContent).toContain('Add website');
    expect(q('.progress').getAttribute('aria-valuenow')).toBe('0');
    expect(document.body.textContent).not.toContain('Activity');
  });

  it('the first step opens a small dialog and adding the website moves the guide on', async () => {
    const calls: unknown[] = [];
    mount('#/brand/b1/overview', {
      'POST /tenants/b1/site-keys': (b) => { calls.push(b); view.siteKeys = [site]; return { key: site.key }; },
    });
    await tick(150);
    btn('Add website')!.click();
    await tick(30);
    const dialog = q<HTMLDialogElement>('dialog');
    expect(dialog.open).toBe(true);
    expect(document.activeElement?.id).toBe('sk-o'); // ready to type
    expect(dialog.textContent).not.toContain('Tracking address'.repeat(2));
    expect(dialog.querySelector('details.more')?.hasAttribute('open')).toBe(false); // the optional part is tucked away

    (document.getElementById('sk-o') as HTMLInputElement).value = 'https://www.brand.com';
    dialog.querySelector('form')!.requestSubmit();
    await tick(250);
    expect(calls).toEqual([{ origins: ['https://www.brand.com'], label: '', trackingHost: '' }]);
    expect(document.querySelector('dialog')).toBeNull();
    expect(q('.progress').getAttribute('aria-valuenow')).toBe('1');
    expect(q('.steps .step.current').textContent).toContain('Set up Zoho');
  });

  it('once there are sales and everything is connected, the guide is gone and the numbers show', async () => {
    view.siteKeys = [site];
    view.tenant.sources = { zoho: { dealId: 'x' } } as never;
    view.connections = [{ kind: 'meta', status: 'active' }, { kind: 'google_ads', status: 'active' }];
    mount('#/brand/b1/overview', { 'GET /tenants/b1/stats': () => ({ ...STATS0, sales: 3 }) });
    await tick(150);
    expect(document.querySelector('.steps')).toBeNull();
    expect(q('#view').textContent).toContain('Activity');
  });
});

describe('forms live in dialogs', () => {
  it('the website tab is empty with one button, then lists the site with clear actions', async () => {
    mount('#/brand/b1/website');
    await tick(150);
    expect(q('#view').textContent).toContain('No website yet');
    expect(document.querySelector('input')).toBeNull(); // no permanent form on the page

    view.siteKeys = [site];
    app!.stop();
    mount('#/brand/b1/website');
    await tick(150);
    expect(btn('Install script')).toBeTruthy();
    expect(btn('Set tracking address')).toBeTruthy();
    expect(btn('Check setup')).toBeUndefined(); // only once there is an own address to check
    btn('Install script')!.click();
    await tick(30);
    expect(q('dialog').textContent).toContain('just before </head>');
    expect(q('dialog textarea')).not.toBeNull();
  });

  it('ad accounts show a state per platform and Connect opens the form only then', async () => {
    mount('#/brand/b1/connections');
    await tick(150);
    expect(document.querySelectorAll('.list-row')).toHaveLength(2);
    expect(q('#view').textContent).toContain('Not connected');
    expect(document.querySelector('#view input')).toBeNull();
    btn('Connect')!.click();
    await tick(30);
    expect(q('dialog').textContent).toContain('Connect Meta');
    expect(document.getElementById('m-ds')).not.toBeNull();
  });

  it('connecting Meta saves and the row turns to Connected', async () => {
    const saved: unknown[] = [];
    mount('#/brand/b1/connections', {
      'PUT /tenants/b1/connections/meta': (b) => { saved.push(b); view.connections = [{ kind: 'meta', status: 'active', datasetId: '123', secretSet: true }]; return {}; },
    });
    await tick(150);
    btn('Connect')!.click();
    await tick(30);
    (document.getElementById('m-ds') as HTMLInputElement).value = '123';
    (document.getElementById('m-token') as HTMLInputElement).value = 'tok';
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(300);
    expect(saved).toEqual([{ datasetId: '123', testEventCode: '', accessToken: 'tok' }]);
    expect(q('#view').textContent).toContain('Connected');
    expect(q('#view').textContent).toContain('Dataset 123');
  });

  it('a failed save keeps the dialog open and says why', async () => {
    mount('#/brand/b1/connections', { 'PUT /tenants/b1/connections/meta': () => ({ __status: 400, error: 'bad', message: 'Dataset ID must be numbers' }) });
    await tick(150);
    btn('Connect')!.click();
    await tick(30);
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(200);
    expect(document.querySelector('dialog')).not.toBeNull();
    expect(document.querySelector('.toast.bad')?.textContent).toContain('Dataset ID must be numbers');
  });

  it('an old link to Import lands on Sales, where Import is a button', async () => {
    mount('#/brand/b1/import');
    await tick(150);
    expect(q('.tabs [aria-current="page"]').textContent).toBe('Sales');
    expect(Array.from(document.querySelectorAll('.tabs a')).map((a) => a.textContent)).toEqual(['Overview', 'Website', 'CRM', 'Ad accounts', 'Sales', 'Settings']);
    btn('Import sales')!.click();
    await tick(30);
    expect(q('dialog').textContent).toContain('counted twice');
  });
});

describe('when this server is not allowed to send', () => {
  const sale = { saleKey: 's1', sale: { eventId: 'INV-1', channel: 'store', value: 100, currency: 'INR', occurredAt: '2026-10-08T10:00:00Z' }, deliveries: [{ destination: 'meta', status: 'pending', attempts: 0 }] };

  it('the Sales tab says so and the send button is off', async () => {
    (view as { sending?: unknown }).sending = { allowed: false, reason: 'Sending is switched off on this server (OUTBOUND_SENDS is not "on"). Nothing was sent.' };
    mount('#/brand/b1/sales', { 'GET /tenants/b1/sales': () => ({ sales: [sale] }) });
    await tick(150);
    expect(q('#view .note').textContent).toContain('switched off');
    expect(btn('Send waiting sales now')!.disabled).toBe(true);
    expect(btn('Send waiting sales now')!.title).toContain('switched off');
  });

  it('when sending is allowed there is no banner and the button works', async () => {
    (view as { sending?: unknown }).sending = { allowed: true };
    mount('#/brand/b1/sales', { 'GET /tenants/b1/sales': () => ({ sales: [sale] }) });
    await tick(150);
    expect(document.querySelector('#view .note')).toBeNull();
    expect(btn('Send waiting sales now')!.disabled).toBe(false);
  });

  it('if the server still holds the sale back, the reason is shown instead of "nothing was waiting"', async () => {
    (view as { sending?: unknown }).sending = { allowed: true };
    mount('#/brand/b1/sales', {
      'GET /tenants/b1/sales': () => ({ sales: [sale] }),
      'POST /tenants/b1/dispatch': () => ({ considered: 0, sent: 0, blocked: 1, blockedReason: 'Sending to google_ads is not allowed on this server.' }),
    });
    await tick(150);
    btn('Send waiting sales now')!.click();
    await tick(150);
    expect(document.querySelector('.toast')?.textContent).toContain('not allowed on this server');
  });
});

describe('erasing a customer', () => {
  const open = async (extra: Record<string, (b: unknown) => unknown> = {}) => {
    const calls: unknown[] = [];
    mount('#/brand/b1/settings', { 'POST /tenants/b1/customers/erase': (b) => { calls.push(b); return { found: true, persons: 1, sales: 2, deliveriesCancelled: 3 }; }, ...extra });
    await tick(150);
    btn('Erase…')!.click();
    await tick(40);
    return calls;
  };
  const confirmButton = () => Array.from(document.querySelectorAll('dialog.confirm button')).find((b) => b.textContent === 'Erase') as HTMLButtonElement;

  it('says what it does and what it cannot do, in a red dialog', async () => {
    await open();
    const dialog = q('dialog');
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain('Meta or Google is not removed');
    expect(dialog.querySelector('button.danger-solid')?.textContent).toBe('Erase customer data');
  });

  it('asks for a contact, then asks again before doing anything', async () => {
    const calls = await open();
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(80);
    expect(document.querySelector('.toast.bad')?.textContent).toContain('phone number or an email');
    expect(calls).toEqual([]);

    (document.getElementById('er-phone') as HTMLInputElement).value = '98765 43210';
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(60);
    expect(confirmButton()).toBeTruthy(); // the second question
    expect(calls).toEqual([]); // nothing yet
  });

  it('after confirming it erases and reports what was removed', async () => {
    const calls = await open();
    (document.getElementById('er-email') as HTMLInputElement).value = 'priya@example.com';
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(60);
    confirmButton().click();
    await tick(250);
    expect(calls).toEqual([{ phone: '', email: 'priya@example.com' }]);
    expect(document.querySelector('.toast')?.textContent).toBe('Erased: 1 website profile deleted, 2 sales made anonymous, 3 queued sends cancelled.');
  });

  it('says when more than one phone or email was covered', async () => {
    await open({ 'POST /tenants/b1/customers/erase': () => ({ found: true, contactDetails: 2, persons: 0, sales: 1, deliveriesCancelled: 0 }) });
    (document.getElementById('er-phone') as HTMLInputElement).value = '98765 43210';
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(60);
    confirmButton().click();
    await tick(250);
    expect(document.querySelector('.toast')?.textContent).toBe('Erased: 1 sale made anonymous. Nothing will be sent for any of the 2 phone numbers and emails linked to them.');
  });

  it('cancelling the second question erases nothing and leaves the form open', async () => {
    const calls = await open();
    (document.getElementById('er-phone') as HTMLInputElement).value = '98765 43210';
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(60);
    (Array.from(document.querySelectorAll('dialog.confirm button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click();
    await tick(250);
    expect(calls).toEqual([]);
    expect(document.getElementById('er-phone')).not.toBeNull();
  });

  it('a customer who was never stored is still recorded as not to be sent for', async () => {
    const calls = await open({ 'POST /tenants/b1/customers/erase': () => ({ found: true, persons: 0, sales: 0, deliveriesCancelled: 0 }) });
    (document.getElementById('er-phone') as HTMLInputElement).value = '98765 43210';
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(60);
    confirmButton().click();
    await tick(250);
    expect(document.querySelector('.toast')?.textContent).toContain('Nothing will be sent for them');
    expect(calls).toEqual([]);
  });
});

describe('the sending switch on the brands page', () => {
  it('shows that sending is on, with a button to pause everything', async () => {
    mount('#/', { 'GET /sending': () => ({ enabled: true, paused: false, destinations: ['meta'] }) });
    await tick(150);
    const strip = q('#view .list-row');
    expect(strip.textContent).toContain('On');
    expect(strip.textContent).toContain('only to Meta');
    expect(btn('Pause all sending')).toBeTruthy();
    expect(btn('Resume sending')).toBeUndefined();
  });

  it('pausing asks for an optional reason, then the strip shows it and offers to resume', async () => {
    const calls: unknown[] = [];
    mount('#/', {
      'GET /sending': () => ({ enabled: true, paused: false }),
      'PUT /sending': (b) => { calls.push(b); return (b as { paused: boolean }).paused ? { enabled: true, paused: true, reason: 'checking a mapping' } : { enabled: true, paused: false }; },
    });
    await tick(150);
    btn('Pause all sending')!.click();
    await tick(40);
    expect(q('dialog').textContent).toContain('already on its way');
    (document.getElementById('ps-reason') as HTMLInputElement).value = 'checking a mapping';
    q('dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(250);
    expect(calls).toEqual([{ paused: true, reason: 'checking a mapping' }]);
    expect(q('#view .list-row').textContent).toContain('Paused for every brand: checking a mapping');
    expect(btn('Resume sending')).toBeTruthy();

    btn('Resume sending')!.click();
    await tick(150);
    expect(calls[1]).toEqual({ paused: false });
    expect(q('#view .list-row').textContent).toContain('On');
    expect(btn('Pause all sending')).toBeTruthy();
  });

  it('when the server itself is set not to send, it says so and offers no button', async () => {
    mount('#/', { 'GET /sending': () => ({ enabled: false, paused: false }) });
    await tick(150);
    expect(q('#view .list-row').textContent).toContain('OUTBOUND_SENDS');
    expect(btn('Pause all sending')).toBeUndefined();
    expect(btn('Resume sending')).toBeUndefined();
  });

  it('a server without the switch simply shows no strip', async () => {
    mount('#/');
    await tick(150);
    expect(document.querySelector('#view .list-row')).toBeNull();
    expect(q('#view').textContent).toContain('Brand One');
  });
});

describe('Overview: what needs attention', () => {
  const doneView = () => {
    view.siteKeys = [site];
    view.tenant.sources = { zoho: { dealId: 'x' } } as never;
    view.connections = [{ kind: 'meta', status: 'active' }, { kind: 'google_ads', status: 'active' }];
  };
  const stats = (over: object = {}) => ({ ...STATS0, sales: 5, deliveries: {}, processing: {}, ...over });

  it('says nothing when everything is fine', async () => {
    doneView();
    mount('#/brand/b1/overview', { 'GET /tenants/b1/stats': () => stats({ deliveries: { meta: { sent: 5 } } }) });
    await tick(150);
    expect(document.querySelector('.attention')).toBeNull();
  });

  it('a broken connection comes first, with a button that goes to fix it, and the setup guide agrees', async () => {
    doneView();
    view.connections = [{ kind: 'meta', status: 'error', lastError: 'meta 400 code 190: Invalid OAuth access token' }, { kind: 'google_ads', status: 'active' }];
    mount('#/brand/b1/overview', { 'GET /tenants/b1/stats': () => stats() });
    await tick(150);
    const card = q('.attention');
    expect(card.textContent).toContain('Meta stopped accepting sales');
    expect(card.textContent).toContain('Invalid OAuth access token');
    expect(q('.brand-content').firstElementChild!.firstElementChild).toBe(card); // above everything else, including the setup guide
    expect(q('.steps .step.current').textContent).toContain('Fix your ad account connection');
    (Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Fix connection') as HTMLButtonElement).click();
    await tick(150);
    expect(q('.tabs [aria-current="page"]').textContent).toBe('Ad accounts');
  });

  it('failed and rejected sales are counted per platform and open exactly those sales', async () => {
    doneView();
    mount('#/brand/b1/overview', {
      'GET /tenants/b1/stats': () => stats({ deliveries: { meta: { failed: 2, sent: 3 }, google_ads: { sent: 5 } }, processing: { google_ads: { rejected: 1 } } }),
      'GET /tenants/b1/sales': () => ({ sales: SALES }),
    });
    await tick(150);
    const text = q('.attention').textContent!;
    expect(text).toContain('2 sales could not be sent to Meta.');
    expect(text).toContain('Google Ads accepted 1 sale but then rejected it.');
    expect(q('.attention h2').textContent).toBe('Needs attention (2)');

    (Array.from(q('.attention').querySelectorAll('button')).find((b) => b.textContent === 'Review') as HTMLButtonElement).click();
    await tick(200);
    expect(q('.tabs [aria-current="page"]').textContent).toBe('Sales');
    expect(q('.seg-btn[aria-pressed="true"]').textContent).toContain('Needs attention');
    expect(q('.filter-chip').textContent).toContain('Only Meta');
  });

  it('the counts on the platform cards are buttons that open the matching sales', async () => {
    doneView();
    mount('#/brand/b1/overview', { 'GET /tenants/b1/stats': () => stats({ deliveries: { meta: { sent: 3 }, google_ads: { sent: 5 } } }), 'GET /tenants/b1/sales': () => ({ sales: SALES }) });
    await tick(150);
    const sentOnGoogle = Array.from(document.querySelectorAll('button.chip-link')).filter((b) => b.textContent === '5 sent')[0] as HTMLButtonElement;
    expect(sentOnGoogle).toBeTruthy();
    sentOnGoogle.click();
    await tick(200);
    expect(q('.seg-btn[aria-pressed="true"]').textContent).toContain('Sent');
    expect(q('.filter-chip').textContent).toContain('Only Google Ads');
  });

  it('sending being held back is shown as a note without a button', async () => {
    doneView();
    (view as { sending?: unknown }).sending = { allowed: false, reason: 'Sending is paused by an operator (mapping check). Nothing was sent.' };
    mount('#/brand/b1/overview', { 'GET /tenants/b1/stats': () => stats() });
    await tick(150);
    expect(q('.attention').textContent).toContain('paused by an operator');
    expect(q('.attention button')).toBeNull();
  });
});

const SALES = [
  { saleKey: 'k1', sale: { eventId: 'INV-1', channel: 'store', value: 100, currency: 'INR', occurredAt: '2026-10-08T10:00:00Z', storeName: 'Pune' }, deliveries: [{ destination: 'meta', status: 'failed', attempts: 6, lastError: 'meta 400' }, { destination: 'google_ads', status: 'sent', attempts: 1 }] },
  { saleKey: 'k2', sale: { eventId: 'INV-2', channel: 'store', value: 200, currency: 'INR', occurredAt: '2026-10-08T11:00:00Z', storeName: 'Mumbai' }, deliveries: [{ destination: 'meta', status: 'sent', attempts: 1 }, { destination: 'google_ads', status: 'sent', attempts: 1, processingStatus: 'rejected' }] },
  { saleKey: 'k3', sale: { eventId: 'INV-3', channel: 'whatsapp', value: 300, currency: 'INR', occurredAt: '2026-10-08T12:00:00Z' }, deliveries: [{ destination: 'meta', status: 'pending', attempts: 0 }, { destination: 'google_ads', status: 'retry', attempts: 0, lastError: 'not_connected: no account connected for this destination' }] },
  { saleKey: 'k4', sale: { eventId: 'INV-4', channel: 'store', value: 400, currency: 'INR', occurredAt: '2026-10-08T13:00:00Z' }, deliveries: [{ destination: 'meta', status: 'skipped', skipReason: 'no_consent', attempts: 0 }, { destination: 'google_ads', status: 'skipped', skipReason: 'no_consent', attempts: 0 }] },
];

describe('Sales: finding the sales that matter', () => {
  const open = async () => {
    mount('#/brand/b1/sales', { 'GET /tenants/b1/sales': () => ({ sales: SALES }) });
    await tick(150);
  };
  const rows = () => Array.from(document.querySelectorAll('#view tbody tr')).map((r) => r.querySelector('.mono')!.textContent);
  const seg = (label: string) => Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent!.startsWith(label)) as HTMLButtonElement;
  const counts = () => Object.fromEntries(Array.from(document.querySelectorAll('.seg-btn')).map((b) => [b.firstChild!.textContent, Number(b.querySelector('.seg-count')!.textContent)]));

  it('shows how many sales are in each group, and starts with all of them', async () => {
    await open();
    expect(rows()).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4']);
    // INV-3 only waits for a connection: that is "waiting", not "needs attention"
    expect(counts()).toEqual({ All: 4, 'Needs attention': 2, Waiting: 1, Sent: 2, Skipped: 1 });
  });

  it('a group narrows the table, and says which one is chosen', async () => {
    await open();
    seg('Needs attention').click();
    expect(rows()).toEqual(['INV-1', 'INV-2']); // a failure, and a platform rejection after acceptance
    expect(seg('Needs attention').getAttribute('aria-pressed')).toBe('true');
    expect(seg('All').getAttribute('aria-pressed')).toBe('false');
    seg('Waiting').click();
    expect(rows()).toEqual(['INV-3']);
    seg('Skipped').click();
    expect(rows()).toEqual(['INV-4']);
  });

  it('searching by sale ID or store narrows the list without losing the cursor', async () => {
    await open();
    const box = q<HTMLInputElement>('.filters input[type="search"]');
    box.focus();
    box.value = 'mumbai';
    box.dispatchEvent(new Event('input'));
    expect(rows()).toEqual(['INV-2']);
    expect(document.activeElement).toBe(box); // the same box, still focused
    expect(q<HTMLInputElement>('.filters input[type="search"]')).toBe(box);
    box.value = 'inv-3';
    box.dispatchEvent(new Event('input'));
    expect(rows()).toEqual(['INV-3']);
    expect(counts().All).toBe(1);
  });

  it('a platform filter shows only that platform and can be removed', async () => {
    // reached the way a person would: from a count on the Overview
    view.siteKeys = [site];
    view.tenant.sources = { zoho: { dealId: 'x' } } as never;
    view.connections = [{ kind: 'meta', status: 'active' }, { kind: 'google_ads', status: 'active' }];
    mount('#/brand/b1/overview', { 'GET /tenants/b1/stats': () => ({ ...STATS0, sales: 4, deliveries: { meta: { failed: 1 }, google_ads: {} } }), 'GET /tenants/b1/sales': () => ({ sales: SALES }) });
    await tick(150);
    (Array.from(document.querySelectorAll('button.chip-link')).find((b) => b.textContent === '1 failed') as HTMLButtonElement).click();
    await tick(250);
    expect(rows()).toEqual(['INV-1']);
    expect(document.querySelectorAll('#view tbody tr:first-child .chip-line')).toHaveLength(1); // only Meta's chip
    q('.filter-chip').click();
    seg('All').click();
    expect(rows()).toHaveLength(4);
    expect(document.querySelector('.filter-chip')).toBeNull();
  });

  it('no match says so and offers to clear', async () => {
    await open();
    const box = q<HTMLInputElement>('.filters input[type="search"]');
    box.value = 'zzz';
    box.dispatchEvent(new Event('input'));
    expect(q('#view').textContent).toContain('No sales match');
    btn('Clear filters')!.click();
    expect(rows()).toHaveLength(4);
    expect(box.value).toBe('');
  });

  it('the preset from the Overview is used once: coming back to Sales later starts unfiltered', async () => {
    await open();
    seg('Sent').click();
    expect(rows()).toHaveLength(2);
    location.hash = '#/brand/b1/settings';
    await tick(150);
    location.hash = '#/brand/b1/sales';
    await tick(200);
    expect(seg('All').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Settings: saving only when something changed', () => {
  it('Save is off until a change, the page says when there is one, and undoing it turns it off again', async () => {
    mount('#/brand/b1/settings');
    await tick(150);
    const save = btn('Save settings')!;
    expect(save.disabled).toBe(true);
    expect(document.body.textContent).not.toContain('unsaved changes');

    const name = document.getElementById('st-name') as HTMLInputElement;
    name.value = 'Brand One Renamed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(save.disabled).toBe(false);
    expect(q('#view').textContent).toContain('You have unsaved changes.');

    name.value = 'Brand One';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(save.disabled).toBe(true);
    expect(q('#view').textContent).not.toContain('unsaved changes');
  });

  it('checkboxes and selects count as changes too', async () => {
    mount('#/brand/b1/settings');
    await tick(150);
    const box = document.querySelector('#view input[type="checkbox"]') as HTMLInputElement;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(btn('Save settings')!.disabled).toBe(false);
  });
});

describe('the brands list with many brands', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ ...tenant, tenantId: `b${i}`, name: `Brand ${String(i).padStart(3, '0')}`, status: i % 10 === 0 ? 'suspended' : 'active' }));

  it('draws a page at a time, says how many are left, and searching looks at all of them', async () => {
    mount('#/', { 'GET /tenants': () => ({ tenants: many }) });
    await tick(150);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(q('[role="status"]').textContent).toBe('120 brands');
    expect(q('#view').textContent).toContain('Showing 50 of 120');
    btn('Show 50 more')!.click();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(100);
    btn('Show 20 more')!.click();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(120);
    expect(btn('Show 20 more')).toBeUndefined();

    const search = q<HTMLInputElement>('input[type="search"]');
    search.value = 'brand 119';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1); // found although it was not on the first page
  });

  it('can be limited to active or suspended brands, with counts', async () => {
    mount('#/', { 'GET /tenants': () => ({ tenants: many }) });
    await tick(150);
    const seg = (label: string) => Array.from(document.querySelectorAll('.seg-btn')).find((b) => b.textContent!.startsWith(label)) as HTMLButtonElement;
    expect(seg('Suspended').querySelector('.seg-count')!.textContent).toBe('12');
    seg('Suspended').click();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(12);
    expect(q('[role="status"]').textContent).toBe('12 of 120 brands');
    expect(Array.from(document.querySelectorAll('tbody tr td:nth-child(2)')).every((td) => td.textContent!.includes('suspended'))).toBe(true);
    seg('All').click();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
  });

  it('there is no status filter when every brand has the same status', async () => {
    mount('#/', { 'GET /tenants': () => ({ tenants: [tenant] }) });
    await tick(150);
    expect(document.querySelector('.seg')).toBeNull();
  });
});
