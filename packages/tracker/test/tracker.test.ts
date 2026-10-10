// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTracker, extractContact, type TrackerConfig } from '../src/tracker';

// Storage names are namespaced by site key.
const LS = 'dh_touches:site_key';
const CK = 'dh_t_site_key';
const T0 = new Date('2026-10-08T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

function visit(search: string) {
  window.history.pushState({}, '', `/rings${search}`);
}

function fetchOk() {
  return vi.fn(async () => ({ ok: true }) as Response);
}

function make(overrides: Partial<TrackerConfig> = {}) {
  const fetchImpl = fetchOk();
  const tracker = createTracker({
    key: 'site_key',
    endpoint: 'https://track.brand.com/',
    consentMode: 'opt_in',
    getConsent: () => 'granted',
    fetchImpl,
    now: () => T0,
    ...overrides,
  });
  return { tracker, fetchImpl };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = `${CK}=;path=/;max-age=0`;
  document.body.innerHTML = '';
  visit('');
});

describe('capture', () => {
  it('stores click IDs from the landing URL and builds fbc from the click time', () => {
    visit('?gclid=G1&fbclid=F1&utm_source=google&utm_campaign=diwali');
    const { tracker } = make();
    const [touch] = tracker.touches();
    expect(touch).toMatchObject({
      clickedAt: T0,
      gclid: 'G1',
      fbclid: 'F1',
      fbc: `fb.1.${T0}.F1`,
      utm: { utm_source: 'google', utm_campaign: 'diwali' },
      landingUrl: 'http://localhost:3000/rings',
    });
    expect(JSON.parse(localStorage.getItem(LS)!)).toHaveLength(1);
    expect(document.cookie).toContain(`${CK}=`);
  });

  it('ignores organic landings', () => {
    visit('?ref=home');
    const { tracker } = make();
    expect(tracker.touches()).toEqual([]);
    expect(localStorage.getItem(LS)).toBeNull();
  });

  it('never keeps the query string in landingUrl', () => {
    visit('?gclid=G1&secret=abc');
    const { tracker } = make();
    expect(tracker.touches()[0]?.landingUrl).not.toContain('secret');
  });
});

describe('consent', () => {
  it('opt_in: holds touches in memory until consent, then persists them', () => {
    visit('?gclid=G1');
    const { tracker } = make({ getConsent: () => 'unknown' });
    expect(localStorage.getItem(LS)).toBeNull();
    expect(document.cookie).not.toContain(`${CK}=`);

    tracker.setConsent(true);
    expect(JSON.parse(localStorage.getItem(LS)!)[0].gclid).toBe('G1');
    expect(document.cookie).toContain(`${CK}=`);
  });

  it('declined consent stores nothing and drops what was held', async () => {
    visit('?gclid=G1');
    const { tracker, fetchImpl } = make({ getConsent: () => 'unknown' });
    tracker.setConsent(false);
    expect(localStorage.getItem(LS)).toBeNull();
    expect(tracker.touches()).toEqual([]);
    expect(await tracker.identify({ phone: '9876543210' })).toEqual({ sent: false, reason: 'no_consent' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('opt_out: stores unless the visitor declined', () => {
    visit('?gclid=G1');
    make({ consentMode: 'opt_out', getConsent: () => 'unknown' });
    expect(localStorage.getItem(LS)).not.toBeNull();

    localStorage.clear();
    make({ consentMode: 'opt_out', getConsent: () => 'denied' });
    expect(localStorage.getItem(LS)).toBeNull();
  });
});

describe('identify', () => {
  it('sends the contact, consent and touches to /identify without a CORS preflight', async () => {
    visit('?gclid=G1&fbclid=F1');
    const { tracker, fetchImpl } = make({ country: 'IN' });
    const res = await tracker.identify({ phone: '98765 43210', email: 'priya@example.com' });
    expect(res).toEqual({ sent: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://track.brand.com/identify');
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/plain;charset=UTF-8');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      key: 'site_key',
      phone: '98765 43210',
      email: 'priya@example.com',
      country: 'IN',
      consent: { ads: true },
    });
    expect(body.touches).toHaveLength(1);
    expect(body.touches[0]).toMatchObject({ gclid: 'G1', fbclid: 'F1', clickedAt: T0 });
  });

  it('sends the Meta pixel\'s browser ID (_fbp) when the page has one', async () => {
    document.cookie = '_fbp=fb.1.1700000000000.123456;path=/';
    const { tracker, fetchImpl } = make();
    await tracker.identify({ phone: '9876543210' });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.fbp).toBe('fb.1.1700000000000.123456');
    document.cookie = '_fbp=;path=/;max-age=0';
  });

  it('does not invent a browser ID when the page has none, or send a malformed one', async () => {
    document.cookie = '_fbp=junk;path=/';
    const { tracker, fetchImpl } = make();
    await tracker.identify({ phone: '9876543210' });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.fbp).toBeUndefined();
    document.cookie = '_fbp=;path=/;max-age=0';
  });

  it('does not send without consent (opt_in, unknown)', async () => {
    visit('?gclid=G1');
    const { tracker, fetchImpl } = make({ getConsent: () => 'unknown' });
    expect(await tracker.identify({ phone: '9876543210' })).toEqual({ sent: false, reason: 'no_consent' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('needs a phone or an email', async () => {
    const { tracker } = make();
    expect(await tracker.identify({})).toEqual({ sent: false, reason: 'no_contact' });
  });

  it('does not resend an identical identify call', async () => {
    visit('?gclid=G1');
    const { tracker, fetchImpl } = make();
    await tracker.identify({ phone: '9876543210' });
    expect(await tracker.identify({ phone: '9876543210' })).toEqual({ sent: false, reason: 'duplicate' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports network errors and rejected responses', async () => {
    const down = make({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    expect(await down.tracker.identify({ phone: '9876543210' })).toEqual({ sent: false, reason: 'network_error' });

    const bad = make({ fetchImpl: vi.fn(async () => ({ ok: false }) as Response) });
    expect(await bad.tracker.identify({ phone: '9876543210' })).toEqual({ sent: false, reason: 'rejected' });
  });
});

describe('form auto-binding', () => {
  it('extracts phone and email, ignores passwords', () => {
    document.body.innerHTML = `
      <form id="f">
        <input name="full_name" value="Priya">
        <input type="email" name="email" value="priya@example.com">
        <input type="tel" name="mobile" value="98765 43210">
        <input type="password" name="pw" value="hunter2hunter2">
      </form>`;
    const form = document.getElementById('f') as HTMLFormElement;
    expect(extractContact(form)).toEqual({ email: 'priya@example.com', phone: '98765 43210' });
  });

  it('identifies when a form with a phone is submitted', async () => {
    visit('?gclid=G1');
    const { fetchImpl } = make();
    document.body.innerHTML = `<form id="f"><input type="tel" name="phone" value="98765 43210"></form>`;
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).phone).toBe('98765 43210');
  });

  it('ignores forms without contact details', () => {
    const { fetchImpl } = make();
    document.body.innerHTML = `<form id="f"><input name="q" value="rings"></form>`;
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('touch retention', () => {
  it('keeps the first touch and the latest ones, up to maxTouches', () => {
    let clock = T0;
    const { tracker } = make({ maxTouches: 3, now: () => clock });
    for (let i = 1; i <= 5; i++) {
      clock = T0 + i * DAY;
      visit(`?gclid=G${i}`);
      tracker.capture();
    }
    expect(tracker.touches().map((t) => t.gclid)).toEqual(['G1', 'G4', 'G5']);
  });

  it('drops touches older than the retention period', () => {
    visit('?gclid=OLD');
    make({ now: () => T0 });
    visit('');
    const { tracker } = make({ now: () => T0 + 100 * DAY, retentionDays: 90 });
    expect(tracker.touches()).toEqual([]);
  });
});
