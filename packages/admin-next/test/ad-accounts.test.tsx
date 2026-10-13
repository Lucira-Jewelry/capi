// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdAccounts } from '@/tabs/AdAccounts';
import { meta, mockApi, renderWithApp, tenantView } from './helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const metaConn = { kind: 'meta' as const, status: 'active' as const, secretSet: true, updatedAt: '2026-10-01T00:00:00Z', datasetId: '123', enabled: true };

describe('Ad accounts', () => {
  it('switching a platform off asks first, then sends the change and reloads', async () => {
    const calls = mockApi({ 'POST /tenants/b1/connections/meta/enabled': () => ({}) });
    const reload = vi.fn(async () => {});
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [metaConn] })} meta={meta} reload={reload} />);

    const user = userEvent.setup();
    const sw = screen.getByRole('switch', { name: 'Sending to Meta' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    expect(calls).toEqual([]); // nothing until confirmed
    await user.click(screen.getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls).toEqual([{ key: 'POST /tenants/b1/connections/meta/enabled', body: { enabled: false } }]);
  });

  it('switching on needs no question, and a platform that is not connected has no switch', async () => {
    const calls = mockApi({ 'POST /tenants/b1/connections/meta/enabled': () => ({}) });
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [{ ...metaConn, enabled: false }] })} meta={meta} reload={async () => {}} />);
    expect(screen.queryByRole('switch', { name: 'Sending to Google Ads' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Sending to Meta' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ enabled: true });
  });

  it('says so when a platform is not chosen for the brand', () => {
    renderWithApp(<AdAccounts id="b1" view={tenantView({ tenant: { ...tenantView().tenant, destinations: ['meta'] } })} meta={meta} reload={async () => {}} />);
    expect(screen.getByText(/Not chosen for this brand/)).toBeTruthy();
  });
});

describe('connecting accounts', () => {
  const toastText = () => document.querySelector('[role=status],[role=alert]')?.textContent;

  it('Connect Meta saves the dataset and token, closes, and reloads', async () => {
    const calls = mockApi({ 'PUT /tenants/b1/connections/meta': () => ({}) });
    const reload = vi.fn(async () => {});
    renderWithApp(<AdAccounts id="b1" view={tenantView()} meta={meta} reload={reload} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]!);
    expect(screen.getByRole('dialog', { name: 'Connect Meta' })).toBeTruthy();
    await user.type(screen.getByLabelText('Dataset ID'), '123');
    await user.type(screen.getByLabelText('Access token'), 'tok');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls).toEqual([{ key: 'PUT /tenants/b1/connections/meta', body: { datasetId: '123', testEventCode: '', accessToken: 'tok' } }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toastText()).toBe('Meta connected');
  });

  it('a failed save keeps the dialog open and says why', async () => {
    mockApi({ 'PUT /tenants/b1/connections/meta': () => ({ __status: 400, error: 'bad', message: 'Dataset ID must be numbers' }) });
    renderWithApp(<AdAccounts id="b1" view={tenantView()} meta={meta} reload={async () => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]!);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(toastText()).toContain('Dataset ID must be numbers'));
    expect(screen.getByRole('dialog', { name: 'Connect Meta' })).toBeTruthy();
  });

  it('editing shows the saved values and a blank token means keep it; the test code field opens when set', async () => {
    const calls = mockApi({ 'PUT /tenants/b1/connections/meta': () => ({}) });
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [{ ...metaConn, testEventCode: 'TEST1' }] })} meta={meta} reload={async () => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Dataset ID')).toHaveValue('123');
    expect(screen.getByLabelText('Access token')).toHaveAttribute('placeholder', 'Saved: leave blank to keep');
    expect(screen.getByLabelText('Test event code')).toHaveValue('TEST1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ datasetId: '123', testEventCode: 'TEST1', accessToken: '' });
  });

  it('Disconnect asks first, then removes the connection', async () => {
    const calls = mockApi({ 'DELETE /tenants/b1/connections/meta': () => ({ ok: true }) });
    const reload = vi.fn(async () => {});
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [metaConn] })} meta={meta} reload={reload} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(calls).toEqual([]);
    await user.click(within(screen.getByRole('dialog', { name: 'Disconnect Meta?' })).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.map((c) => c.key)).toEqual(['DELETE /tenants/b1/connections/meta']);
  });

  const googleMeta = { ...meta, google: { serviceAccountEmail: 'sa@proj.iam.gserviceaccount.com', oauthConfigured: true } };

  it('Google defaults to the service account, shows its email, and sends no token', async () => {
    const calls = mockApi({ 'PUT /tenants/b1/connections/google_ads': () => ({}) });
    renderWithApp(<AdAccounts id="b1" view={tenantView()} meta={googleMeta} reload={async () => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[1]!);
    expect(screen.getByDisplayValue('sa@proj.iam.gserviceaccount.com')).toBeTruthy();
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    await user.type(screen.getByLabelText('Customer ID'), '123-456-7890');
    await user.type(screen.getByLabelText('Conversion action ID'), '555');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ authMethod: 'service_account', customerId: '123-456-7890', loginCustomerId: '', conversionActionId: '555' });
  });

  it('Google with a login asks for the refresh token and sends it', async () => {
    const calls = mockApi({ 'PUT /tenants/b1/connections/google_ads': () => ({}) });
    renderWithApp(<AdAccounts id="b1" view={tenantView()} meta={googleMeta} reload={async () => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[1]!);
    await user.selectOptions(screen.getByLabelText('How should we get access?'), 'oauth');
    expect(screen.queryByDisplayValue('sa@proj.iam.gserviceaccount.com')).toBeNull();
    await user.type(screen.getByLabelText('Customer ID'), '1234567890');
    await user.type(screen.getByLabelText('Conversion action ID'), '5');
    await user.type(screen.getByLabelText('Refresh token'), 'rt');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ authMethod: 'oauth', refreshToken: 'rt' });
  });

  it('without a server service account it says the method will not work', async () => {
    mockApi({});
    renderWithApp(<AdAccounts id="b1" view={tenantView()} meta={meta} reload={async () => {}} />);
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Connect' })[1]!);
    // No key on the server: the dialog starts on the Google login instead.
    expect(screen.getByLabelText('How should we get access?')).toHaveValue('oauth');
    expect(screen.getByText(/OAuth client is not configured/)).toBeTruthy();
  });

  it('Check connection reports the answer; a broken connection shows what to do', async () => {
    mockApi({ 'POST /tenants/b1/connections/google_ads/check': () => ({ ok: false, message: 'Google refused the login' }) });
    const google = { kind: 'google_ads' as const, status: 'error' as const, lastError: 'invalid_grant', secretSet: true, updatedAt: '2026-10-01T00:00:00Z', customerId: '1234567890' };
    renderWithApp(<AdAccounts id="b1" view={tenantView({ connections: [google] })} meta={meta} reload={async () => {}} />);
    expect(screen.getByText(/invalid_grant\./)).toBeTruthy();
    expect(screen.getByText(/press Check connection/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check connection' }));
    await waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toBe('Google refused the login'));
  });
});
