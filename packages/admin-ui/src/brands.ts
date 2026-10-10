import { api } from './api';
import { CHANNEL_LABEL, DEST_LABEL, type Meta, type SendOverview, type Tenant, type TenantView } from './types';
import { checkGroup, closeDialog, csvToList, field, h, icon, openDialog, runAction, select, statusBadge, textInput, timeEl, toast } from './dom';
import { formDialog, listRow } from './ui';
import { copyField, installOptions, secretBox } from './widgets';

/** The list of brands, with a search box. */
export function renderBrands(tenants: Tenant[], meta: Meta, onOpen: (id: string) => void, sending?: SendOverview | null): HTMLElement {
  const search = h('input', { type: 'search', class: 'search-input', placeholder: 'Search brands', 'aria-label': 'Search brands', autocomplete: 'off', spellcheck: false });
  const count = h('div', { class: 'muted small', role: 'status' });
  const results = h('div');
  // With many brands only the first page is drawn: a long list is slow to scroll and hard to scan. Search and filters
  // always look at all of them.
  const PAGE = 50;
  let limit = PAGE;
  let statusFilter: 'all' | 'active' | 'suspended' = 'all';
  const statusHost = h('div');
  const mixed = new Set(tenants.map((t) => t.status)).size > 1;

  const drawStatus = () => {
    const n = (st: string) => tenants.filter((t) => t.status === st).length;
    const options: Array<['all' | 'active' | 'suspended', string, number]> = [['all', 'All', tenants.length], ['active', 'Active', n('active')], ['suspended', 'Suspended', n('suspended')]];
    statusHost.replaceChildren(
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': 'Filter brands by status' },
        ...options.map(([key, label, total]) => {
          const b = h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(statusFilter === key) }, label, h('span', { class: 'seg-count' }, String(total)));
          b.addEventListener('click', () => {
            statusFilter = key;
            limit = PAGE;
            drawStatus();
            draw();
          });
          return b;
        }),
      ),
    );
  };

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const matching = tenants.filter((t) => (statusFilter === 'all' || t.status === statusFilter) && (!q || t.name.toLowerCase().includes(q) || t.tenantId.toLowerCase().includes(q)));
    const shown = matching.slice(0, limit);
    count.textContent = q || statusFilter !== 'all' ? `${matching.length} of ${tenants.length} brands` : `${tenants.length} ${tenants.length === 1 ? 'brand' : 'brands'}`;
    if (tenants.length === 0) {
      results.replaceChildren(h('div', { class: 'card empty' }, h('h2', null, 'No brands yet'), h('p', { class: 'muted' }, 'Add your first brand to get a website script, a CRM webhook and ad-account connections.')));
      return;
    }
    if (shown.length === 0) {
      results.replaceChildren(h('div', { class: 'card empty' }, h('h2', null, 'No brands match'), h('p', { class: 'muted' }, search.value.trim() ? `Nothing matches “${search.value.trim()}”.` : 'No brands have this status.'), h('button', { type: 'button', onclick: () => { search.value = ''; statusFilter = 'all'; drawStatus(); draw(); search.focus(); } }, 'Clear filters')));
      return;
    }
    results.replaceChildren(
      h(
        'div',
        { class: 'card table-wrap' },
        h(
          'table',
          { class: 'brands-table' },
          h('thead', null, h('tr', null, ...['Brand', 'Status', 'Consent', 'Reports to', 'Channels', 'Created'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            null,
            ...shown.map((t) =>
              h(
                'tr',
                { class: 'click', onclick: (e: Event) => { if (!(e.target as Element).closest('a')) onOpen(t.tenantId); } },
                h('td', null, h('a', { href: `#/brand/${t.tenantId}/overview` }, t.name), h('div', { class: 'muted small mono' }, t.tenantId)),
                h('td', null, statusBadge(t.status)),
                h('td', null, t.consentPolicy.mode === 'opt_in' ? 'Opt-in' : 'Opt-out'),
                h('td', null, t.destinations.map((d) => DEST_LABEL[d] ?? d).join(', ')),
                h('td', null, t.allowedChannels.map((c) => CHANNEL_LABEL[c] ?? c).join(', ')),
                h('td', { class: 'small nowrap' }, timeEl(t.createdAt)),
              ),
            ),
          ),
        ),
      ),
      ...(matching.length > shown.length
        ? [
            h(
              'div',
              { class: 'row center', style: 'margin-top:14px' },
              h('span', { class: 'muted small' }, `Showing ${shown.length} of ${matching.length}`),
              h('button', { type: 'button', onclick: () => { limit += PAGE; draw(); } }, `Show ${Math.min(PAGE, matching.length - shown.length)} more`),
            ),
          ]
        : []),
    );
  };
  search.addEventListener('input', () => {
    limit = PAGE;
    draw();
  });
  if (mixed) drawStatus();
  draw();

  const newBrand = h('button', { class: 'primary', type: 'button', onclick: () => openDialog(newBrandDialog(meta, onOpen)) }, icon('plus', 15), 'New brand');
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row between' }, h('h1', { tabindex: '-1' }, 'Brands'), newBrand),
    sending ? sendingStrip(sending) : null,
    h('div', { class: 'row between' }, h('div', { class: 'row' }, h('div', { class: 'search-wrap' }, icon('search', 15), search), statusHost), count),
    results,
  );
}

/** The server-wide state of sending, with the operator's pause and resume. */
function sendingStrip(initial: SendOverview): HTMLElement {
  const box = h('div');
  const draw = (s: SendOverview) => {
    const limits = [s.tenants ? `only for ${s.tenants.join(', ')}` : '', s.destinations ? `only to ${s.destinations.map((d) => DEST_LABEL[d] ?? d).join(', ')}` : ''].filter(Boolean).join(', ');
    const badge = h('span', { class: `badge ${!s.enabled ? '' : s.paused ? 'bad' : 'ok'}` }, !s.enabled ? 'Off' : s.paused ? 'Paused' : 'On');
    const sub = !s.enabled
      ? 'This server is set not to send anything (the OUTBOUND_SENDS setting). Sales are collected and wait.'
      : s.paused
        ? `Paused for every brand${s.reason ? `: ${s.reason}` : ''}. Waiting sales go out when you resume.`
        : `Sales are sent to the ad platforms as they come in${limits ? `, ${limits}` : ''}.`;
    const resume = h('button', { class: 'primary', type: 'button' }, 'Resume sending');
    resume.addEventListener(
      'click',
      runAction(resume, async () => {
        draw(await api<SendOverview>('PUT', '/sending', { paused: false }));
        toast('Sending resumed');
      }),
    );
    const pause = h('button', { type: 'button', onclick: () => pauseDialog(draw) }, 'Pause all sending');
    box.replaceChildren(listRow({ title: 'Sending', badge, sub, actions: [!s.enabled ? null : s.paused ? resume : pause] }));
  };
  draw(initial);
  return box;
}

function pauseDialog(onDone: (s: SendOverview) => void) {
  const reason = textInput('', { placeholder: 'e.g. checking a field mapping' });
  formDialog({
    title: 'Pause all sending?',
    lead: 'Every instance checks right before each send, so nothing new starts once this is saved. A send already on its way, or one that had just passed its last check, can still complete. Sales keep being collected and go out when you resume.',
    body: [field('ps-reason', 'Reason (optional)', reason, 'Shown to everyone who opens the console.').wrap],
    submitLabel: 'Pause all sending',
    danger: true,
    onSubmit: async () => {
      onDone(await api<SendOverview>('PUT', '/sending', { paused: true, reason: reason.value }));
      toast('Sending paused');
    },
  });
}

function newBrandDialog(m: Meta, onCreated: (id: string) => void): HTMLDialogElement {
  const dialog = h('dialog', { 'aria-labelledby': 'nb-title' }) as HTMLDialogElement;
  const name = textInput('', { placeholder: 'Acme Jewels' });
  const origins = textInput('', { placeholder: 'https://www.acme.com' });
  const trackingHost = textInput('', { placeholder: 'track.acme.com (optional)' });
  const consent = select([['opt_in', 'Opt-in: only share data customers agreed to (recommended)'], ['opt_out', 'Opt-out: share unless the customer declined']], 'opt_in');
  const country = select(m.countries.map((c) => [c, c]), 'IN');
  const channels = checkGroup('nb-channels', m.channels, ['store', 'whatsapp'], CHANNEL_LABEL);
  const dests = checkGroup('nb-dests', m.destinations, ['meta', 'google_ads'], DEST_LABEL);
  const retention = h('input', { type: 'number', value: 90, min: 1, max: 365 });
  const zoho = h('input', { type: 'checkbox', checked: true });
  const error = h('div', { class: 'alert', hidden: true, role: 'alert' });
  const create = h('button', { class: 'primary', type: 'submit' }, 'Create brand');

  const submit = async (e: Event) => {
    e.preventDefault();
    error.hidden = true;
    await runAction(create, async () => {
      try {
        const created = await api<TenantView & { siteKey: string; webhookSecret: string }>('POST', '/tenants', {
          name: name.value,
          origins: csvToList(origins.value),
          trackingHost: trackingHost.value,
          consentMode: consent.value,
          defaultCountry: country.value,
          allowedChannels: channels.values(),
          destinations: dests.values(),
          retentionDays: Number(retention.value),
          zoho: zoho.checked,
        });
        form.replaceChildren(
          h('h2', { id: 'nb-title' }, `${created.tenant.name} is ready`),
          secretBox('Webhook secret (shown once)', created.webhookSecret, 'Send it as the x-webhook-secret header from your CRM. If you lose it, rotate it from the CRM tab.'),
          h('p', null, 'Put the script on the website:'),
          ...(created.siteKeys[0] ? [installOptions(created.siteKeys[0])] : []),
          h('div', { class: 'row' }, h('button', { class: 'primary', type: 'button', onclick: () => { closeDialog(dialog); onCreated(created.tenant.tenantId); } }, 'Open brand')),
        );
      } catch (err) {
        // Shown in the form, next to what needs fixing, and the cursor goes back to the first field.
        error.textContent = err instanceof Error ? err.message : 'Could not create the brand.';
        error.hidden = false;
        name.focus();
      }
    })();
  };

  const form = h(
    'form',
    { onsubmit: submit },
    h('h2', { id: 'nb-title' }, 'New brand'),
    error,
    field('nb-name', 'Brand name', name).wrap,
    field('nb-origins', 'Website address(es)', origins, 'Where the website script will run, separated by commas. Only these sites can send data.').wrap,
    field('nb-track', 'Tracking address', trackingHost, "The brand's own address that will point at us, for example track.acme.com. Can be added later; leave empty to start with the shared address.").wrap,
    field('nb-consent', 'Consent policy', consent).wrap,
    h('div', { class: 'cols' }, field('nb-country', 'Phone numbers without a country code are from', country).wrap, field('nb-ret', 'Keep customer data for (days)', retention).wrap),
    h('div', { class: 'field' }, h('label', null, 'Report these sales channels'), channels.wrap, h('div', { class: 'hint' }, 'Leave "Online" off if the store platform already reports online sales to the ad platforms, to avoid double counting.')),
    h('div', { class: 'field' }, h('label', null, 'Send to'), dests.wrap),
    h('div', { class: 'field' }, h('label', { style: 'font-weight:400;display:flex;gap:8px;align-items:center' }, zoho, 'Connect Zoho CRM (start from the usual field names)')),
    h('div', { class: 'row dialog-actions' }, h('button', { type: 'button', onclick: () => closeDialog(dialog) }, 'Cancel'), create),
  );
  dialog.append(form);
  // Start typing straight away.
  queueMicrotask(() => name.focus());
  return dialog;
}
