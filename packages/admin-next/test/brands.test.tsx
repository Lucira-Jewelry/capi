// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/page';
import type { Tenant } from '@/lib/types';
import { meta, mockApi, renderWithApp, tenant } from './helpers';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

beforeEach(() => {
  sessionStorage.setItem('console_token', 't');
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  push.mockReset();
  vi.unstubAllGlobals();
});

const brand = (n: number, over: Partial<Tenant> = {}): Tenant => ({ ...tenant, tenantId: `brand-${n}`, name: `Brand ${n}`, ...over });
const base = { 'GET /me': () => ({ ok: true }), 'GET /meta': () => meta, 'GET /tenants': () => ({ tenants: [tenant] }) };
const open = async (extra: Record<string, (b: unknown) => unknown> = {}) => {
  const calls = mockApi({ ...base, ...extra });
  renderWithApp(<Home />);
  await screen.findByRole('heading', { name: 'Brands' });
  return calls;
};

describe('the sending switch on the brands page', () => {
  it('shows that sending is on, with a button to pause everything', async () => {
    await open({ 'GET /sending': () => ({ enabled: true, paused: false, destinations: ['meta'] }) });
    expect(await screen.findByText('On')).toBeTruthy();
    expect(screen.getByText(/only to Meta/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause all sending' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume sending' })).toBeNull();
  });

  it('pausing asks for an optional reason, then the strip shows it and offers to resume', async () => {
    const calls = await open({
      'GET /sending': () => ({ enabled: true, paused: false }),
      'PUT /sending': (b) => ((b as { paused: boolean }).paused ? { enabled: true, paused: true, reason: 'checking a mapping' } : { enabled: true, paused: false }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pause all sending' }));
    const dialog = screen.getByRole('dialog', { name: 'Pause all sending?' });
    expect(dialog.textContent).toContain('already on its way');
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'checking a mapping');
    await user.click(within(dialog).getByRole('button', { name: 'Pause all sending' }));

    expect(await screen.findByText('Paused for every brand: checking a mapping. Waiting sales go out when you resume.')).toBeTruthy();
    expect(calls.filter((c) => c.key === 'PUT /sending').map((c) => c.body)).toEqual([{ paused: true, reason: 'checking a mapping' }]);
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Resume sending' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause all sending' })).toBeTruthy());
    expect(calls.filter((c) => c.key === 'PUT /sending')[1]!.body).toEqual({ paused: false });
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('cancelling the pause dialog changes nothing', async () => {
    const calls = await open({ 'GET /sending': () => ({ enabled: true, paused: false }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pause all sending' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.key === 'PUT /sending')).toBe(false);
  });

  it('when the server itself is set not to send, it says so and offers no button', async () => {
    await open({ 'GET /sending': () => ({ enabled: false, paused: false }) });
    expect(await screen.findByText(/OUTBOUND_SENDS/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause all sending' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume sending' })).toBeNull();
  });

  it('a server without the switch simply shows no strip', async () => {
    await open();
    expect(await screen.findByText('Brand One')).toBeTruthy();
    expect(screen.queryByText('Sending')).toBeNull();
  });
});

describe('finding a brand', () => {
  const many = Array.from({ length: 60 }, (_, i) => brand(i + 1));

  it('draws the first 50 only, and shows more on request', async () => {
    await open({ 'GET /tenants': () => ({ tenants: many }) });
    await screen.findByText('Brand 1');
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.includes('brand'))).toHaveLength(50);
    expect(screen.getByText('Showing 50 of 60')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show 10 more' }));
    expect(screen.getByText('Brand 60')).toBeTruthy();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('search looks at every brand, not only the drawn ones, and can be cleared', async () => {
    await open({ 'GET /tenants': () => ({ tenants: many }) });
    const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox', { name: 'Search brands' }), 'brand 60');
    expect(screen.getByText('Brand 60')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('1 of 60 brands');
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('No brands match')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Brand 1')).toBeTruthy();
  });

  it('the status filter appears only when there is more than one status, with counts', async () => {
    await open({ 'GET /tenants': () => ({ tenants: [brand(1), brand(2, { status: 'suspended' }), brand(3)] }) });
    const group = await screen.findByRole('group', { name: 'Filter brands by status' });
    expect(within(group).getByRole('button', { name: /All\s*3/ })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(group).getByRole('button', { name: /Suspended\s*1/ }));
    expect(screen.getByText('Brand 2')).toBeTruthy();
    expect(screen.queryByText('Brand 1')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('1 of 3 brands');
    expect(within(group).getByRole('button', { name: /Suspended/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('no filter is shown when every brand has the same status', async () => {
    await open();
    await screen.findByText('Brand One');
    expect(screen.queryByRole('group', { name: 'Filter brands by status' })).toBeNull();
  });

  it('an empty list invites the first brand', async () => {
    await open({ 'GET /tenants': () => ({ tenants: [] }) });
    expect(await screen.findByText('No brands yet')).toBeTruthy();
  });
});

describe('the new brand dialog', () => {
  const created = {
    tenant: { ...tenant, tenantId: 'acme-1', name: 'Acme' },
    siteKeys: [{ key: `pk_${'b'.repeat(24)}`, origins: ['https://www.acme.com'], snippet: '<script src="/tracker.js"></script>', gtmSnippet: '(function(){gtm})()' }],
    connections: [],
    webhooks: { zoho: 'z', generic: 'g' },
    siteKey: `pk_${'b'.repeat(24)}`,
    webhookSecret: 'whsec_shown_once',
  };

  it('creates the brand with what was typed, then shows the secret and both install options once', async () => {
    const calls = await open({ 'POST /tenants': () => created });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New brand' }));
    const dialog = screen.getByRole('dialog', { name: 'New brand' });
    await user.type(within(dialog).getByLabelText('Brand name'), 'Acme');
    await user.type(within(dialog).getByLabelText('Website address(es)'), 'https://www.acme.com, https://shop.acme.com');
    await user.click(within(dialog).getByRole('button', { name: 'Create brand' }));

    const ready = await screen.findByRole('dialog', { name: 'Acme is ready' });
    expect(calls.find((c) => c.key === 'POST /tenants')!.body).toEqual({
      name: 'Acme',
      origins: ['https://www.acme.com', 'https://shop.acme.com'],
      trackingHost: '',
      consentMode: 'opt_in',
      defaultCountry: 'IN',
      allowedChannels: ['store', 'whatsapp'],
      destinations: ['meta', 'google_ads'],
      retentionDays: 90,
      zoho: true,
    });
    expect(within(ready).getByDisplayValue('whsec_shown_once')).toBeTruthy();
    expect(within(ready).getByText('Google Tag Manager')).toBeTruthy();
    expect(within(ready).getByText('Direct website installation')).toBeTruthy();
    expect(within(ready).getByDisplayValue('<script src="/tracker.js"></script>')).toBeTruthy();

    await user.click(within(ready).getByRole('button', { name: 'Open brand' }));
    expect(push).toHaveBeenCalledWith('/brand/?id=acme-1');
  });

  it('channels and platforms can be changed before creating', async () => {
    const calls = await open({ 'POST /tenants': () => created });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New brand' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Brand name'), 'Acme');
    await user.click(within(dialog).getByLabelText('Online'));
    await user.click(within(dialog).getByLabelText('Google Ads'));
    await user.click(within(dialog).getByLabelText(/Connect Zoho CRM/));
    await user.selectOptions(within(dialog).getByLabelText('Consent policy'), 'opt_out');
    await user.click(within(dialog).getByRole('button', { name: 'Create brand' }));
    await screen.findByRole('dialog', { name: 'Acme is ready' });
    expect(calls.find((c) => c.key === 'POST /tenants')!.body).toMatchObject({ consentMode: 'opt_out', allowedChannels: ['store', 'whatsapp', 'online'], destinations: ['meta'], zoho: false });
  });

  it('a refusal stays in the form, next to what needs fixing, and nothing is created', async () => {
    await open({ 'POST /tenants': () => ({ __status: 400, error: 'invalid_origin', message: 'Website address must start with https://' }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New brand' }));
    const dialog = screen.getByRole('dialog', { name: 'New brand' });
    await user.type(within(dialog).getByLabelText('Brand name'), 'Acme');
    await user.click(within(dialog).getByRole('button', { name: 'Create brand' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('must start with https://');
    expect(screen.getByRole('dialog', { name: 'New brand' })).toBeTruthy();
  });

  it('closing after the brand was created refreshes the list', async () => {
    let n = 0;
    const calls = await open({ 'POST /tenants': () => created, 'GET /tenants': () => ({ tenants: n++ ? [tenant, { ...tenant, tenantId: 'acme-1', name: 'Acme' }] : [tenant] }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New brand' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Brand name'), 'Acme');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create brand' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(calls.filter((c) => c.key === 'GET /tenants')).toHaveLength(2);
  });
});
