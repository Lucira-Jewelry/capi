// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteKey } from '@/lib/types';
import { Website } from '@/tabs/Website';
import { meta, mockApi, renderWithApp, tenantView } from './helpers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const direct = '<script src="https://c/tracker.js" data-key="pk_x" data-endpoint="https://c" async></script>';
const gtm = "<script>\n(function () {\n  var s = document.createElement('script');\n  s.setAttribute('data-key', 'pk_x');\n})();\n</script>";
const site: SiteKey = { key: 'pk_aaaaaaaaaaaaaaaaaaaaaaaa', origins: ['https://www.brand.com'], snippet: direct };

const show = (siteKeys: SiteKey[], reload = async () => {}) => renderWithApp(<Website id="b1" view={tenantView({ siteKeys })} meta={meta} reload={reload} />);

describe('Website tab', () => {
  it('is empty with one button, then lists the site with clear actions', async () => {
    const { unmount } = show([]);
    expect(screen.getByText('No website yet')).toBeInTheDocument();
    expect(document.querySelector('input')).toBeNull(); // no permanent form on the page
    unmount();

    show([site]);
    expect(screen.getByRole('button', { name: 'Install script' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set tracking address' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check setup' })).toBeNull(); // only once there is an own address to check
    expect(screen.getByText('Shared address')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Install script' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('just before </head>');
    expect(within(dialog).getByRole('textbox')).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('adds a website: only the address is asked first, and the list reloads', async () => {
    const calls = mockApi({ 'POST /tenants/b1/site-keys': () => ({ siteKey: 'pk_x' }) });
    const reload = vi.fn(async () => {});
    show([], reload);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '+ Add website' }));
    await user.type(screen.getByLabelText('Website address'), 'https://a.com, https://b.com');
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls).toEqual([{ key: 'POST /tenants/b1/site-keys', body: { origins: ['https://a.com', 'https://b.com'], label: '', trackingHost: '' } }]);
  });

  it('offers Google Tag Manager and direct installation as separate, labelled copy boxes', async () => {
    show([{ ...site, snippet: direct, gtmSnippet: gtm }]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Install script' }));
    const dialog = screen.getByRole('dialog');
    expect(screen.getByText('Google Tag Manager')).toBeInTheDocument();
    expect(screen.getByText('Direct website installation')).toBeInTheDocument();
    const boxes = Array.from(dialog.querySelectorAll('textarea')).map((t) => t.value);
    expect(boxes).toEqual([gtm, direct]);
    for (const text of ['Custom HTML tag', 'Preview and Publish', 'Remove any older tracker tag', 'typeof window.datahash', 'does not prove']) expect(dialog).toHaveTextContent(text);
  });

  it('still works against a server that only sends the plain tag', async () => {
    show([site]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Install script' }));
    expect(screen.queryByText('Google Tag Manager')).toBeNull();
    expect(screen.getByText('Direct website installation')).toBeInTheDocument();
  });

  it('saves a tracking address and shows the DNS record to add', async () => {
    const calls = mockApi({ 'PATCH /tenants/b1/site-keys/pk_aaaaaaaaaaaaaaaaaaaaaaaa': () => ({}) });
    const withHost: SiteKey = { ...site, trackingHost: 'track.brand.com', dns: { type: 'CNAME', name: 'track.brand.com.', short: 'track', target: 'collector.example.com', local: false, ready: true } };
    show([withHost]);
    expect(screen.getByText('Own address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check setup' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Tracking address' }));
    expect(screen.getByText(/ask whoever manages the domain/)).toBeInTheDocument();
    expect(screen.getByText('collector.example.com')).toBeInTheDocument();
    const input = screen.getByLabelText('Address');
    await user.clear(input);
    await user.type(input, 'go.brand.com');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ trackingHost: 'go.brand.com' });
  });

  it('warns when the server does not know its public address, and needs no record for a local name', async () => {
    const { unmount } = show([{ ...site, trackingHost: 'track.brand.com', dns: { type: 'CNAME', name: 'track.brand.com.', short: 'track', target: 'localhost:8787', local: false, ready: false } }]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tracking address' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Set PUBLIC_URL first');
    unmount();
    show([{ ...site, trackingHost: 'x.localhost', dns: { type: 'CNAME', name: 'x.localhost.', short: 'x', target: 'localhost', local: true, ready: true } }]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tracking address' }));
    expect(screen.getByText(/needs no DNS record/)).toBeInTheDocument();
  });

  it('runs the setup check and lists what passed and what needs fixing', async () => {
    mockApi({
      'POST /tenants/b1/site-keys/pk_aaaaaaaaaaaaaaaaaaaaaaaa/check': () => ({
        ok: false,
        checks: [
          { id: 'dns', label: 'Tracking address', status: 'pass', detail: 'Resolves.' },
          { id: 'https', label: 'Secure connection', status: 'fail', detail: 'No certificate.', fix: 'Ask us to add the name.' },
        ],
      }),
    });
    show([{ ...site, trackingHost: 'track.brand.com' }]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check setup' }));
    const dialog = await screen.findByRole('dialog', { name: 'Something needs fixing' });
    expect(within(dialog).getByRole('img', { name: 'passed' })).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'failed' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('What to do: Ask us to add the name.');
  });
});
