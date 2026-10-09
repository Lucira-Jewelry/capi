// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTracker, type TrackerConfig } from '../src/tracker';

const T0 = new Date('2026-10-08T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

const visit = (search: string) => window.history.pushState({}, '', `/rings${search}`);
const ok = () => vi.fn(async () => ({ ok: true }) as Response);

function make(key: string, overrides: Partial<TrackerConfig> = {}) {
  const fetchImpl = ok();
  const tracker = createTracker({
    key, endpoint: 'https://track.brand.com', consentMode: 'opt_in', getConsent: () => 'granted', fetchImpl, now: () => T0, autoBind: false, ...overrides,
  });
  return { tracker, fetchImpl };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const name of ['dh_t_site_a', 'dh_t_site_b']) document.cookie = `${name}=;path=/;max-age=0`;
  visit('');
});

describe('storage is per site key', () => {
  it('two site keys on one origin never read each other\'s clicks', () => {
    visit('?gclid=ONLY-A');
    const a = make('site_a');
    visit('');
    const b = make('site_b');
    expect(a.tracker.touches().map((t) => t.gclid)).toEqual(['ONLY-A']);
    expect(b.tracker.touches()).toEqual([]);
    expect(localStorage.getItem('dh_touches:site_a')).not.toBeNull();
    expect(localStorage.getItem('dh_touches:site_b')).toBeNull();
  });
});

describe('no contact details in browser storage', () => {
  it('the "already sent" memory holds fingerprints, not phone numbers or emails', async () => {
    visit('?gclid=G1');
    const { tracker } = make('site_a');
    await tracker.identify({ phone: '98765 43210', email: 'priya@example.com' });
    const stored = sessionStorage.getItem('dh_sent:site_a') ?? '';
    expect(stored).not.toBe('');
    expect(stored).not.toContain('98765');
    expect(stored).not.toContain('priya');
    // ...and it still stops an identical second send.
    expect(await tracker.identify({ phone: '98765 43210', email: 'priya@example.com' })).toEqual({ sent: false, reason: 'duplicate' });
  });
});

describe('a click is not renewed', () => {
  it('reloading the landing page keeps the original click time and fbc', () => {
    let clock = T0;
    visit('?gclid=G1&fbclid=F1');
    const first = make('site_a', { now: () => clock });
    const original = first.tracker.touches()[0]!;

    clock = T0 + 3 * DAY; // the visitor comes back to the same URL (reload, bookmark, back button)
    const second = make('site_a', { now: () => clock });
    second.tracker.capture();
    const touches = second.tracker.touches();
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ clickedAt: T0, fbc: original.fbc });
  });

  it('a genuinely different click is added', () => {
    visit('?gclid=G1');
    const a = make('site_a');
    visit('?gclid=G2');
    a.tracker.capture();
    expect(a.tracker.touches().map((t) => t.gclid)).toEqual(['G1', 'G2']);
  });
});

describe('withdrawing consent', () => {
  it('opt_in: clears storage, cookie and sent-memory, and tells the server who withdrew', async () => {
    visit('?gclid=G1');
    const { tracker, fetchImpl } = make('site_a');
    await tracker.identify({ phone: '98765 43210', email: 'priya@example.com' });
    expect(localStorage.getItem('dh_touches:site_a')).not.toBeNull();
    expect(document.cookie).toContain('dh_t_site_a=');

    expect(await tracker.withdraw()).toEqual({ notified: true });
    expect(localStorage.getItem('dh_touches:site_a')).toBeNull();
    expect(sessionStorage.getItem('dh_sent:site_a')).toBeNull();
    expect(document.cookie).not.toContain('dh_t_site_a=');
    expect(tracker.touches()).toEqual([]);

    const [url, init] = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe('https://track.brand.com/consent');
    expect(JSON.parse(init.body as string)).toEqual({ key: 'site_a', phone: '98765 43210', email: 'priya@example.com' });
  });

  it('setConsent(false) does the same, in opt_in AND opt_out mode', async () => {
    for (const mode of ['opt_in', 'opt_out'] as const) {
      localStorage.clear();
      visit('?gclid=G1');
      const { tracker, fetchImpl } = make('site_a', { consentMode: mode, getConsent: () => 'unknown' });
      if (mode === 'opt_in') tracker.setConsent(true); // opt_in needs a yes before anything is stored; opt_out does not
      await tracker.identify({ email: 'priya@example.com' });
      expect(localStorage.getItem('dh_touches:site_a')).not.toBeNull();
      tracker.setConsent(false);
      const urls = () => fetchImpl.mock.calls.map((c) => String((c as unknown as [string])[0]));
      await vi.waitFor(() => expect(urls().some((u) => u.endsWith('/consent'))).toBe(true));
      expect(localStorage.getItem('dh_touches:site_a')).toBeNull();
      expect(tracker.touches()).toEqual([]);
    }
  });

  it('without a known contact it clears locally and sends nothing; an explicit contact is sent', async () => {
    visit('?gclid=G1');
    const { tracker, fetchImpl } = make('site_a');
    expect(await tracker.withdraw()).toEqual({ notified: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await tracker.withdraw({ phone: '98765 43210' })).toEqual({ notified: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a failed notification still leaves the browser clean', async () => {
    visit('?gclid=G1');
    const { tracker } = make('site_a', { fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as never });
    await tracker.identify({ phone: '98765 43210' }); // fails to send, but the contact is remembered in memory
    expect(await tracker.withdraw()).toEqual({ notified: false });
    expect(localStorage.getItem('dh_touches:site_a')).toBeNull();
  });

  it('a banner that already says "denied" leaves nothing behind from earlier visits', () => {
    visit('?gclid=G1');
    make('site_a');
    expect(localStorage.getItem('dh_touches:site_a')).not.toBeNull();

    visit('');
    make('site_a', { getConsent: () => 'denied' });
    expect(localStorage.getItem('dh_touches:site_a')).toBeNull();
    expect(document.cookie).not.toContain('dh_t_site_a=');
  });
});
