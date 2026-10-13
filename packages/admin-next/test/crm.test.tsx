// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crm } from '@/tabs/Crm';
import { meta, mockApi, renderWithApp, tenant, tenantView } from './helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (mapped = false, reload = async () => {}) =>
  renderWithApp(<Crm id="b1" view={tenantView(mapped ? { tenant: { ...tenant, sources: { zoho: meta.defaultZohoMapping } } } : {})} meta={meta} reload={reload} />);

describe('CRM tab', () => {
  it('shows the webhook addresses and whether the field mapping is set up', () => {
    show();
    expect(screen.getByDisplayValue('https://c/zoho')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://c/generic')).toBeInTheDocument();
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up field mapping' })).toBeInTheDocument();
  });

  it('says Saved and offers Edit once a mapping exists', () => {
    show(true);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit field mapping' })).toBeInTheDocument();
  });

  it('fills the mapping with the usual names, saves only what is filled in, and lists as arrays', async () => {
    const calls = mockApi({ 'PUT /tenants/b1/sources/zoho': () => ({}) });
    const reload = vi.fn(async () => {});
    show(false, reload);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Set up field mapping' }));
    expect(screen.getByLabelText('Deal ID field *')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Fill with usual names' }));
    expect(screen.getByLabelText('Deal ID field *')).toHaveValue('id');
    expect(screen.getByLabelText('Values that mean “in store” *')).toHaveValue('Store');
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls[0]!.body).toEqual({ dealId: 'id', amount: 'Amount', occurredAt: 'Closing_Date', phone: 'Phone', channel: 'Channel', storeChannelValues: ['Store'] });
  });

  it('shows the server’s refusal and keeps the dialog open', async () => {
    mockApi({ 'PUT /tenants/b1/sources/zoho': () => ({ __status: 400, error: 'invalid_mapping', message: 'dealId is required' }) });
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Set up field mapping' }));
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(await screen.findByText('dealId is required')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Zoho field mapping' })).toBeInTheDocument();
  });

  it('rotating the secret asks first, then shows the new secret once', async () => {
    const calls = mockApi({ 'POST /tenants/b1/webhook-secret/rotate': () => ({ webhookSecret: 'whsec_new_123' }) });
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create a new secret' }));
    expect(calls).toEqual([]); // nothing until confirmed
    await user.click(screen.getByRole('button', { name: 'Create new secret' }));
    expect(await screen.findByDisplayValue('whsec_new_123')).toBeInTheDocument();
    expect(screen.getByText('New webhook secret (shown once)')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });
});
