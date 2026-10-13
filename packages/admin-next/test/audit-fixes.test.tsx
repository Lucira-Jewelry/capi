// @vitest-environment jsdom
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/page';
import { BrandPage } from '@/app/brand/BrandPage';
import { useApi } from '@/lib/useApi';
import { meta, mockApi, renderWithApp, tenant, tenantView } from './helpers';

let search = 'id=b1';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  search = 'id=b1';
  sessionStorage.setItem('console_token', 't');
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('a failed settings request is shown, with a way to retry', () => {
  it('on the brand page', async () => {
    let fail = true;
    mockApi({
      'GET /tenants/b1': () => tenantView(),
      'GET /meta': () => (fail ? { __status: 500, error: 'boom', message: 'The server had a problem' } : meta),
      'GET /tenants/b1/stats': () => ({ sales: 0, matchedToPerson: 0, byChannel: {}, deliveries: {}, skipReasons: {}, withClickId: 0, contactOnly: 0 }),
    });
    renderWithApp(<BrandPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem');
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Brand One' })).toBeTruthy();
  });

  it('on the brands page, where New brand stays unavailable until it loads', async () => {
    let fail = true;
    mockApi({
      'GET /tenants': () => ({ tenants: [tenant] }),
      'GET /sending': () => ({ enabled: true, paused: false }),
      'GET /meta': () => (fail ? { __status: 500, error: 'boom', message: 'No answer' } : meta),
    });
    renderWithApp(<Home />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No answer');
    expect(screen.getByRole('button', { name: 'New brand' })).toBeDisabled();
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'New brand' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the new brand dialog', () => {
  it('starts from the safe defaults every time it opens, not from what was left in the last one', async () => {
    mockApi({ 'GET /tenants': () => ({ tenants: [tenant] }), 'GET /sending': () => ({ enabled: true, paused: false }), 'GET /meta': () => meta });
    renderWithApp(<Home />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New brand' }));

    await user.selectOptions(screen.getByLabelText('Consent policy'), 'opt_out');
    await user.type(screen.getByLabelText(/Brand name|Name/), 'Half typed');
    await user.click(screen.getByRole('checkbox', { name: 'Google Ads' })); // switched off
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: 'New brand' }));
    expect(screen.getByLabelText('Consent policy')).toHaveValue('opt_in');
    expect(screen.getByLabelText(/Brand name|Name/)).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Google Ads' })).toBeChecked();
  });
});

describe('a brand address opened while signed out', () => {
  it('asks for the token on that very page, and then shows the brand', async () => {
    sessionStorage.clear();
    mockApi({
      'GET /me': () => ({ ok: true }),
      'GET /tenants/b1': () => tenantView(),
      'GET /meta': () => meta,
      'GET /tenants/b1/stats': () => ({ sales: 0, matchedToPerson: 0, byChannel: {}, deliveries: {}, skipReasons: {}, withClickId: 0, contactOnly: 0 }),
    });
    renderWithApp(<BrandPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Admin token'), 'right');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Brand One' })).toBeTruthy();
  });
});

describe('useApi', () => {
  it('forgets its data when it is switched off, and drops an answer that was still on its way', async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify({ secret: 'brand A' }))); })));
    const { result, rerender } = renderHook(({ path }: { path: string | null }) => useApi<{ secret: string }>(path), { initialProps: { path: '/tenants/a' as string | null } });
    rerender({ path: null }); // signed out, or no brand chosen
    await act(async () => release?.());
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
