// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTracker, type TrackerConfig } from '../src/tracker';

const T0 = new Date('2026-10-08T12:00:00Z').getTime();
const visit = (search: string) => window.history.pushState({}, '', `/rings${search}`);

function make(overrides: Partial<TrackerConfig> = {}) {
  const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
  const tracker = createTracker({
    key: 'site_fp', endpoint: 'https://track.brand.com', consentMode: 'opt_in', getConsent: () => 'granted',
    serverCookie: true, autoBind: false, fetchImpl, now: () => T0, ...overrides,
  });
  const calls = () => fetchImpl.mock.calls.map((c) => c as unknown as [string, RequestInit]).map(([url, init]) => ({ path: new URL(url).pathname, init, body: JSON.parse(String(init.body)) as Record<string, unknown> }));
  return { tracker, fetchImpl, calls };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'dh_t_site_fp=;path=/;max-age=0';
  visit('');
});

describe('first-party cookie requests', () => {
  it('a click is also sent to /touch, with credentials so the browser keeps the cookie', () => {
    visit('?gclid=G1&fbclid=F1&utm_source=google');
    const { calls } = make();
    const [touch] = calls();
    expect(touch?.path).toBe('/touch');
    expect(touch?.init.credentials).toBe('include');
    expect(touch?.init.keepalive).toBe(true);
    expect(touch?.body).toMatchObject({
      key: 'site_fp',
      consent: true,
      touch: { clickedAt: T0, gclid: 'G1', fbclid: 'F1', fbc: `fb.1.${T0}.F1`, utm: { utm_source: 'google' } },
    });
    expect((touch!.body.touch as Record<string, unknown>).landingUrl).toBeUndefined(); // no page address leaves the browser
  });

  it('nothing is sent for organic landings, or when the option is off (the library default)', () => {
    visit('?ref=home');
    expect(make().calls()).toEqual([]);
    visit('?gclid=G1');
    expect(make({ serverCookie: false }).calls()).toEqual([]);
  });

  it('opt-in: nothing leaves while consent is unknown; the held click is sent once, with its original time, after consent', () => {
    visit('?gclid=G1');
    let clock = T0;
    const { tracker, calls } = make({ getConsent: () => 'unknown', now: () => clock });
    expect(calls()).toEqual([]);

    clock = T0 + 60_000; // the visitor accepts a minute later
    tracker.setConsent(true);
    expect(calls().map((c) => c.path)).toEqual(['/touch']);
    expect(calls()[0]!.body).toMatchObject({ consent: true, touch: { clickedAt: T0, gclid: 'G1' } });
  });

  it('reloading the landing page does not send the same click again', () => {
    visit('?gclid=G1');
    const first = make();
    expect(first.calls()).toHaveLength(1);
    const second = make(); // a new page view of the same URL
    second.tracker.capture();
    expect(second.calls()).toEqual([]);
  });

  it('identify and withdrawal also carry credentials', async () => {
    visit('?gclid=G1');
    const { tracker, calls } = make();
    await tracker.identify({ phone: '98765 43210' });
    const identify = calls().find((c) => c.path === '/identify')!;
    expect(identify.init.credentials).toBe('include');
    await tracker.withdraw();
    const consent = calls().find((c) => c.path === '/consent')!;
    expect(consent.init.credentials).toBe('include');
  });

  it('withdrawing clears the server cookie even when the visitor never identified', async () => {
    visit('?gclid=G1');
    const { tracker, calls } = make();
    await tracker.withdraw();
    const clear = calls().filter((c) => c.path === '/touch').at(-1)!;
    expect(clear.body).toEqual({ key: 'site_fp', clear: true });
    expect(calls().some((c) => c.path === '/consent')).toBe(false); // no contact known, nobody to name
  });

  it('a failing server never breaks the page or the local copy', () => {
    visit('?gclid=G1');
    const { tracker } = make({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as never });
    expect(tracker.touches()).toHaveLength(1);
    expect(localStorage.getItem('dh_touches:site_fp')).not.toBeNull();
  });
});
