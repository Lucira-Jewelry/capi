// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@/tabs/Settings';
import { meta, mockApi, renderWithApp, tenantView } from './helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (reload = async () => {}) => renderWithApp(<Settings id="b1" view={tenantView()} meta={meta} reload={reload} />);

describe('brand settings', () => {
  it('offers Save only once something changed, then sends every field', async () => {
    const calls = mockApi({ 'PATCH /tenants/b1': () => ({}) });
    const reload = vi.fn(async () => {});
    show(reload);
    const user = userEvent.setup();
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText('Brand name'));
    await user.type(screen.getByLabelText('Brand name'), 'Brand Two');
    expect(screen.getByText('You have unsaved changes.')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Google Ads' })); // stop sending to Google
    await user.click(save);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls).toEqual([
      {
        key: 'PATCH /tenants/b1',
        body: { name: 'Brand Two', consentMode: 'opt_in', defaultCountry: 'IN', allowedChannels: ['store', 'online'], destinations: ['meta'], retentionDays: 90, status: 'active' },
      },
    ]);
    expect(document.querySelector('[role=status]')?.textContent).toBe('Settings saved');
  });

  it('changing back to what was saved turns Save off again', async () => {
    mockApi({});
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'In store' }));
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'In store' }));
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  });
});

describe('erasing a customer', () => {
  const open = async (routes: Record<string, (b: unknown) => unknown> = {}) => {
    const calls = mockApi({ 'POST /tenants/b1/customers/erase': () => ({ found: true, persons: 1, sales: 2, deliveriesCancelled: 3 }), ...routes });
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Erase…' }));
    return { calls, user };
  };
  const toastText = () => document.querySelector('[role=status],[role=alert]')?.textContent;

  it('says what it does and what it cannot do', async () => {
    await open();
    const dialog = screen.getByRole('dialog', { name: 'Erase a customer' });
    expect(dialog.textContent).toContain('cannot be undone');
    expect(dialog.textContent).toContain('Meta or Google is not removed');
    expect(within(dialog).getByRole('button', { name: 'Erase customer data' })).toBeTruthy();
  });

  it('asks for a contact, then asks again before doing anything', async () => {
    const { calls, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Erase customer data' }));
    expect(toastText()).toContain('phone number or an email');
    expect(calls).toEqual([]);

    await user.type(screen.getByLabelText('Phone'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Erase customer data' }));
    expect(screen.getByRole('dialog', { name: 'Erase this customer?' })).toBeTruthy(); // the second question
    expect(calls).toEqual([]);
  });

  it('after confirming it erases and reports what was removed', async () => {
    const { calls, user } = await open();
    await user.type(screen.getByLabelText('Email'), 'priya@example.com');
    await user.click(screen.getByRole('button', { name: 'Erase customer data' }));
    await user.click(screen.getByRole('button', { name: 'Erase' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ phone: '', email: 'priya@example.com' });
    await waitFor(() => expect(toastText()).toBe('Erased: 1 website profile deleted, 2 sales made anonymous, 3 queued sends cancelled.'));
  });

  it('says when more than one phone or email was covered', async () => {
    const { user } = await open({ 'POST /tenants/b1/customers/erase': () => ({ found: true, contactDetails: 2, persons: 0, sales: 1, deliveriesCancelled: 0 }) });
    await user.type(screen.getByLabelText('Phone'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Erase customer data' }));
    await user.click(screen.getByRole('button', { name: 'Erase' }));
    await waitFor(() => expect(toastText()).toBe('Erased: 1 sale made anonymous. Nothing will be sent for any of the 2 phone numbers and emails linked to them.'));
  });

  it('cancelling the second question erases nothing and leaves the form open', async () => {
    const { calls, user } = await open();
    await user.type(screen.getByLabelText('Phone'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Erase customer data' }));
    const confirm = screen.getByRole('dialog', { name: 'Erase this customer?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls).toEqual([]);
    expect(screen.queryByRole('dialog', { name: 'Erase this customer?' })).toBeNull();
    expect(screen.getByLabelText('Phone')).toBeTruthy();
  });

  it('a customer who was never stored is still recorded as not to be sent for', async () => {
    const { user } = await open({ 'POST /tenants/b1/customers/erase': () => ({ found: true, persons: 0, sales: 0, deliveriesCancelled: 0 }) });
    await user.type(screen.getByLabelText('Phone'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Erase customer data' }));
    await user.click(screen.getByRole('button', { name: 'Erase' }));
    await waitFor(() => expect(toastText()).toContain('Nothing will be sent for them'));
  });
});

describe('customer privacy request', () => {
  it('records it and says whether a website profile was found', async () => {
    const calls = mockApi({ 'POST /tenants/b1/consent/withdraw': () => ({ keys: 1, personFound: false }) });
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Record a request' }));
    await user.type(screen.getByLabelText('Phone'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Record request' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ phone: '98765 43210', email: '' });
    await waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toContain('No website profile was found'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
