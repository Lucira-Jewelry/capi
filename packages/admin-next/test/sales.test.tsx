// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sales } from '@/tabs/Sales';
import type { SaleSummary } from '@/lib/types';
import { meta, mockApi, renderWithApp, tenantView } from './helpers';

let params = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => params }));

beforeEach(() => {
  params = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sale = (saleKey: string, eventId: string, channel: string, deliveries: SaleSummary['deliveries'], extra: Partial<SaleSummary['sale']> = {}): SaleSummary => ({
  saleKey,
  sale: { eventId, eventName: 'Purchase', channel, occurredAt: '2026-10-08T10:00:00Z', personId: null, source: 'zoho', value: 100, currency: 'INR', ...extra },
  deliveries,
});
const SALES: SaleSummary[] = [
  sale('k1', 'INV-1', 'store', [{ destination: 'meta', status: 'failed', attempts: 6, lastError: 'meta 400' }, { destination: 'google_ads', status: 'sent', attempts: 1 }], { storeName: 'Pune' }),
  sale('k2', 'INV-2', 'store', [{ destination: 'meta', status: 'sent', attempts: 1 }, { destination: 'google_ads', status: 'sent', attempts: 1, processingStatus: 'rejected', processingDetail: 'rejected: bad id x1' }], { storeName: 'Mumbai' }),
  sale('k3', 'INV-3', 'whatsapp', [{ destination: 'meta', status: 'pending', attempts: 0 }, { destination: 'google_ads', status: 'retry', attempts: 0, lastError: 'not_connected: no account connected for this destination' }]),
  sale('k4', 'INV-4', 'store', [{ destination: 'meta', status: 'skipped', skipReason: 'no_consent', attempts: 0 }, { destination: 'google_ads', status: 'skipped', skipReason: 'no_consent', attempts: 0 }]),
];

const show = (view = tenantView(), routes: Parameters<typeof mockApi>[0] = {}) => {
  const calls = mockApi({ 'GET /tenants/b1/sales': () => ({ sales: SALES }), ...routes });
  const reload = vi.fn(async () => {});
  renderWithApp(<Sales id="b1" view={view} meta={meta} reload={reload} />);
  return { calls, reload };
};
const ids = () => screen.queryAllByText(/^INV-\d$/).map((e) => e.textContent);
const seg = (label: string) => within(screen.getByRole('group', { name: 'Filter sales by what happened' })).getByRole('button', { name: new RegExp(`^${label}`) });
const counts = () => Object.fromEntries(Array.from(screen.getByRole('group', { name: 'Filter sales by what happened' }).querySelectorAll('button')).map((b) => [b.firstChild!.textContent!.trim(), Number(b.querySelector('span')!.textContent)]));

describe('Sales: finding the sales that matter', () => {
  it('shows how many sales are in each group, and starts with all of them', async () => {
    show();
    await screen.findByText('INV-1');
    expect(ids()).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4']);
    // INV-3 only waits for a connection: that is "waiting", not "needs attention"
    expect(counts()).toEqual({ All: 4, 'Needs attention': 2, Waiting: 1, Sent: 2, Skipped: 1 });
  });

  it('a group narrows the table, and says which one is chosen', async () => {
    show();
    await screen.findByText('INV-1');
    const user = userEvent.setup();
    await user.click(seg('Needs attention'));
    expect(ids()).toEqual(['INV-1', 'INV-2']); // a failure, and a platform rejection after acceptance
    expect(seg('Needs attention')).toHaveAttribute('aria-pressed', 'true');
    expect(seg('All')).toHaveAttribute('aria-pressed', 'false');
    await user.click(seg('Waiting'));
    expect(ids()).toEqual(['INV-3']);
    await user.click(seg('Skipped'));
    expect(ids()).toEqual(['INV-4']);
  });

  it('searching by sale ID or store narrows the list without losing the cursor', async () => {
    show();
    await screen.findByText('INV-1');
    const box = screen.getByRole('searchbox', { name: 'Search sales' });
    const user = userEvent.setup();
    await user.type(box, 'mumbai');
    expect(ids()).toEqual(['INV-2']);
    expect(box).toHaveFocus(); // the same box, still focused
    await user.clear(box);
    await user.type(box, 'inv-3');
    expect(ids()).toEqual(['INV-3']);
    expect(counts().All).toBe(1);
  });

  it('opened from an Overview count, a platform filter shows only that platform and can be removed', async () => {
    params = new URLSearchParams('filter=attention&dest=meta');
    show();
    await screen.findByText('INV-1');
    expect(ids()).toEqual(['INV-1']);
    expect(seg('Needs attention')).toHaveAttribute('aria-pressed', 'true');
    const row = screen.getByText('INV-1').closest('tr')!;
    expect(within(row).queryByText('Google Ads')).toBeNull(); // only Meta's chip
    await userEvent.setup().click(screen.getByRole('button', { name: /Only Meta/ }));
    expect(within(screen.getByText('INV-1').closest('tr')!).getByText('Google Ads')).toBeTruthy();
  });

  it('an unknown filter in the address is ignored', async () => {
    params = new URLSearchParams('filter=nonsense&dest=tiktok');
    show();
    await screen.findByText('INV-1');
    expect(ids()).toHaveLength(4);
  });

  it('says so when nothing matches, and clears the filters', async () => {
    show();
    await screen.findByText('INV-1');
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search sales' }), 'zzz');
    expect(screen.getByText('No sales match')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(ids()).toHaveLength(4);
  });

  it('with no sales it offers the import', async () => {
    show(tenantView(), { 'GET /tenants/b1/sales': () => ({ sales: [] }) });
    expect(await screen.findByText('No sales yet')).toBeTruthy();
  });
});

describe('Sales: details, preview and resend', () => {
  it('shows each platform with the reason, and a waiting delivery says to connect the account', async () => {
    show();
    const user = userEvent.setup();
    await screen.findByText('INV-3');
    await user.click(within(screen.getByText('INV-3').closest('tr')!).getByRole('button', { name: 'Details' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Waiting: connect this account under Ad accounts/)).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: 'Preview what is sent' })).toHaveLength(2);
  });

  it('a Google rejection after acceptance is spelled out', async () => {
    show();
    const user = userEvent.setup();
    await screen.findByText('INV-2');
    await user.click(within(screen.getByText('INV-2').closest('tr')!).getByRole('button', { name: 'Details' }));
    expect(within(screen.getByRole('dialog')).getByText('Rejected by Google: bad id x1')).toBeTruthy();
  });

  it('previews what would be sent, without sending', async () => {
    const { calls } = show(tenantView(), { 'GET /tenants/b1/sales/k1/deliveries/meta/preview': () => ({ url: 'https://graph.facebook.com/v1/1/events', body: { data: [{ event_name: 'Purchase' }] }, notes: ['Test code is set'] }) });
    const user = userEvent.setup();
    await screen.findByText('INV-1');
    await user.click(within(screen.getByText('INV-1').closest('tr')!).getByRole('button', { name: 'Details' }));
    await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Preview what is sent' })[0]!);
    expect(await screen.findByText('What would be sent to Meta')).toBeTruthy();
    expect(screen.getByText('Test code is set')).toBeTruthy();
    expect(screen.getByText(/"event_name": "Purchase"/)).toBeTruthy();
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });

  it('a failed delivery is sent again straight away; one that was sent asks first', async () => {
    const { calls } = show(tenantView(), { 'POST /tenants/b1/sales/k1/deliveries/meta/resend': () => ({}), 'POST /tenants/b1/sales/k1/deliveries/google_ads/resend': () => ({}) });
    const user = userEvent.setup();
    await screen.findByText('INV-1');
    await user.click(within(screen.getByText('INV-1').closest('tr')!).getByRole('button', { name: 'Details' }));
    const dialog = screen.getByRole('dialog');
    const again = within(dialog).getAllByRole('button', { name: 'Send again' });
    await user.click(again[1]!); // Google: already sent
    expect(calls.filter((c) => c.key.startsWith('POST'))).toEqual([]); // asked first
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((c) => c.key.startsWith('POST'))).toEqual([]);
    await user.click(within(dialog).getAllByRole('button', { name: 'Send again' })[0]!); // Meta: failed
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /tenants/b1/sales/k1/deliveries/meta/resend')).toBe(true));
  });
});

describe('Sales: sending now', () => {
  it('reports what the run did and reloads the list', async () => {
    const { calls } = show(tenantView(), { 'POST /tenants/b1/dispatch': () => ({ considered: 2, sent: 1, retried: 0, failed: 1, notConnected: 0 }) });
    await screen.findByText('INV-1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send waiting sales now' }));
    expect(await screen.findByText('Sent 1, will retry 0, failed 1.')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.key === 'GET /tenants/b1/sales?limit=100')).toHaveLength(2));
  });

  it('says why when the server holds sending back', async () => {
    show(tenantView(), { 'POST /tenants/b1/dispatch': () => ({ considered: 0, sent: 0, retried: 0, failed: 0, notConnected: 0, blocked: 3, blockedReason: 'Sending to Meta is switched off for this brand.' }) });
    await screen.findByText('INV-1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send waiting sales now' }));
    expect(await screen.findByText('Sending to Meta is switched off for this brand.')).toBeTruthy();
  });

  it('when the server may not send, the button is off and the reason is shown', async () => {
    show(tenantView({ sending: { allowed: false, reason: 'Sending is switched off on this server (OUTBOUND_SENDS is not "on").' } }));
    await screen.findByText('INV-1');
    expect(screen.getByRole('button', { name: 'Send waiting sales now' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('OUTBOUND_SENDS');
  });
});

describe('importing sales needs a passing check of the current file', () => {
  const SUMMARY = { rows: 3, newSales: 2, alreadyImported: 1, withContact: 2, withoutContact: 1, consent: { yes: 1, no: 0, notStated: 2 }, withName: 1, withPostalCode: 0, value: { INR: 1300 }, firstDate: '2026-10-07', lastDate: '2026-10-08' };
  let clean = true;
  const posted: Array<Record<string, unknown>> = [];

  const open = async () => {
    posted.length = 0;
    const out = show(tenantView(), {
      'POST /tenants/b1/import': (body) => {
        const b = body as Record<string, unknown>;
        posted.push(b);
        if (b.dryRun) {
          return clean
            ? { dryRun: true, counts: { recorded: 0, duplicate: 0, invalid: 0, error: 0 }, results: [{ line: 2, status: 'valid' }], summary: SUMMARY, checkToken: 'tok-1' }
            : { dryRun: true, counts: { recorded: 0, duplicate: 0, invalid: 1, error: 0 }, results: [{ line: 2, status: 'invalid', error: 'channel must be one of: store' }] };
        }
        return { dryRun: false, counts: { recorded: 2, duplicate: 1, invalid: 0, error: 0 }, results: [] };
      },
    });
    await screen.findByText('INV-1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Import sales' }));
    return { user, ...out };
  };
  const submitBtn = () => within(screen.getByRole('dialog')).getAllByRole('button').find((b) => (b as HTMLButtonElement).type === 'submit') as HTMLButtonElement;

  it('starts as "Check file", imports nothing on the first press, and shows a summary', async () => {
    clean = true;
    const { user } = await open();
    expect(submitBtn().textContent).toBe('Check file');
    await user.click(screen.getByLabelText('Or paste the file contents'));
    await user.paste('eventId\nA');
    await user.click(submitBtn());
    await screen.findByText('Ready to import 2 sales.');
    expect(posted.map((p) => p.dryRun)).toEqual([true]);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('1 row is already imported');
    expect(dialog).toHaveTextContent('1 row has no phone or email');
    expect(dialog).toHaveTextContent('Consent: 1 yes, 0 no, 2 not stated.');
    expect(submitBtn().textContent).toBe('Import 2 sales');
  });

  it('the second press imports exactly the checked file, with its check token', async () => {
    clean = true;
    const { user, reload } = await open();
    await user.click(screen.getByLabelText('Or paste the file contents'));
    await user.paste('eventId\nA');
    await user.click(submitBtn());
    await screen.findByText('Ready to import 2 sales.');
    await user.click(submitBtn());
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ csv: 'eventId\nA', checkToken: 'tok-1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(reload).toHaveBeenCalled();
  });

  it('changing the file after the check takes the import away until it is checked again', async () => {
    clean = true;
    const { user } = await open();
    const box = screen.getByLabelText('Or paste the file contents');
    await user.click(box);
    await user.paste('eventId\nA');
    await user.click(submitBtn());
    await screen.findByText('Ready to import 2 sales.');
    await user.type(box, '\nB');
    expect(submitBtn().textContent).toBe('Check file');
    expect(screen.queryByText('Ready to import 2 sales.')).toBeNull();
    await user.click(submitBtn());
    await screen.findByText('Ready to import 2 sales.');
    expect(posted.map((p) => p.dryRun)).toEqual([true, true]); // checked again, not imported
  });

  it('a file with problems cannot be imported', async () => {
    clean = false;
    const { user } = await open();
    await user.click(screen.getByLabelText('Or paste the file contents'));
    await user.paste('eventId\nA');
    await user.click(submitBtn());
    expect(await screen.findByText('Line 2: channel must be one of: store')).toBeTruthy();
    expect(submitBtn().textContent).toBe('Check file');
    await user.click(submitBtn());
    await screen.findByText('Line 2: channel must be one of: store');
    expect(posted.every((p) => p.dryRun === true)).toBe(true);
  });

  it('an expired check asks for a new one instead of importing', async () => {
    clean = true;
    const { user, calls } = await open();
    await user.click(screen.getByLabelText('Or paste the file contents'));
    await user.paste('eventId\nA');
    await user.click(submitBtn());
    await screen.findByText('Ready to import 2 sales.');
    // from now on the server says the check is out of date
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'check_outdated' }), { status: 409, headers: { 'content-type': 'application/json' } })));
    await user.click(submitBtn());
    expect(await screen.findByText('The check has expired. Check the file again.')).toBeTruthy();
    expect(submitBtn().textContent).toBe('Check file');
    expect(calls.length).toBeGreaterThan(0);
  });
});
