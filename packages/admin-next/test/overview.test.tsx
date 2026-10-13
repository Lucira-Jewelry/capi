// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Overview } from '@/tabs/Overview';
import type { Connection, Stats } from '@/lib/types';
import { meta, mockApi, renderWithApp, tenantView } from './helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STATS0: Stats = { sales: 0, matchedToPerson: 0, byChannel: {}, deliveries: {}, skipReasons: {}, processing: {}, withClickId: 0, contactOnly: 0 };
const stats = (over: Partial<Stats> = {}): Stats => ({ ...STATS0, sales: 5, ...over });
const site = { key: `pk_${'a'.repeat(24)}`, origins: ['https://www.brand.com'], snippet: '<script src="x"></script>' };
const active = (kind: Connection['kind']): Connection => ({ kind, status: 'active', secretSet: true, updatedAt: '2026-10-01T00:00:00Z' });

/** A brand with everything set up, so the guide is gone and the numbers show. */
const doneView = (over = {}) => {
  const v = tenantView({ siteKeys: [site], connections: [active('meta'), active('google_ads')], ...over });
  v.tenant = { ...v.tenant, sources: { zoho: {} as never } };
  return v;
};

const show = (view = doneView()) => renderWithApp(<Overview id="b1" view={view} meta={meta} reload={async () => {}} />);
// Next adds the trailing slash itself from its config; tests run without the config, so compare without it.
const norm = (h: string | null) => h?.replace('/brand/?', '/brand?') ?? null;
const href = (el: HTMLElement) => norm(el.closest('a')!.getAttribute('href'));

describe('a new brand is guided', () => {
  it('shows four numbered steps, a strong button on the next one only, and no numbers yet', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => STATS0 });
    show(tenantView());
    await screen.findByText('Get set up');
    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => within(s).getByText(/^(Add your website|Connect your CRM|Connect your ad accounts|Receive your first sale)$/).textContent)).toEqual([
      'Add your website',
      'Connect your CRM',
      'Connect your ad accounts',
      'Receive your first sale',
    ]);
    expect(steps.filter((s) => s.getAttribute('data-state') === 'current')).toHaveLength(1);
    expect(steps[0]!.getAttribute('aria-current')).toBe('step');
    expect(within(steps[0]!).getByRole('link', { name: 'Add website' }).className).toContain('bg-accent');
    expect(within(steps[1]!).getByRole('link', { name: 'Set up Zoho' }).className).not.toContain('bg-accent');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.queryByText('Activity')).toBeNull();
  });

  it('each step leads to the tab where it is done', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => STATS0 });
    show(tenantView());
    await screen.findByText('Get set up');
    expect(href(screen.getByRole('link', { name: 'Add website' }))).toBe('/brand?id=b1&tab=website');
    expect(href(screen.getByRole('link', { name: 'Set up Zoho' }))).toBe('/brand?id=b1&tab=crm');
    expect(href(screen.getByRole('link', { name: 'Connect' }))).toBe('/brand?id=b1&tab=connections');
    expect(href(screen.getByRole('link', { name: 'See sales' }))).toBe('/brand?id=b1&tab=sales');
  });

  it('the guide follows the brand: a website moves it on, and a broken connection becomes the step', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => STATS0 });
    const broken: Connection = { ...active('meta'), status: 'error', lastError: 'meta 400' };
    show(tenantView({ siteKeys: [site], connections: [broken] }));
    await screen.findByText('Get set up');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('Fix your ad account connection')).toBeTruthy();
    expect(screen.getByText('Meta stopped accepting sales.')).toBeTruthy();
  });

  it('once there are sales and everything is connected, the guide is gone and the numbers show', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats({ sales: 3 }) });
    show();
    await screen.findByText('Activity');
    expect(screen.queryByText('Get set up')).toBeNull();
    expect(screen.getByText('Sales received')).toBeTruthy();
  });

  it('a brand with sales still sees the guide while it is unfinished, with the numbers under it', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats({ sales: 3 }) });
    show(tenantView());
    await screen.findByText('Activity');
    expect(screen.getByText('Get set up')).toBeTruthy();
  });
});

describe('Overview: what needs attention', () => {
  it('says nothing when everything is fine', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats({ deliveries: { meta: { sent: 5 } } }) });
    show();
    await screen.findByText('Activity');
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
  });

  it('a broken connection comes first, above the setup guide, with a link to fix it', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats() });
    const broken: Connection = { ...active('meta'), status: 'error', lastError: 'meta 400 code 190: Invalid OAuth access token' };
    const { container } = show(doneView({ connections: [broken, active('google_ads')] }));
    const card = await screen.findByRole('region', { name: 'Needs attention' });
    expect(card.textContent).toContain('Meta stopped accepting sales');
    expect(card.textContent).toContain('Invalid OAuth access token');
    expect(href(within(card).getByRole('link', { name: 'Fix connection' }))).toBe('/brand?id=b1&tab=connections');
    // above everything else, including the setup guide
    const all = Array.from(container.querySelectorAll('section[aria-label="Needs attention"], h2'));
    expect(all[0]).toBe(card);
    expect(screen.getByText('Fix your ad account connection')).toBeTruthy();
  });

  it('failed and rejected sales are counted per platform and link to exactly those sales', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats({ deliveries: { meta: { failed: 2, sent: 3 }, google_ads: { sent: 5 } }, processing: { google_ads: { rejected: 1 } } }) });
    show();
    const card = await screen.findByRole('region', { name: 'Needs attention' });
    expect(card.textContent).toContain('2 sales could not be sent to Meta.');
    expect(card.textContent).toContain('Google Ads accepted 1 sale but then rejected it.');
    expect(within(card).getByRole('heading', { name: 'Needs attention (2)' })).toBeTruthy();
    const [metaReview, googleReview] = within(card).getAllByRole('link', { name: 'Review' });
    expect(norm(metaReview!.getAttribute('href'))).toBe('/brand?id=b1&tab=sales&dest=meta&filter=attention');
    expect(norm(googleReview!.getAttribute('href'))).toBe('/brand?id=b1&tab=sales&dest=google_ads&filter=attention');
  });

  it('one problem is worded in the singular', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats({ deliveries: { meta: { failed: 1 } } }) });
    show();
    const card = await screen.findByRole('region', { name: 'Needs attention' });
    expect(card.textContent).toContain('1 sale could not be sent to Meta.');
    expect(within(card).getByRole('heading', { name: 'Needs attention' })).toBeTruthy();
  });

  it('sending being held back is shown as a note without a link', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats() });
    show(doneView({ sending: { allowed: false, reason: 'Sending is paused by an operator (mapping check). Nothing was sent.' } }));
    const card = await screen.findByRole('region', { name: 'Needs attention' });
    expect(card.textContent).toContain('paused by an operator');
    expect(within(card).queryByRole('link')).toBeNull();
  });
});

describe('Overview: the numbers', () => {
  it('shows the headline, how sales were matched, and a card per platform whose counts open the matching sales', async () => {
    mockApi({
      'GET /tenants/b1/stats': () =>
        stats({
          sales: 10,
          matchedToPerson: 4,
          withClickId: 6,
          contactOnly: 3,
          deliveries: { meta: { sent: 3, pending: 1, retry: 1, sending: 1, failed: 0, skipped: 2 }, google_ads: { sent: 5 } },
        }),
    });
    show();
    await screen.findByText('Activity');
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('in the last 30 days')).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy(); // 4 of 10 linked to a website visit
    expect(screen.getByText('Sent or queued with a click ID')).toBeTruthy();
    expect(screen.getByText('Sent or queued on phone and email only')).toBeTruthy();

    const waiting = screen.getAllByText('3 waiting')[0]!; // pending + sending + retry
    expect(href(waiting)).toBe('/brand?id=b1&tab=sales&dest=meta&filter=waiting');
    expect(href(screen.getByText('5 sent'))).toBe('/brand?id=b1&tab=sales&dest=google_ads&filter=sent');
    expect(href(screen.getAllByText('0 failed')[0]!)).toBe('/brand?id=b1&tab=sales&dest=meta&filter=attention');
    expect(href(screen.getByText('2 skipped'))).toBe('/brand?id=b1&tab=sales&dest=meta&filter=skipped');
  });

  it('shows what Google did with accepted requests', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats({ deliveries: { google_ads: { sent: 5 } }, processing: { google_ads: { success: 3, rejected: 1, processing: 1 } } }) });
    show();
    await screen.findByText('Accepted by the platform:');
    expect(screen.getByText('3 processed')).toBeTruthy();
    expect(screen.getByText('1 being processed')).toBeTruthy();
    expect(screen.getByText('1 rejected')).toBeTruthy();
  });

  it('lists why sales were not sent, or says nothing was skipped', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => stats({ skipReasons: { meta: { no_consent: 4, too_old: 1 } } }) });
    const { unmount } = show();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('No consent to share')).toBeTruthy();
    expect(within(table).getByText('Too old for the platform')).toBeTruthy();
    expect(within(table).getByText('4')).toBeTruthy();
    unmount();

    mockApi({ 'GET /tenants/b1/stats': () => stats() });
    show();
    expect(await screen.findByText('Nothing was skipped in this period.')).toBeTruthy();
  });

  it('another period loads its numbers and says which period they cover', async () => {
    const calls = mockApi({
      'GET /tenants/b1/stats?days=30': () => stats({ sales: 30 }),
      'GET /tenants/b1/stats?days=7': () => stats({ sales: 7 }),
    });
    show();
    await screen.findByText('30');
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Period' }), '7');
    await waitFor(() => expect(screen.getByText('in the last 7 days')).toBeTruthy());
    expect(screen.getByText('7')).toBeTruthy();
    // (the scheduler notice also asks for /sending; that is not what this test is about)
    expect(calls.map((c) => c.key).filter((k) => k.includes('/stats'))).toEqual(['GET /tenants/b1/stats?days=30', 'GET /tenants/b1/stats?days=7']);
  });

  it('says so when the numbers cannot be loaded', async () => {
    mockApi({ 'GET /tenants/b1/stats': () => ({ __status: 500, error: 'boom', message: 'Could not load' }) });
    show();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
  });
});
