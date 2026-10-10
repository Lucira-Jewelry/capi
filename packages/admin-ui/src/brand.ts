import { ApiError, api } from './api';
import {
  CHANNEL_LABEL,
  DEST_LABEL,
  SKIP_LABEL,
  type Connection,
  type Meta,
  type SaleSummary,
  type SiteKey,
  type Stats,
  type TenantView,
  type ZohoMapping,
} from './types';
import {
  checkGroup,
  clear,
  closeDialog,
  confirmDialog,
  csvToList,
  field,
  fmtDate,
  fmtMoney,
  h,
  icon,
  runAction,
  select,
  skeleton,
  statusBadge,
  textInput,
  ticker,
  timeEl,
  toast,
  type Child,
} from './dom';
import { copyField, installOptions, secretBox } from './widgets';
import { emptyState, formDialog, listRow, more } from './ui';

interface Ctx {
  view: TenantView;
  meta: Meta;
  /** Re-read the brand and redraw the current tab in place: same scroll position, no flash. */
  reload: () => Promise<void>;
}

// In the order a new brand sets things up.
const TABS: Array<[string, string]> = [
  ['overview', 'Overview'],
  ['website', 'Website'],
  ['crm', 'CRM'],
  ['connections', 'Ad accounts'],
  ['sales', 'Sales'],
  ['settings', 'Settings'],
];

type Builder = (c: Ctx) => HTMLElement | Promise<HTMLElement>;
const builderFor = (tab: string): Builder =>
  ({ overview: overviewTab, connections: connectionsTab, website: websiteTab, crm: crmTab, sales: salesTab, settings: settingsTab })[tab as 'overview'] ?? overviewTab;

/** A loading skeleton only appears if something takes longer than this; quick loads never blank the screen. */
const SLOW_MS = 160;

/**
 * The brand page stays on screen while you move between its tabs: only the area under the tabs changes, the old
 * content stays until the new content is ready, and refreshing after a save redraws in place. This is what keeps tab
 * changes from flashing.
 */
interface Frame {
  id: string;
  root: HTMLElement;
  content: HTMLElement;
  tabsEl: HTMLElement;
  nameEl: HTMLElement;
  statusEl: HTMLElement;
  alertEl: HTMLElement;
  ctx: Ctx;
  tab: string;
  /** Counts navigations, so a slow answer for a tab you already left is thrown away. */
  seq: number;
}
let frame: Frame | null = null;

export async function showBrand(view: HTMLElement, id: string, tab: string, loadMeta: () => Promise<Meta>, current: () => boolean): Promise<void> {
  // Import is now a button under Sales, so an old link to it lands there.
  const wanted = TABS.some(([k]) => k === tab) ? tab : tab === 'import' ? 'sales' : 'overview';
  if (frame && frame.id === id && view.contains(frame.root)) {
    await setTab(frame, wanted, {});
    return;
  }
  frame = null;
  const timer = setTimeout(() => {
    if (current()) view.replaceChildren(skeleton('page'));
  }, SLOW_MS);
  let tv: TenantView;
  let meta: Meta;
  try {
    [tv, meta] = await Promise.all([api<TenantView>('GET', `/tenants/${id}`), loadMeta()]);
  } finally {
    clearTimeout(timer);
  }
  if (!current()) return;
  const f = buildFrame(id, tv, meta);
  frame = f;
  view.replaceChildren(f.root);
  window.scrollTo(0, 0);
  f.root.classList.add('enter');
  await setTab(f, wanted, { first: true });
  if (current()) f.nameEl.focus({ preventScroll: true }); // a new page: start reading from its title
}

function buildFrame(id: string, tv: TenantView, meta: Meta): Frame {
  const nameEl = h('h1', { tabindex: '-1' });
  const statusEl = h('div');
  const alertEl = h('div');
  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'Brand sections' }, ...TABS.map(([key, label]) => h('a', { href: `#/brand/${id}/${key}`, 'data-tab': key }, label)));
  const content = h('div', { class: 'brand-content' });
  const root = h(
    'div',
    { class: 'brand-page' },
    h('a', { href: '#/', class: 'back-link' }, icon('back', 14), 'All brands'),
    h('div', { class: 'row between brand-head' }, h('div', null, nameEl, h('div', { class: 'muted small mono' }, tv.tenant.tenantId)), statusEl),
    alertEl,
    tabsEl,
    content,
  );
  const f: Frame = { id, root, content, tabsEl, nameEl, statusEl, alertEl, ctx: { view: tv, meta, reload: () => refresh(f) }, tab: '', seq: 0 };
  paintHeader(f);
  // Highlight the clicked tab at once, before the new content has loaded.
  tabsEl.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a[data-tab]');
    if (a) markTab(f, a.getAttribute('data-tab') ?? '');
  });
  return f;
}

function paintHeader(f: Frame) {
  const t = f.ctx.view.tenant;
  f.nameEl.textContent = t.name;
  f.statusEl.replaceChildren(statusBadge(t.status));
  f.alertEl.replaceChildren(
    ...(t.status === 'suspended' ? [h('div', { class: 'alert', style: 'margin-top:12px' }, 'This brand is suspended: the website script and CRM webhook are refused and nothing is sent.')] : []),
  );
}

function markTab(f: Frame, tab: string) {
  f.tabsEl.querySelectorAll('a[data-tab]').forEach((a) => {
    if (a.getAttribute('data-tab') === tab) {
      a.setAttribute('aria-current', 'page');
      // On a narrow screen the tab bar scrolls sideways: keep the chosen tab in view.
      if (typeof a.scrollIntoView === 'function') a.scrollIntoView({ inline: 'center', block: 'nearest' });
    } else a.removeAttribute('aria-current');
  });
}

async function setTab(f: Frame, tab: string, opts: { first?: boolean; quiet?: boolean }): Promise<void> {
  const seq = ++f.seq;
  f.tab = tab;
  markTab(f, tab);
  document.title = `${f.ctx.view.tenant.name} · ${TABS.find(([k]) => k === tab)?.[1] ?? ''} · Conversions Console`;

  const showSkeleton = () => {
    if (seq === f.seq) f.content.replaceChildren(skeleton('cards'));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.first) showSkeleton();
  else if (!opts.quiet) timer = setTimeout(showSkeleton, SLOW_MS);

  let el: HTMLElement;
  try {
    el = await builderFor(tab)(f.ctx);
  } catch (e) {
    el = h(
      'div',
      { class: 'card' },
      h('div', { class: 'alert' }, e instanceof Error ? e.message : 'Could not load this section.'),
      h('button', { type: 'button', onclick: () => void setTab(f, tab, { first: true }) }, 'Try again'),
    );
  }
  if (timer) clearTimeout(timer);
  if (seq !== f.seq) return; // you already moved on

  const place = opts.quiet ? capturePlace(f.content) : null;
  f.content.replaceChildren(el);
  if (!opts.quiet) {
    el.classList.add('enter-soft');
    // Changing tab from far down the page: bring the tab bar back into view so the new content starts in sight.
    const top = f.tabsEl.getBoundingClientRect().top;
    if (top < 64) window.scrollTo({ top: Math.max(0, window.scrollY + top - 72) });
  }
  if (place) restorePlace(f.content, place);
}

async function refresh(f: Frame): Promise<void> {
  const tv = await api<TenantView>('GET', `/tenants/${f.id}`);
  f.ctx.view = tv;
  paintHeader(f);
  await setTab(f, f.tab, { quiet: true });
}

/** Remember where you were (scroll position and which control had focus) so a redraw does not lose your place. */
function capturePlace(root: HTMLElement) {
  const a = document.activeElement as HTMLElement | null;
  const inside = Boolean(a && a !== document.body && root.contains(a));
  return { y: window.scrollY, had: inside, id: inside ? a!.id : '', tag: inside ? a!.tagName : '', text: inside ? (a!.textContent ?? '').trim() : '' };
}

function restorePlace(root: HTMLElement, p: ReturnType<typeof capturePlace>) {
  window.scrollTo(0, p.y);
  if (!p.had) return;
  let target: HTMLElement | null = p.id ? document.getElementById(p.id) : null;
  if (target && !root.contains(target)) target = null;
  if (!target && p.text) target = (Array.from(root.querySelectorAll(p.tag.toLowerCase())) as HTMLElement[]).find((el) => (el.textContent ?? '').trim() === p.text) ?? null;
  target?.focus({ preventScroll: true });
}

function saveButton(label: string, fn: () => Promise<void>) {
  const btn = h('button', { class: 'primary', type: 'button' }, label);
  btn.addEventListener('click', runAction(btn, fn));
  return btn;
}

const goTo = (c: Ctx, tab: string) => () => {
  location.hash = `#/brand/${c.view.tenant.tenantId}/${tab}`;
};

// ---- sales filters (also set from the Overview, so a click on a count lands on exactly those sales) -------------
type SaleStatusFilter = 'all' | 'attention' | 'waiting' | 'sent' | 'skipped';
interface SalesFilter {
  status?: SaleStatusFilter;
  /** Only look at one platform's deliveries. */
  dest?: string;
}
let salesPreset: SalesFilter | null = null;

const STATUS_FILTERS: Array<[SaleStatusFilter, string]> = [
  ['all', 'All'],
  ['attention', 'Needs attention'],
  ['waiting', 'Waiting'],
  ['sent', 'Sent'],
  ['skipped', 'Skipped'],
];

/** Does one delivery fall under this heading? "Needs attention" is a failure, a platform rejection, or a retry that is not just waiting for a connection. */
function deliveryMatches(d: SaleSummary['deliveries'][number], status: SaleStatusFilter): boolean {
  switch (status) {
    case 'all':
      return true;
    case 'attention':
      return d.status === 'failed' || d.processingStatus === 'partial' || d.processingStatus === 'rejected' || (d.status === 'retry' && Boolean(d.lastError) && !d.lastError!.startsWith('not_connected'));
    case 'waiting':
      return d.status === 'pending' || d.status === 'sending' || d.status === 'retry';
    case 'sent':
      return d.status === 'sent';
    case 'skipped':
      return d.status === 'skipped';
  }
}

function saleMatches(s: SaleSummary, status: SaleStatusFilter, dest: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q && !`${s.sale.eventId} ${s.sale.storeName ?? ''}`.toLowerCase().includes(q)) return false;
  const ds = dest ? s.deliveries.filter((d) => d.destination === dest) : s.deliveries;
  return status === 'all' ? ds.length > 0 || !dest : ds.some((d) => deliveryMatches(d, status));
}

function openSales(c: Ctx, preset: SalesFilter) {
  salesPreset = preset;
  goTo(c, 'sales')();
}

// ---- overview -------------------------------------------------------------------------------------------
async function overviewTab(c: Ctx): Promise<HTMLElement> {
  const id = c.view.tenant.tenantId;
  const days = select([['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']], '30');
  const body = h('div', { class: 'stack' });

  const draw = (s: Stats) => {
    const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');
    body.replaceChildren(
      // A bento layout: the headline number, how sales were matched, then one card per platform.
      h(
        'div',
        { class: 'bento' },
        statCard(String(s.sales), 'Sales received', { big: true, span2: true, hint: `in the last ${days.value} days` }),
        h(
          'div',
          { class: 'card stat spot span2' },
          h('div', { class: 'label' }, 'How sales were matched'),
          h(
            'div',
            { class: 'metrics' },
            metric(pct(s.matchedToPerson, s.sales), 'Linked to a website visit'),
            metric(String(s.withClickId), 'Sent or queued with a click ID'),
            metric(String(s.contactOnly), 'Sent or queued on phone and email only'),
          ),
        ),
        ...c.view.tenant.destinations.map((d) => {
          const by = s.deliveries[d] ?? {};
          const waiting = (by.pending ?? 0) + (by.sending ?? 0) + (by.retry ?? 0);
          return h(
            'div',
            { class: 'card spot span2' },
            h('h2', null, DEST_LABEL[d] ?? d),
            h(
              'div',
              { class: 'chips' },
              chipLink(c, d, 'sent', 'ok', `${by.sent ?? 0} sent`),
              chipLink(c, d, 'waiting', 'warn', `${waiting} waiting`),
              chipLink(c, d, 'attention', 'bad', `${by.failed ?? 0} failed`),
              chipLink(c, d, 'skipped', '', `${by.skipped ?? 0} skipped`),
            ),
            processingChips(s.processing?.[d]),
          );
        }),
      ),
      skipTable(s),
    );
  };
  const load = async () => {
    // Keep the old numbers on screen (dimmed) while new ones load, instead of blanking the page.
    body.classList.add('refreshing');
    try {
      draw(await api<Stats>('GET', `/tenants/${id}/stats?days=${days.value}`));
    } finally {
      body.classList.remove('refreshing');
    }
  };
  days.addEventListener('change', () => load().catch((e) => toast(e.message, true)));

  const first = await api<Stats>('GET', `/tenants/${id}/stats?days=30`);
  const guide = setupGuide(c, first.sales);
  const out = h('div', { class: 'stack' });
  const attention = attentionCard(c, first);
  if (attention) out.append(attention);
  if (guide) out.append(guide);
  // A new brand sees only what to do next; the numbers appear once there is something to count.
  if (!guide || first.sales > 0) {
    draw(first);
    out.append(h('div', { class: 'row between' }, h('h2', { style: 'font-size:1.25rem' }, 'Activity'), h('div', { style: 'min-width:160px' }, days)), body);
  }
  return out;
}

/** A count that opens the Sales tab showing exactly those sales. */
function chipLink(c: Ctx, dest: string, status: SaleStatusFilter, kind: string, text: string): HTMLElement {
  const btn = h('button', { type: 'button', class: `badge chip-link ${kind}`.trim(), title: 'Show these sales' }, text);
  btn.addEventListener('click', () => openSales(c, { status, dest }));
  return btn;
}

/**
 * Things that need a person right now, found from what the console already knows: a connection that stopped working,
 * sales that failed or were rejected after being accepted, and sending being held back. Shown on top of the Overview,
 * and gone when there is nothing to do.
 */
function attentionCard(c: Ctx, s: Stats): HTMLElement | null {
  const items: Array<{ tone: 'bad' | 'warn'; text: string; label?: string; go?: () => void }> = [];
  for (const conn of c.view.connections) {
    if (conn.status !== 'error') continue;
    const name = DEST_LABEL[conn.kind] ?? conn.kind;
    items.push({ tone: 'bad', text: `${name} stopped accepting sales: ${(conn.lastError ?? 'unknown error').slice(0, 140)}`, label: 'Fix connection', go: goTo(c, 'connections') });
  }
  for (const d of c.view.tenant.destinations) {
    const failed = s.deliveries[d]?.failed ?? 0;
    const rejected = (s.processing?.[d]?.rejected ?? 0) + (s.processing?.[d]?.partial ?? 0);
    const name = DEST_LABEL[d] ?? d;
    if (failed > 0) items.push({ tone: 'bad', text: `${failed} ${failed === 1 ? 'sale' : 'sales'} could not be sent to ${name}.`, label: 'Review', go: () => openSales(c, { status: 'attention', dest: d }) });
    if (rejected > 0) items.push({ tone: 'bad', text: `${name} accepted ${rejected} ${rejected === 1 ? 'sale' : 'sales'} but then rejected ${rejected === 1 ? 'it' : 'them'}.`, label: 'Review', go: () => openSales(c, { status: 'attention', dest: d }) });
  }
  const sending = c.view.sending;
  if (sending && !sending.allowed) items.push({ tone: 'warn', text: sending.reason ?? 'Sending is switched off on this server.' });
  if (items.length === 0) return null;
  return h(
    'div',
    { class: 'card attention', role: 'region', 'aria-label': 'Needs attention' },
    h('h2', null, items.length === 1 ? 'Needs attention' : `Needs attention (${items.length})`),
    h(
      'ul',
      { class: 'attention-list' },
      ...items.map((i) =>
        h('li', { class: i.tone }, h('span', { class: 'attention-icon', 'aria-hidden': 'true' }, icon('alert', 16)), h('span', { class: 'attention-text' }, i.text), i.go ? h('button', { type: 'button', onclick: i.go }, i.label ?? 'Open') : null),
      ),
    ),
  );
}

/** What Google did with requests it accepted: processed, still processing, or rejected afterwards. */
function processingChips(p: Record<string, number> | undefined): HTMLElement | null {
  if (!p) return null;
  const chips: Array<[string, string, string]> = [
    ['success', 'ok', 'processed'],
    ['processing', 'warn', 'being processed'],
    ['partial', 'bad', 'partly rejected'],
    ['rejected', 'bad', 'rejected'],
    ['unknown', '', 'no result'],
  ];
  const shown = chips.filter(([k]) => (p[k] ?? 0) > 0);
  if (shown.length === 0) return null;
  return h('div', { class: 'row small', style: 'margin-top:8px' }, h('span', { class: 'muted' }, 'Accepted by the platform:'), ...shown.map(([k, kind, label]) => h('span', { class: `badge ${kind}` }, `${p[k]} ${label}`)));
}

/** A number that counts up, with its label. `big` is the headline figure. */
function statCard(value: string, label: string, opts: { big?: boolean; span2?: boolean; hint?: string } = {}): HTMLElement {
  const v = h('div', { class: 'value' });
  ticker(v, value);
  return h(
    'div',
    { class: `card stat spot${opts.big ? ' big' : ''}${opts.span2 ? ' span2' : ''}` },
    h('div', { class: 'label' }, label),
    v,
    opts.hint ? h('div', { class: 'hint-line' }, opts.hint) : null,
  );
}

function metric(value: string, label: string): HTMLElement {
  const v = h('div', { class: 'value' });
  ticker(v, value);
  return h('div', null, v, h('div', { class: 'label' }, label));
}

function skipTable(s: Stats): HTMLElement {
  const rows = Object.entries(s.skipReasons).flatMap(([dest, reasons]) => Object.entries(reasons).map(([reason, n]) => [dest, reason, n] as const));
  if (rows.length === 0) return h('div', { class: 'note' }, 'Nothing was skipped in this period.');
  return h(
    'div',
    { class: 'card table-wrap' },
    h('h2', null, 'Why sales were not sent'),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, ...['Destination', 'Reason', 'Sales'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, ...rows.map(([d, r, n]) => h('tr', null, h('td', null, DEST_LABEL[d] ?? d), h('td', null, SKIP_LABEL[r] ?? r), h('td', null, String(n))))),
    ),
  );
}

/** The numbered setup steps for a new brand. Only the next step has a strong button. Gone once everything is done. */
function setupGuide(c: Ctx, sales: number): HTMLElement | null {
  const t = c.view.tenant;
  const connected = (k: string) => c.view.connections.some((x) => x.kind === k && x.status === 'active');
  const adNames = t.destinations.map((d) => DEST_LABEL[d] ?? d).join(' and ');
  const broken = c.view.connections.filter((x) => x.status === 'error');
  const steps: Array<{ done: boolean; title: string; hint: string; label: string; go: () => void }> = [
    { done: c.view.siteKeys.length > 0, title: 'Add your website', hint: 'So we can see which ad brought each visitor.', label: 'Add website', go: () => addSiteDialog(c) },
    { done: Boolean(t.sources.zoho), title: 'Connect your CRM', hint: 'Zoho tells us when a sale is made.', label: 'Set up Zoho', go: goTo(c, 'crm') },
    broken.length
      ? { done: false, title: 'Fix your ad account connection', hint: `${broken.map((x) => DEST_LABEL[x.kind] ?? x.kind).join(' and ')} stopped accepting sales.`, label: 'Fix', go: goTo(c, 'connections') }
      : { done: t.destinations.every((d) => connected(d)), title: 'Connect your ad accounts', hint: adNames ? `Sales are sent to ${adNames}.` : 'Choose where sales are sent.', label: 'Connect', go: goTo(c, 'connections') },
    { done: sales > 0, title: 'Receive your first sale', hint: 'It shows up under Sales soon after a deal is won.', label: 'See sales', go: goTo(c, 'sales') },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  const currentIdx = steps.findIndex((s) => !s.done);
  const items = steps.map((s, i) => {
    const state = s.done ? 'done' : i === currentIdx ? 'current' : 'next';
    const btn = s.done ? null : h('button', { type: 'button', class: state === 'current' ? 'primary' : '', onclick: s.go }, s.label);
    return h(
      'li',
      { class: `step ${state}`, ...(state === 'current' ? { 'aria-current': 'step' } : {}) },
      h('span', { class: 'step-num', 'aria-hidden': 'true' }, s.done ? icon('check', 14) : String(i + 1)),
      h('div', { class: 'step-text' }, h('div', { class: 'step-title' }, s.title, s.done ? h('span', { class: 'sr-only' }, ' (done)') : null), s.done ? null : h('div', { class: 'step-hint' }, s.hint)),
      btn,
    );
  });
  return h(
    'div',
    { class: 'card spot beam' },
    h('div', { class: 'row between' }, h('h2', null, 'Get set up'), h('span', { class: 'muted small' }, `${doneCount} of ${steps.length} done`)),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(steps.length), 'aria-valuenow': String(doneCount) }, h('span', { style: `width:${(doneCount / steps.length) * 100}%` })),
    h('ol', { class: 'steps' }, ...items),
  );
}

// ---- website --------------------------------------------------------------------------------------------
function websiteTab(c: Ctx): HTMLElement {
  const add = h('button', { class: 'primary', type: 'button', onclick: () => addSiteDialog(c) }, icon('plus', 15), 'Add website');
  const head = h('div', { class: 'row between' }, h('h2', null, 'Websites'), c.view.siteKeys.length ? add : null);
  const intro = h('p', { class: 'muted' }, 'A small script on the website saves which ad brought each visitor, so a later sale can be matched back to it.');
  if (c.view.siteKeys.length === 0) return h('div', { class: 'stack' }, head, emptyState('No website yet', 'Add the website where customers visit. You will get one script to paste on it.', add));
  return h('div', { class: 'stack' }, head, intro, ...c.view.siteKeys.map((k) => siteRow(c, k)));
}

function siteRow(c: Ctx, k: SiteKey): HTMLElement {
  const install = h('button', { class: 'primary', type: 'button', onclick: () => installDialog(k) }, 'Install script');
  const tracking = h('button', { type: 'button', onclick: () => trackingDialog(c, k) }, k.trackingHost ? 'Tracking address' : 'Set tracking address');
  const check = h('button', { type: 'button' }, 'Check setup');
  check.addEventListener('click', runAction(check, () => runSetupCheck(c.view.tenant.tenantId, k)));
  return listRow({
    title: k.origins.length ? k.origins.join(', ') : 'Any site (development only)',
    badge: k.trackingHost ? h('span', { class: 'badge ok' }, 'Own address') : h('span', { class: 'badge' }, 'Shared address'),
    sub: k.trackingHost ? `Tracking address: ${k.trackingHost}` : 'Using our shared tracking address. Works, but browsers treat it as third-party.',
    actions: [install, tracking, k.trackingHost ? check : null],
  });
}

function addSiteDialog(c: Ctx) {
  const id = c.view.tenant.tenantId;
  const origins = textInput('', { placeholder: 'https://www.brand.com' });
  const label = textInput('', { placeholder: 'e.g. Main site' });
  const host = textInput('', { placeholder: 'track.brand.com' });
  formDialog({
    title: 'Add website',
    lead: 'Only these websites will be allowed to send us data.',
    body: [
      field('sk-o', 'Website address', origins, 'For several, separate them with commas.').wrap,
      more('Optional: name and tracking address', field('sk-l', 'Name', label).wrap, field('sk-t', 'Tracking address', host, 'The brand’s own address like track.brand.com. You can add it later.').wrap),
    ],
    submitLabel: 'Add website',
    onSubmit: async () => {
      await api('POST', `/tenants/${id}/site-keys`, { origins: csvToList(origins.value), label: label.value, trackingHost: host.value });
      toast('Website added');
      void c.reload();
    },
  });
}

function installDialog(k: SiteKey) {
  formDialog({
    title: 'Install the script',
    lead: 'Choose how this website is set up. Nothing else on the site needs to change.',
    wide: true,
    body: [
      installOptions(k),
      more(
        'Does the website have a cookie banner?',
        h('p', { class: 'muted small' }, 'Tell the script when the visitor agrees or declines, so nothing is stored or sent without consent:'),
        h('pre', { class: 'code-block' }, "// from your cookie banner\nwindow.datahash.setConsent(true);   // or false\n\n// or let the script ask the banner\nwindow.datahashConsent = () => 'granted'; // 'denied' | 'unknown'"),
      ),
    ],
    submitLabel: 'Done',
    closeOnly: true,
    onSubmit: async () => {},
  });
}

function trackingDialog(c: Ctx, k: SiteKey) {
  const tenantId = c.view.tenant.tenantId;
  const host = textInput(k.trackingHost ?? '', { placeholder: 'track.brand.com' });
  formDialog({
    title: 'Tracking address',
    lead: 'Optional. The brand’s own address (like track.brand.com) makes browsers treat our tracking as part of the brand’s site, so it lasts longer.',
    wide: true,
    body: [field(`th-${k.key}`, 'Address', host, 'Clear it to go back to the shared address.').wrap, ...(k.trackingHost ? [dnsBlock(k)] : [])],
    submitLabel: 'Save address',
    onSubmit: async () => {
      await api('PATCH', `/tenants/${tenantId}/site-keys/${k.key}`, { trackingHost: host.value });
      toast('Tracking address saved');
      void c.reload();
    },
  });
}

/** What to ask whoever manages the brand's domain: shown once an address is saved, as the next step. */
function dnsBlock(k: SiteKey): HTMLElement {
  const dns = k.dns;
  if (!dns) return h('div', { class: 'note' }, 'Save the address to see the DNS record to add.');
  if (dns.local) return h('div', { class: 'note' }, 'This is a local test name: it needs no DNS record.');
  return h(
    'div',
    { class: 'stack tight' },
    h('div', { class: 'step-title' }, 'Next: ask whoever manages the domain to add this record'),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ...['Type', 'Name', 'Points to'].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', null, h('tr', null, h('td', null, dns.type), h('td', { class: 'mono' }, dns.short), h('td', { class: 'mono' }, dns.target))))),
    h('p', { class: 'small muted' }, `It can take a few minutes to a few hours to appear. If the domain is on Cloudflare, set it to “DNS only”. Full name: ${dns.name}.`),
    dns.ready ? null : h('div', { class: 'alert' }, `Not ready to hand out: this server does not know its own public address yet (it is “${dns.target}”). Set PUBLIC_URL first.`),
    more('Also needed on our side', h('p', { class: 'small muted' }, 'Our server needs a certificate for this name. That is set up by us when the name is added to the server, not by the brand.')),
  );
}

interface SetupCheck {
  ok: boolean;
  checks: Array<{ id: string; label: string; status: 'pass' | 'fail' | 'warn' | 'skip'; detail: string; fix?: string }>;
}

async function runSetupCheck(tenantId: string, k: SiteKey) {
  const r = await api<SetupCheck>('POST', `/tenants/${tenantId}/site-keys/${k.key}/check`);
  const mark: Record<string, [string, string]> = { pass: ['check', 'done'], fail: ['x', 'bad'], warn: ['alert', 'warn'], skip: ['info', 'todo'] };
  formDialog({
    title: r.ok ? 'Setup looks good' : 'Something needs fixing',
    lead: r.ok ? 'No problems found.' : 'Fix the items marked with a cross, then check again.',
    wide: true,
    closeOnly: true,
    submitLabel: 'Close',
    onSubmit: async () => {},
    body: [
      h(
        'ul',
        { class: 'checklist' },
        ...r.checks.map((x) =>
          h(
            'li',
            { style: 'align-items:flex-start' },
            h('span', { class: `tick ${mark[x.status]?.[1] ?? 'todo'}`, 'aria-label': x.status }, icon(mark[x.status]?.[0] ?? 'info', 15)),
            h('div', null, h('strong', null, x.label), h('div', { class: 'small' }, x.detail), x.fix ? h('div', { class: 'small muted' }, `What to do: ${x.fix}`) : null),
          ),
        ),
      ),
    ],
  });
}

// ---- CRM ------------------------------------------------------------------------------------------------
const MAPPING_FIELDS: Array<{ key: keyof ZohoMapping; label: string; hint: string; list?: boolean; required?: boolean }> = [
  { key: 'dealId', label: 'Deal ID field', hint: 'A value that is unique per sale. It also stops a sale being counted twice.', required: true },
  { key: 'amount', label: 'Amount field', hint: 'The sale value.', required: true },
  { key: 'occurredAt', label: 'Sale date field', hint: 'A date or date-time. Date-only values count as noon.', required: true },
  { key: 'phone', label: 'Phone field', hint: 'On the Zoho contact this is often Contact_Name.Mobile.', required: true },
  { key: 'channel', label: 'Sales channel field', hint: 'Tells in-store sales from online ones.', required: true },
  { key: 'storeChannelValues', label: 'Values that mean “in store”', hint: 'Comma separated', list: true, required: true },
  { key: 'email', label: 'Email field', hint: 'Optional but improves matching.' },
  { key: 'firstName', label: 'First name field', hint: 'Optional. Name, place and customer ID help the ad platforms recognise the buyer.' },
  { key: 'lastName', label: 'Last name field', hint: 'Optional.' },
  { key: 'city', label: 'City field', hint: 'Optional.' },
  { key: 'state', label: 'State field', hint: 'Optional. Names such as Maharashtra are sent as the code (MH).' },
  { key: 'postalCode', label: 'Postal code field', hint: 'Optional.' },
  { key: 'country', label: 'Country field', hint: 'Optional but needed for Google to use the address. Not guessed from the phone number.' },
  { key: 'customerId', label: 'Customer ID field', hint: 'Optional. The contact’s own ID in Zoho, for example Contact_Name.id.' },
  { key: 'stage', label: 'Stage field', hint: 'Leave empty to treat every record as won.' },
  { key: 'wonStages', label: 'Won stage values', hint: 'Comma separated, for example Closed Won', list: true },
  { key: 'fallbackOccurredAt', label: 'Sale date fallback', hint: 'Used when the main date is empty.' },
  { key: 'store', label: 'Store field', hint: 'Shown next to each sale.' },
  { key: 'whatsappChannelValues', label: 'Values that mean “WhatsApp”', hint: 'Comma separated', list: true },
  { key: 'onlineChannelValues', label: 'Values that mean “online”', hint: 'Comma separated', list: true },
  { key: 'consent', label: 'Consent field', hint: 'Whether the customer agreed to ad-platform sharing.' },
  { key: 'consentTrueValues', label: 'Values that mean “agreed”', hint: 'Default: yes, true, y, 1, consented, granted, agreed', list: true },
  { key: 'currency', label: 'Currency', hint: 'Three letters, for example INR' },
  { key: 'eventName', label: 'Event name sent to the platforms', hint: 'Default: Purchase' },
];

function crmTab(c: Ctx): HTMLElement {
  const id = c.view.tenant.tenantId;
  const mapped = Boolean(c.view.tenant.sources.zoho);
  const webhookBox = h('div');
  const rotate = h('button', { type: 'button' }, 'Create a new secret');
  rotate.addEventListener(
    'click',
    runAction(rotate, async () => {
      if (!(await confirmDialog({ title: 'Create a new webhook secret?', message: 'The old one stops working immediately, so update it in Zoho right away.', confirmLabel: 'Create new secret', danger: true }))) return;
      const { webhookSecret } = await api<{ webhookSecret: string }>('POST', `/tenants/${id}/webhook-secret/rotate`);
      clear(webhookBox);
      webhookBox.append(secretBox('New webhook secret (shown once)', webhookSecret, 'Update the x-webhook-secret header in the Zoho workflow now.'));
    }),
  );
  const step = (n: number, title: string, ...rest: Child[]) => h('li', { class: 'how-step' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(n)), h('div', { class: 'how-body' }, h('div', { class: 'step-title' }, title), ...rest));
  return h(
    'div',
    { class: 'stack' },
    h('h2', null, 'Zoho CRM'),
    h(
      'div',
      { class: 'card' },
      h(
        'ol',
        { class: 'how' },
        step(1, 'Copy this webhook address', h('p', { class: 'step-hint' }, 'In Zoho, create a workflow rule that calls it when a deal is marked Won. Include the contact’s phone and email in what it sends.'), copyField(c.view.webhooks.zoho)),
        step(2, 'Add this header to the rule', copyField('x-webhook-secret: <the secret shown when the brand was created>'), h('p', { class: 'step-hint' }, 'Lost the secret? Create a new one under “Other systems and security”.')),
        step(
          3,
          'Tell us which Zoho fields to read',
          h('div', { class: 'row' }, mapped ? h('span', { class: 'badge ok' }, 'Saved') : h('span', { class: 'badge' }, 'Not set up'), h('button', { type: 'button', class: mapped ? '' : 'primary', onclick: () => mappingDialog(c) }, mapped ? 'Edit field mapping' : 'Set up field mapping')),
        ),
      ),
    ),
    more('Other systems and security', h('p', { class: 'muted small' }, 'Any other system can post the standard JSON to this address instead:'), copyField(c.view.webhooks.generic), webhookBox, h('div', { class: 'row' }, rotate)),
  );
}

function mappingDialog(c: Ctx) {
  const id = c.view.tenant.tenantId;
  const current = c.view.tenant.sources.zoho;
  const inputs = new Map<string, HTMLInputElement>();
  const fill = (m: Partial<ZohoMapping> | undefined) => {
    for (const f of MAPPING_FIELDS) {
      const v = m?.[f.key];
      inputs.get(f.key)!.value = Array.isArray(v) ? v.join(', ') : ((v as string | undefined) ?? '');
    }
  };
  const fieldFor = (f: (typeof MAPPING_FIELDS)[number]) => {
    const input = textInput('');
    inputs.set(f.key, input);
    return field(`z-${f.key}`, `${f.label}${f.required ? ' *' : ''}`, input, f.hint).wrap;
  };
  const required = h('div', { class: 'cols' }, ...MAPPING_FIELDS.filter((f) => f.required).map(fieldFor));
  const optional = h('div', { class: 'cols' }, ...MAPPING_FIELDS.filter((f) => !f.required).map(fieldFor));
  fill(current);
  const usual = h('button', { type: 'button', class: 'link' }, 'Fill with usual names');
  usual.addEventListener('click', () => {
    fill(c.meta.defaultZohoMapping);
    toast('Filled in. Check the names against Zoho, then save.');
  });
  formDialog({
    title: 'Zoho field mapping',
    lead: 'Type the exact field names (API names) from Zoho. Fields with * are needed.',
    wide: true,
    body: [required, more('More fields (optional)', optional)],
    extra: usual,
    submitLabel: 'Save mapping',
    onSubmit: async () => {
      const body: Record<string, unknown> = {};
      for (const f of MAPPING_FIELDS) {
        const raw = inputs.get(f.key)!.value.trim();
        if (!raw) continue;
        body[f.key] = f.list ? csvToList(raw) : raw;
      }
      await api('PUT', `/tenants/${id}/sources/zoho`, body);
      toast('Mapping saved');
      void c.reload();
    },
  });
}

// ---- ad accounts ----------------------------------------------------------------------------------------
function connectionStatus(conn: Connection | undefined, testMode = false) {
  if (!conn) return h('span', { class: 'badge' }, 'Not connected');
  if (conn.status === 'error') return h('span', { class: 'badge bad', title: conn.lastError }, 'Needs attention');
  return h('span', { class: `badge ${testMode ? 'warn' : 'ok'}` }, testMode ? 'Test mode' : 'Connected');
}

function connectionsTab(c: Ctx): HTMLElement {
  const id = c.view.tenant.tenantId;
  const get = (k: string) => c.view.connections.find((x) => x.kind === k);
  const meta = get('meta');
  const google = get('google_ads');
  const btn = (label: string, primary: boolean, fn: () => void) => h('button', { type: 'button', class: primary ? 'primary' : '', onclick: fn }, label);
  const googleCheck = h('button', { type: 'button' }, 'Check connection');
  googleCheck.addEventListener(
    'click',
    runAction(googleCheck, async () => {
      const r = await api<{ ok: boolean; message: string }>('POST', `/tenants/${id}/connections/google_ads/check`);
      toast(r.message, !r.ok);
    }),
  );
  return h(
    'div',
    { class: 'stack' },
    h('div', null, h('h2', null, 'Ad accounts'), h('p', { class: 'muted' }, 'Sales are sent to the accounts you connect here.')),
    listRow({
      title: 'Meta (Facebook and Instagram)',
      badge: connectionStatus(meta, Boolean(meta?.testEventCode)),
      sub: meta ? `Dataset ${meta.datasetId ?? ''}${meta.testEventCode ? ' · events go to Test Events only' : ''}` : 'Needs a dataset ID and an access token.',
      alert: meta?.status === 'error' ? `${meta.lastError ?? 'Unknown error'}. Save a new token, then resend the failed sales from the Sales tab.` : null,
      actions: [btn(meta ? 'Edit' : 'Connect', !meta || meta.status === 'error', () => metaDialog(c, meta))],
    }),
    listRow({
      title: 'Google Ads',
      badge: connectionStatus(google),
      sub: google ? `Customer ${google.customerId ?? ''}` : 'Needs the account ID and a conversion action.',
      alert: google?.status === 'error' ? `${google.lastError ?? 'Unknown error'}. Fix the access, press Check connection, then resend the failed sales from the Sales tab.` : null,
      actions: [google ? googleCheck : null, btn(google ? 'Edit' : 'Connect', !google || google.status === 'error', () => googleDialog(c, google))],
    }),
  );
}

function disconnectButton(c: Ctx, kind: string, close: () => void): HTMLElement {
  const btn = h('button', { class: 'danger', type: 'button' }, 'Disconnect');
  btn.addEventListener(
    'click',
    runAction(btn, async () => {
      if (!(await confirmDialog({ title: `Disconnect ${DEST_LABEL[kind] ?? kind}?`, message: 'Sales will wait until it is connected again.', confirmLabel: 'Disconnect', danger: true }))) return;
      await api('DELETE', `/tenants/${c.view.tenant.tenantId}/connections/${kind}`);
      toast('Disconnected');
      close();
      void c.reload();
    }),
  );
  return btn;
}

function metaDialog(c: Ctx, conn: Connection | undefined) {
  const id = c.view.tenant.tenantId;
  const dataset = textInput(conn?.datasetId ?? '', { placeholder: '1234567890123456' });
  const test = textInput(conn?.testEventCode ?? '', { placeholder: 'TEST12345' });
  const token = textInput('', { type: 'password', placeholder: conn ? 'Saved: leave blank to keep' : 'Paste the access token', autocomplete: 'new-password' });
  const dialog: HTMLDialogElement = formDialog({
    title: conn ? 'Edit Meta connection' : 'Connect Meta',
    lead: 'In Meta Events Manager, open your dataset, then Settings → Conversions API.',
    body: [
      field('m-ds', 'Dataset ID', dataset).wrap,
      field('m-token', 'Access token', token, 'Stored encrypted and never shown again.').wrap,
      more('Testing first? Add a test event code', field('m-test', 'Test event code', test, 'While set, events appear under Test Events in Meta and do not count. Clear it to go live.').wrap),
    ],
    extra: conn ? disconnectButton(c, 'meta', () => closeDialog(dialog)) : null,
    submitLabel: conn ? 'Save' : 'Connect',
    onSubmit: async () => {
      await api('PUT', `/tenants/${id}/connections/meta`, { datasetId: dataset.value, testEventCode: test.value, accessToken: token.value });
      toast('Meta connected');
      void c.reload();
    },
  });
}

function googleDialog(c: Ctx, conn: Connection | undefined) {
  const id = c.view.tenant.tenantId;
  const g = c.meta.google;
  const customer = textInput(conn?.customerId ?? '', { placeholder: '123-456-7890' });
  const login = textInput(conn?.loginCustomerId ?? '', { placeholder: 'Manager account ID' });
  const action_ = textInput(conn?.conversionActionId ?? '', { placeholder: 'Conversion action ID' });
  const token = textInput('', { type: 'password', placeholder: conn?.secretSet ? 'Saved: leave blank to keep' : 'OAuth refresh token', autocomplete: 'new-password' });
  const method = select(
    [['service_account', 'Give our service account access (recommended)'], ['oauth', 'Use a Google login (refresh token)']],
    conn?.authMethod ?? (g.serviceAccountEmail ? 'service_account' : 'oauth'),
  );
  const saBox = h(
    'div',
    { class: 'note stack tight' },
    ...(g.serviceAccountEmail
      ? [h('div', null, 'In Google Ads, go to Admin → Access and security and add this email as a user:'), copyField(g.serviceAccountEmail), h('div', { class: 'small' }, 'Standard access is enough to upload conversions. If you manage their account, linking it to your manager account also works: put your manager ID under “Manager account” below.')]
      : [h('div', null, 'The server has no service account key yet (GOOGLE_SERVICE_ACCOUNT_JSON), so this method will not work until it is set. Use a Google login meanwhile.')]),
  );
  const tokenField = field('g-token', 'Refresh token', token, 'From a Google user with access to the account. Get one with scripts/google-refresh-token.ts.' + (g.oauthConfigured ? '' : ' The OAuth client is not configured on the server yet.')).wrap;
  const sync = () => {
    const viaSa = method.value === 'service_account';
    saBox.hidden = !viaSa;
    tokenField.hidden = viaSa;
  };
  method.addEventListener('change', sync);
  sync();
  const dialog: HTMLDialogElement = formDialog({
    title: conn ? 'Edit Google Ads connection' : 'Connect Google Ads',
    lead: 'We upload sales as offline conversions to one conversion action.',
    wide: true,
    body: [
      field('g-cust', 'Customer ID', customer, 'The ad account that receives the conversions.').wrap,
      field('g-act', 'Conversion action ID', action_, 'In Google Ads, create a conversion action of type “Import” (from clicks), then copy its ID.').wrap,
      field('g-method', 'How should we get access?', method).wrap,
      saBox,
      tokenField,
      more('Manager account (optional)', field('g-login', 'Manager (MCC) ID', login, 'Only if access is through a manager account.').wrap),
    ],
    extra: conn ? disconnectButton(c, 'google_ads', () => closeDialog(dialog)) : null,
    submitLabel: conn ? 'Save' : 'Connect',
    onSubmit: async () => {
      await api('PUT', `/tenants/${id}/connections/google_ads`, {
        authMethod: method.value,
        customerId: customer.value,
        loginCustomerId: login.value,
        conversionActionId: action_.value,
        ...(method.value === 'oauth' ? { refreshToken: token.value } : {}),
      });
      toast('Google Ads connected');
      void c.reload();
    },
  });
}

// ---- sales ----------------------------------------------------------------------------------------------
async function salesTab(c: Ctx): Promise<HTMLElement> {
  const id = c.view.tenant.tenantId;
  const importBtn = h('button', { type: 'button', onclick: () => importDialog(c) }, 'Import sales');
  const LIMIT = 100;

  // A count clicked on the Overview arrives here as a preset; it is used once.
  let status: SaleStatusFilter = salesPreset?.status ?? 'all';
  let dest = salesPreset?.dest ?? '';
  let query = '';
  salesPreset = null;
  let all: SaleSummary[] = [];

  const tableBox = h('div');
  const search = h('input', { type: 'search', class: 'search-input', placeholder: 'Search sale ID or store', 'aria-label': 'Search sales', autocomplete: 'off', spellcheck: false });
  // The search box is built once and never moved, so typing in it is never interrupted by a redraw of the results.
  const segHost = h('div');
  const chipHost = h('div');
  const bar = h('div', { class: 'filters' }, h('div', { class: 'row' }, segHost, chipHost), h('div', { class: 'search-wrap' }, icon('search', 15), search));

  const drawBar = () => {
    const base = all.filter((s) => saleMatches(s, 'all', dest, query));
    const count = (st: SaleStatusFilter) => (st === 'all' ? base.length : all.filter((s) => saleMatches(s, st, dest, query)).length);
    const seg = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Filter sales by what happened' },
      ...STATUS_FILTERS.map(([key, label]) => {
        const n = count(key);
        const b = h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(status === key) }, label, h('span', { class: 'seg-count' }, String(n)));
        b.addEventListener('click', () => {
          status = key;
          draw();
        });
        return b;
      }),
    );
    const destChip = dest
      ? h('button', { type: 'button', class: 'filter-chip', title: 'Show all platforms', onclick: () => { dest = ''; draw(); } }, `Only ${DEST_LABEL[dest] ?? dest}`, icon('x', 12))
      : null;
    segHost.replaceChildren(seg);
    chipHost.replaceChildren(...(destChip ? [destChip] : []));
  };

  const drawTable = () => {
    if (all.length === 0) {
      tableBox.replaceChildren(emptyState('No sales yet', 'Sales appear here when your CRM reports a won deal. If some are missing from the CRM, you can import them from a file.', h('button', { class: 'primary', type: 'button', onclick: () => importDialog(c) }, 'Import sales')));
      return;
    }
    const shown = all.filter((s) => saleMatches(s, status, dest, query));
    if (shown.length === 0) {
      tableBox.replaceChildren(
        emptyState('No sales match', 'Nothing fits the filters you chose.', h('button', { type: 'button', onclick: () => { status = 'all'; dest = ''; query = ''; search.value = ''; draw(); } }, 'Clear filters')),
      );
      return;
    }
    tableBox.replaceChildren(
      h(
        'div',
        { class: 'card table-wrap' },
        h(
          'table',
          { class: 'sales-table' },
          h('thead', null, h('tr', null, ...['Sale date', 'Sale', 'Channel', 'Value', 'Website visit', 'Sent to', ''].map((x) => h('th', { scope: 'col', class: x === 'Value' ? 'num' : '' }, x)))),
          h(
            'tbody',
            null,
            ...shown.map((s) => {
              const details = h('button', { type: 'button', class: 'link small', onclick: () => saleDialog(c, s, load) }, 'Details');
              const deliveries = dest ? s.deliveries.filter((d) => d.destination === dest) : s.deliveries;
              return h(
                'tr',
                null,
                h('td', { class: 'small nowrap' }, timeEl(s.sale.occurredAt)),
                h('td', null, h('div', { class: 'mono small' }, s.sale.eventId), s.sale.storeName ? h('div', { class: 'muted small' }, s.sale.storeName) : null),
                h('td', null, CHANNEL_LABEL[s.sale.channel] ?? s.sale.channel),
                h('td', { class: 'num' }, fmtMoney(s.sale.value, s.sale.currency)),
                h('td', null, s.sale.personId ? h('span', { class: 'badge ok' }, 'linked') : h('span', { class: 'badge' }, 'not linked')),
                h('td', null, h('div', { class: 'chip-stack' }, ...deliveries.map((d) => h('div', { class: 'chip-line' }, h('span', { class: 'small' }, DEST_LABEL[d.destination] ?? d.destination), statusBadge(d.status))))),
                h('td', { class: 'num' }, details),
              );
            }),
          ),
        ),
      ),
      ...(all.length >= LIMIT ? [h('p', { class: 'muted small', style: 'margin-top:10px' }, `Showing the latest ${LIMIT} sales.`)] : []),
    );
  };
  const draw = () => {
    drawBar();
    drawTable();
  };
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });

  const load = async () => {
    tableBox.classList.add('refreshing');
    try {
      ({ sales: all } = await api<{ sales: SaleSummary[] }>('GET', `/tenants/${id}/sales?limit=${LIMIT}`));
    } finally {
      tableBox.classList.remove('refreshing');
    }
    draw();
  };

  const refresh = h('button', { type: 'button' }, 'Refresh');
  refresh.addEventListener('click', runAction(refresh, load));
  const sendNow = h('button', { class: 'primary', type: 'button' }, 'Send waiting sales now');
  sendNow.addEventListener(
    'click',
    runAction(sendNow, async () => {
      const r = await api<{ considered: number; sent: number; retried: number; failed: number; notConnected: number; withdrawn?: number; suspended?: boolean; blocked?: number; blockedReason?: string }>('POST', `/tenants/${id}/dispatch`);
      toast(
        r.blocked && r.blockedReason && !r.considered
          ? r.blockedReason
          : r.suspended
          ? 'This brand is suspended: nothing was sent.'
          : r.considered === 0
            ? 'Nothing was waiting.'
            : `Sent ${r.sent}, will retry ${r.retried}, failed ${r.failed}${r.notConnected ? `, waiting for a connection: ${r.notConnected}` : ''}${r.withdrawn ? `, skipped because the customer withdrew consent: ${r.withdrawn}` : ''}.`,
      );
      await load();
    }),
  );
  // The server can be set not to send (for example while a new setup is being checked): say so, and do not offer the button.
  const sending = c.view.sending;
  const blockedNote = sending && !sending.allowed ? h('div', { class: 'note' }, sending.reason ?? 'Sending is switched off on this server.') : null;
  if (blockedNote) {
    sendNow.disabled = true;
    sendNow.title = sending?.reason ?? '';
  } else if (sending?.destinations) {
    sendNow.title = `This server only sends to: ${sending.destinations.join(', ')}.`;
  }

  await load();
  return h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('h2', null, 'Recent sales'), h('div', { class: 'row' }, importBtn, refresh, sendNow)), blockedNote, all.length ? bar : null, tableBox);
}

/** Everything about one sale: where it was sent, the full reasons, and Preview and Resend. */
function saleDialog(c: Ctx, s: SaleSummary, reload: () => Promise<void>) {
  const tenantId = c.view.tenant.tenantId;
  const dialog: HTMLDialogElement = formDialog({
    title: `Sale ${s.sale.eventId}`,
    lead: `${CHANNEL_LABEL[s.sale.channel] ?? s.sale.channel} · ${fmtMoney(s.sale.value, s.sale.currency)} · ${fmtDate(s.sale.occurredAt)} · ${s.sale.personId ? 'linked to an earlier website visit' : 'no website visit linked'}`,
    wide: true,
    closeOnly: true,
    submitLabel: 'Close',
    onSubmit: async () => {},
    body: s.deliveries.length
      ? s.deliveries.map((d) =>
          deliveryCell(tenantId, s.saleKey, d, async () => {
            closeDialog(dialog);
            await reload();
          }),
        )
      : [h('p', { class: 'muted' }, 'Not queued for any platform.')],
  });
}

function deliveryCell(tenantId: string, saleKey: string, d: SaleSummary['deliveries'][number], reload: () => Promise<void>): HTMLElement {
  const detail =
    d.status === 'skipped' ? SKIP_LABEL[d.skipReason ?? ''] ?? d.skipReason : d.status === 'retry' && d.nextRetryAt ? `Next try ${fmtDate(d.nextRetryAt)}. ${d.lastError ?? ''}` : (d.lastError ?? d.response);
  const row = h('div', { class: 'delivery' }, h('div', { class: 'row' }, h('strong', null, DEST_LABEL[d.destination] ?? d.destination), statusBadge(d.status, detail)));
  if (d.status === 'skipped' && detail) row.append(h('div', { class: 'muted small' }, detail));
  if ((d.status === 'failed' || d.status === 'retry') && d.lastError) {
    const waiting = d.lastError.startsWith('not_connected');
    row.append(h('div', { class: 'small', style: waiting ? 'color:var(--warn)' : 'color:var(--bad)' }, waiting ? 'Waiting: connect this account under Ad accounts and it will send automatically.' : d.lastError.slice(0, 300)));
  }
  if (d.status === 'sent' && d.processingStatus) {
    const text: Record<string, [string, string]> = {
      processing: ['Accepted, Google is still processing it', 'color:var(--warn)'],
      success: ['Processed by Google', 'color:var(--ok)'],
      partial: [`Partly rejected by Google: ${(d.processingDetail ?? '').replace(/^rejected: /, '')}`, 'color:var(--bad)'],
      rejected: [`Rejected by Google: ${(d.processingDetail ?? '').replace(/^rejected: /, '')}`, 'color:var(--bad)'],
      unknown: ['Google gave no result within 24 hours', 'color:var(--muted)'],
    };
    const [label, style] = text[d.processingStatus] ?? ['', ''];
    if (label) row.append(h('div', { class: 'small', style }, label));
  }
  const actions = h('div', { class: 'row' });
  if (d.status !== 'skipped') {
    const preview = h('button', { type: 'button', class: 'small' }, 'Preview what is sent');
    preview.addEventListener('click', runAction(preview, () => showPreview(tenantId, saleKey, d.destination)));
    actions.append(preview);
  }
  if (d.status === 'failed' || d.status === 'retry' || d.status === 'sent') {
    const btn = h('button', { type: 'button', class: 'small' }, 'Send again');
    btn.addEventListener(
      'click',
      runAction(btn, async () => {
        if (d.status === 'sent' && !(await confirmDialog({ title: 'Send a sale that was already sent?', message: 'It reuses the same event ID, so the platform should not count it twice.', confirmLabel: 'Send again' }))) return;
        await api('POST', `/tenants/${tenantId}/sales/${saleKey}/deliveries/${d.destination}/resend`);
        toast('Queued to send again. Use “Send waiting sales now” or wait for the next run.');
        await reload();
      }),
    );
    actions.append(btn);
  }
  if (actions.childElementCount) row.append(actions);
  return row;
}

/** Show what would be sent for a delivery: built by the real sender code, nothing is sent, no secrets. */
async function showPreview(tenantId: string, saleKey: string, destination: string) {
  const r = await api<{ url?: string; body?: unknown; notes?: string[]; error?: string }>('GET', `/tenants/${tenantId}/sales/${saleKey}/deliveries/${destination}/preview`);
  formDialog({
    title: `What would be sent to ${DEST_LABEL[destination] ?? destination}`,
    wide: true,
    closeOnly: true,
    submitLabel: 'Close',
    onSubmit: async () => {},
    body: [
      r.error ? h('div', { class: 'alert' }, r.error) : null,
      ...(r.notes ?? []).map((n) => h('p', { class: 'small muted' }, n)),
      r.url ? h('p', { class: 'small' }, 'POST ', h('span', { class: 'mono' }, r.url)) : null,
      r.body ? h('pre', { class: 'code-block' }, JSON.stringify(r.body, null, 2)) : null,
      h('p', { class: 'small muted' }, 'Nothing was sent. Contact details appear only as hashes, and no access tokens are included.'),
    ],
  });
}

// ---- import ---------------------------------------------------------------------------------------------
interface ImportSummary {
  rows: number;
  newSales: number;
  alreadyImported: number;
  withContact: number;
  withoutContact: number;
  consent: { yes: number; no: number; notStated: number };
  withName: number;
  withPostalCode: number;
  value: Record<string, number>;
  firstDate: string | null;
  lastDate: string | null;
}

/** What a clean check found, in plain words, as the confirmation shown before anything is imported. */
function importSummaryView(sm: ImportSummary, optIn: boolean): HTMLElement {
  const money = Object.entries(sm.value).map(([cur, n]) => `${cur} ${n.toLocaleString('en-IN')}`).join(' + ');
  const line = (text: string, warn = false) => h('li', { class: warn ? 'warn-line' : '' }, text);
  return h(
    'div',
    { class: 'note', role: 'status' },
    h('div', null, h('strong', null, sm.newSales === 0 ? 'Nothing new to import.' : `Ready to import ${plural(sm.newSales, 'sale', 'sales')}.`)),
    h(
      'ul',
      null,
      sm.alreadyImported ? line(`${plural(sm.alreadyImported, 'row is', 'rows are')} already imported and will be skipped.`) : null,
      money ? line(`Total value of the new sales: ${money}`) : null,
      sm.firstDate ? line(sm.firstDate === sm.lastDate ? `Sale date: ${sm.firstDate}` : `Sale dates: ${sm.firstDate} to ${sm.lastDate}`) : null,
      sm.newSales === 0 ? null : sm.withoutContact ? line(`${plural(sm.withoutContact, 'row has', 'rows have')} no phone or email. They are recorded but cannot be matched, so they will not be sent.`, true) : line('Every row has a phone or an email.'),
      sm.newSales === 0 ? null : line(`Consent: ${sm.consent.yes} yes, ${sm.consent.no} no, ${sm.consent.notStated} not stated.${sm.consent.notStated && optIn ? ' Without a yes, a sale is only sent if the customer agreed on the website.' : ''}${sm.consent.no ? ' Rows marked no are never sent.' : ''}`, Boolean(sm.consent.notStated && optIn)),
      sm.withName || sm.withPostalCode ? line(`Better matching: ${plural(sm.withName, 'row has', 'rows have')} a full name, ${plural(sm.withPostalCode, 'row has', 'rows have')} a postal code.`) : null,
    ),
  );
}

function importDialog(c: Ctx) {
  const id = c.view.tenant.tenantId;
  const text = h('textarea', { class: 'mono', rows: 7, spellcheck: false, placeholder: c.meta.importColumns.join(',') });
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const results = h('div', { 'aria-live': 'polite' });

  type Check = {
    dryRun: boolean;
    counts: Record<string, number>;
    results: Array<{ line: number; status: string; error?: string }>;
    summary?: ImportSummary;
    checkToken?: string;
  };
  // The import is only offered for a file that has just passed the check. Any edit to the file undoes that.
  let passed: { csv: string; token: string; summary: ImportSummary } | null = null;
  let submit: HTMLButtonElement | null = null;
  const label = () => {
    if (submit) submit.textContent = !passed ? 'Check file' : passed.summary.newSales === 0 ? 'Close' : `Import ${plural(passed.summary.newSales, 'sale', 'sales')}`;
  };
  const reset = () => {
    passed = null;
    results.replaceChildren();
    label();
  };
  text.addEventListener('input', reset);
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (f) text.value = await f.text();
    reset();
  });

  const check = async () => {
    const csv = text.value;
    const r = await api<Check>('POST', `/tenants/${id}/import`, { csv, dryRun: true });
    const bad = r.results.filter((x) => x.status === 'invalid' || x.status === 'error');
    if (bad.length || !r.checkToken || !r.summary) {
      passed = null;
      results.replaceChildren(
        h('div', { class: 'alert' }, h('div', null, `${plural(bad.length, 'row has', 'rows have')} problems. Fix them and check again; nothing can be imported until the file passes.`), h('ul', null, ...bad.slice(0, 20).map((x) => h('li', null, `Line ${x.line}: ${x.error ?? x.status}`))), bad.length > 20 ? h('div', { class: 'small' }, `…and ${bad.length - 20} more.`) : null),
      );
    } else {
      passed = { csv, token: r.checkToken, summary: r.summary };
      results.replaceChildren(importSummaryView(r.summary, c.view.tenant.consentPolicy.mode === 'opt_in'));
    }
    label();
  };

  const dialog = formDialog({
    title: 'Import sales',
    lead: 'For sales that are missing from the CRM. Only import sales that are not already coming from it, or they will be counted twice. The file is checked first; nothing is imported until it passes.',
    wide: true,
    body: [
      h('div', { class: 'row' }, file, h('button', { type: 'button', class: 'link', onclick: () => download('sales-template.csv', c.meta.importTemplate) }, 'Download a template')),
      field('imp-text', 'Or paste the file contents', text, 'Needs eventId, channel (store, online, whatsapp or web_lead) and occurredAt (a date like 2026-10-07).').wrap,
      results,
    ],
    submitLabel: 'Check file',
    onSubmit: async () => {
      // Always against the file as it is now: if it changed since the check, check again instead of importing.
      if (!passed || passed.csv !== text.value) {
        await check();
        return false;
      }
      if (passed.summary.newSales === 0) return; // nothing to add: just close
      try {
        const r = await api<Check>('POST', `/tenants/${id}/import`, { csv: passed.csv, checkToken: passed.token });
        const { recorded = 0, error = 0, invalid = 0 } = r.counts;
        if (error > 0 || invalid > 0) {
          results.replaceChildren(h('div', { class: 'alert' }, `Recorded ${recorded}, but ${plural(error + invalid, 'row failed', 'rows failed')}. Check the Sales tab.`));
          passed = null;
          label();
          void c.reload();
          return false;
        }
        toast(`Imported ${plural(recorded, 'sale', 'sales')}.`);
        void c.reload();
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'check_outdated' || e.code === 'check_required')) {
          reset(); // the check expired: ask for a new one
          toast('The check has expired. Check the file again.', true);
          return false;
        }
        throw e;
      }
    },
  });
  submit = dialog.querySelector<HTMLButtonElement>('button[type=submit]');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- settings -------------------------------------------------------------------------------------------
function settingsTab(c: Ctx): HTMLElement {
  const t = c.view.tenant;
  const name = textInput(t.name);
  const consent = select([['opt_in', 'Opt-in: only share data customers agreed to'], ['opt_out', 'Opt-out: share unless the customer declined']], t.consentPolicy.mode);
  const country = select(c.meta.countries.map((x) => [x, x]), t.defaultCountry);
  const channels = checkGroup('st-channels', c.meta.channels, t.allowedChannels, CHANNEL_LABEL);
  const dests = checkGroup('st-dests', c.meta.destinations, t.destinations, DEST_LABEL);
  const retention = h('input', { type: 'number', value: t.retentionDays, min: 1, max: 365 });
  const status = select([['active', 'Active'], ['suspended', 'Paused: refuse the script and webhook']], t.status);

  // Save is only offered when something changed, and the page says so, so there is never a doubt whether it was saved.
  const snapshot = () => JSON.stringify([name.value, consent.value, country.value, channels.values(), dests.values(), Number(retention.value), status.value]);
  const original = snapshot();
  const hint = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const save = saveButton('Save settings', async () => {
    await api('PATCH', `/tenants/${t.tenantId}`, {
      name: name.value,
      consentMode: consent.value,
      defaultCountry: country.value,
      allowedChannels: channels.values(),
      destinations: dests.values(),
      retentionDays: Number(retention.value),
      status: status.value,
    });
    toast('Settings saved');
    void c.reload();
  });
  const sync = () => {
    const changed = snapshot() !== original;
    save.disabled = !changed;
    hint.textContent = changed ? 'You have unsaved changes.' : '';
  };
  save.disabled = true;

  const card = h(
    'div',
    { class: 'card stack' },
      h('h2', null, 'Settings'),
      field('st-name', 'Brand name', name).wrap,
      h('div', { class: 'field' }, h('label', null, 'Send sales to'), dests.wrap),
      h('div', { class: 'field' }, h('label', null, 'Report these sales channels'), channels.wrap, h('div', { class: 'hint' }, 'Leave “Online” off if the store platform already reports online sales to the ad platforms.')),
      field('st-consent', 'Consent policy', consent).wrap,
      more('Advanced', h('div', { class: 'cols' }, field('st-country', 'Phone numbers without a country code are from', country).wrap, field('st-ret', 'Keep customer data for (days)', retention).wrap), field('st-status', 'Status', status).wrap),
      h('div', { class: 'row' }, save, hint),
  );
  card.addEventListener('input', sync);
  card.addEventListener('change', sync);

  return h(
    'div',
    { class: 'stack' },
    card,
    listRow({
      title: 'Customer privacy request',
      sub: 'A customer asked you to stop using their data for advertising.',
      actions: [h('button', { type: 'button', onclick: () => privacyDialog(c) }, 'Record a request')],
    }),
    listRow({
      title: 'Erase a customer',
      sub: 'A customer asked for their data to be deleted.',
      actions: [h('button', { class: 'danger', type: 'button', onclick: () => eraseDialog(c) }, 'Erase…')],
    }),
  );
}

function eraseDialog(c: Ctx) {
  const phone = textInput('', { placeholder: '98765 43210' });
  const email = textInput('', { placeholder: 'customer@example.com', autocomplete: 'off' });
  formDialog({
    title: 'Erase a customer',
    lead: 'Deletes their website profile and clicks, removes their phone and email details from past sales, and cancels anything not yet sent. Nothing more is ever sent for any phone or email we know belongs to them (found through their sales and visits). This cannot be undone.',
    body: [
      h('div', { class: 'cols' }, field('er-phone', 'Phone', phone).wrap, field('er-email', 'Email', email).wrap),
      h('div', { class: 'note' }, 'Data already sent to Meta or Google is not removed by this. It has to be deleted in those platforms.'),
    ],
    submitLabel: 'Erase customer data',
    danger: true,
    onSubmit: async () => {
      if (!phone.value.trim() && !email.value.trim()) throw new Error('Give a phone number or an email.');
      const who = phone.value.trim() || email.value.trim();
      if (!(await confirmDialog({ title: 'Erase this customer?', message: `${who}: their data will be deleted for good.`, confirmLabel: 'Erase', danger: true }))) return false;
      const r = await api<{ persons: number; sales: number; deliveriesCancelled: number; contactDetails?: number }>('POST', `/tenants/${c.view.tenant.tenantId}/customers/erase`, { phone: phone.value, email: email.value });
      const parts = [
        r.persons ? `${r.persons} website ${r.persons === 1 ? 'profile' : 'profiles'} deleted` : '',
        r.sales ? `${r.sales} ${r.sales === 1 ? 'sale' : 'sales'} made anonymous` : '',
        r.deliveriesCancelled ? `${r.deliveriesCancelled} queued ${r.deliveriesCancelled === 1 ? 'send' : 'sends'} cancelled` : '',
      ].filter(Boolean);
      const linked = (r.contactDetails ?? 0) > 1 ? ` Nothing will be sent for any of the ${r.contactDetails} phone numbers and emails linked to them.` : '';
      toast(parts.length ? `Erased: ${parts.join(', ')}.${linked}` : `Nothing was stored for them. Nothing will be sent for them from now on.${linked}`);
    },
  });
}

function privacyDialog(c: Ctx) {
  const phone = textInput('', { placeholder: '98765 43210' });
  const email = textInput('', { placeholder: 'customer@example.com', autocomplete: 'off' });
  formDialog({
    title: 'Customer privacy request',
    lead: 'Their queued sales are skipped and future ones are never sent, under any phone or email we know belongs to them, even if the CRM keeps marking them as consenting. A later clear “yes” from the customer on the website lifts it.',
    body: [h('div', { class: 'cols' }, field('pv-phone', 'Phone', phone).wrap, field('pv-email', 'Email', email).wrap)],
    submitLabel: 'Record request',
    onSubmit: async () => {
      const r = await api<{ keys: number; personFound: boolean }>('POST', `/tenants/${c.view.tenant.tenantId}/consent/withdraw`, { phone: phone.value, email: email.value });
      toast(r.personFound ? 'Recorded. Their website profile is marked as declined too.' : 'Recorded. No website profile was found; their sales will still be skipped.');
    },
  });
}
