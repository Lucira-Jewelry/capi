// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/page';
import { BrandPage } from '@/app/brand/BrandPage';
import { ago, schedulerState } from '@/lib/runs';
import { AdAccounts } from '@/tabs/AdAccounts';
import { Overview } from '@/tabs/Overview';
import { meta, mockApi, renderWithApp, tenant, tenantView } from './helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=b1'),
}));

beforeEach(() => sessionStorage.setItem('console_token', 't'));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const metaConn = (over = {}) => ({ kind: 'meta' as const, status: 'active' as const, secretSet: true, updatedAt: '2026-10-01T00:00:00Z', datasetId: '999', enabled: true, ...over });
const stats = (deliveries: Record<string, Record<string, number>> = {}) => ({ sales: 5, matchedToPerson: 1, byChannel: { store: 5 }, deliveries, skipReasons: {}, withClickId: 0, contactOnly: 5 });

describe('Send test event', () => {
  it('is unavailable until a test code is saved, and says why', () => {
    mockApi({});
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [metaConn()] })} meta={meta} reload={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Send test event' })).toBeDisabled();
    expect(screen.getByText(/add a Test event code/i)).toBeTruthy();
  });

  it('sends one and shows where to look in Events Manager', async () => {
    const calls = mockApi({
      'POST /tenants/b1/connections/meta/test-event': () => ({ ok: true, message: 'Meta received the test event. Look on the Server tab.', datasetId: '999', testEventCode: 'TEST66528', detail: 'events_received=1 trace=T1' }),
    });
    const reload = vi.fn(async () => {});
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [metaConn({ testEventCode: 'TEST66528' })] })} meta={meta} reload={reload} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send test event' }));

    const dialog = await screen.findByRole('dialog', { name: 'Test event sent' });
    expect(dialog).toHaveTextContent('Look on the Server tab');
    expect(dialog).toHaveTextContent('999');
    expect(dialog).toHaveTextContent('TEST66528');
    expect(dialog).toHaveTextContent('events_received=1 trace=T1');
    expect(calls.map((c) => c.key)).toContain('POST /tenants/b1/connections/meta/test-event');
    expect(reload).toHaveBeenCalled();
  });

  it('shows a refusal in plain terms', async () => {
    mockApi({ 'POST /tenants/b1/connections/meta/test-event': () => ({ ok: false, message: 'Invalid OAuth access token', datasetId: '999', testEventCode: 'TEST1' }) });
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [metaConn({ testEventCode: 'TEST1' })] })} meta={meta} reload={async () => {}} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send test event' }));
    expect(await screen.findByRole('dialog', { name: 'Test event not sent' })).toHaveTextContent('Invalid OAuth access token');
  });
});

describe('test mode is hard to miss', () => {
  const brandRoutes = (connections: unknown[]) => ({
    'GET /tenants/b1': () => tenantView({ connections: connections as never }),
    'GET /meta': () => meta,
    'GET /tenants/b1/stats': () => stats(),
    'GET /sending': () => ({ enabled: true, paused: false }),
  });

  it('a banner on every tab while a test code is saved, with the code', async () => {
    mockApi(brandRoutes([metaConn({ testEventCode: 'TEST66528' })]));
    renderWithApp(<BrandPage />);
    const banner = await screen.findByText(/Test mode\./);
    expect(banner.closest('[role=status]')).toHaveTextContent('TEST66528');
    expect(banner.closest('[role=status]')).toHaveTextContent('not live conversions');
  });

  it('and no banner once the test code is gone', async () => {
    mockApi(brandRoutes([metaConn()]));
    renderWithApp(<BrandPage />);
    await screen.findByRole('heading', { name: 'Brand One' });
    expect(screen.queryByText(/Test mode\./)).toBeNull();
  });
});

describe('when sending last ran', () => {
  const home = (lastRun?: unknown) => {
    mockApi({ 'GET /tenants': () => ({ tenants: [tenant] }), 'GET /meta': () => meta, 'GET /sending': () => ({ enabled: true, paused: false, ...(lastRun ? { lastRun } : {}) }) });
    renderWithApp(<Home />);
  };

  it('a recent scheduled run is shown quietly, with what it did', async () => {
    home({ scheduler: { at: minutesAgo(3), considered: 4, sent: 3, retried: 1, failed: 0 } });
    expect(await screen.findByText(/Last scheduled run 3 min ago: 3 sent, 1 to retry, 0 failed/)).toBeTruthy();
  });

  it('a scheduler that never ran is called out, and a manual send does not hide it', async () => {
    home({ console: { at: minutesAgo(2), considered: 1, sent: 1, retried: 0, failed: 0 } });
    const note = await screen.findByText(/scheduler has not run yet/);
    expect(note).toHaveTextContent('POST /internal/dispatch');
    expect(note).toHaveTextContent('A manual send ran 2 min ago');
  });

  it('a scheduler that stopped is called out with how long ago', async () => {
    home({ scheduler: { at: minutesAgo(90), considered: 0, sent: 0, retried: 0, failed: 0 } });
    expect(await screen.findByText(/last scheduled run was 2 h ago/)).toBeTruthy();
  });
});

describe('Overview warns about sales nobody is sending', () => {
  const overview = async (deliveries: Record<string, Record<string, number>>, sending: unknown) => {
    mockApi({ 'GET /tenants/b1/stats': () => stats(deliveries), 'GET /sending': () => sending });
    renderWithApp(<Overview id="b1" view={tenantView()} meta={meta} reload={async () => {}} />);
    await screen.findByText('Sales received');
  };

  it('sales are waiting and the scheduler never ran', async () => {
    await overview({ meta: { pending: 3, retry: 1 } }, { enabled: true, paused: false });
    expect(await screen.findByText(/4 deliveries are waiting to be sent, and nothing is sending them/)).toBeTruthy();
  });

  it('shows the last scheduled run when the scheduler is healthy', async () => {
    await overview({ meta: { sent: 5 } }, { enabled: true, paused: false, lastRun: { scheduler: { at: minutesAgo(2), considered: 3, sent: 2, retried: 1, failed: 0 } } });
    expect(await screen.findByText(/Last scheduled run 2 min ago: 2 sent, 1 to retry, 0 failed/)).toBeTruthy();
  });

  it('stays quiet when nothing is waiting, when the scheduler is alive, or when sending is paused', async () => {
    await overview({ meta: { sent: 5 } }, { enabled: true, paused: false });
    expect(screen.queryByText(/nothing is sending them/)).toBeNull();
    cleanup();
    await overview({ meta: { pending: 2 } }, { enabled: true, paused: false, lastRun: { scheduler: { at: minutesAgo(1), considered: 2, sent: 0, retried: 0, failed: 0 } } });
    await waitFor(() => expect(screen.queryByText(/nothing is sending them/)).toBeNull());
    cleanup();
    await overview({ meta: { pending: 2 } }, { enabled: true, paused: true });
    await waitFor(() => expect(screen.queryByText(/nothing is sending them/)).toBeNull());
  });
});

describe('run helpers', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  it('says how long ago in plain words', () => {
    expect(ago('2026-10-13T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-10-13T11:45:00Z', now)).toBe('15 min ago');
    expect(ago('2026-10-13T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-10-10T12:00:00Z', now)).toBe('3 days ago');
  });
  it('a scheduler is stale after 15 minutes, and a manual run never makes it healthy', () => {
    const run = (min: number) => ({ at: new Date(now.getTime() - min * 60_000).toISOString(), considered: 0, sent: 0, retried: 0, failed: 0 });
    expect(schedulerState({ scheduler: run(2) }, now)).toBe('ok');
    expect(schedulerState({ scheduler: run(16) }, now)).toBe('stale');
    expect(schedulerState({ console: run(1) }, now)).toBe('never');
    expect(schedulerState(undefined, now)).toBe('never');
  });
});
