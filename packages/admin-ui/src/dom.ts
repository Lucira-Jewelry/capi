// Tiny DOM helpers. Everything is built with createElement/textContent, never innerHTML, so text that comes from
// brands or the CRM can never be interpreted as markup.

export type Child = Node | string | number | null | false | undefined;
type Attrs = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el && key !== 'list') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === false || c === undefined) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function toast(message: string, bad = false) {
  const box = document.getElementById('toasts');
  if (!box) return;
  // At most three at once: the oldest goes first.
  while (box.children.length >= 3) box.firstElementChild?.remove();
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, role: bad ? 'alert' : 'status', title: 'Click to dismiss' }, icon(bad ? 'alert' : 'check', 16), h('span', null, message));
  const dismiss = () => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 200);
  };
  t.addEventListener('click', dismiss);
  box.appendChild(t);
  setTimeout(dismiss, bad ? 7000 : 3500);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed: select the text and copy it by hand.', true);
  }
}

export function fmtDate(v: string | Date | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtMoney(value: number | undefined, currency = 'INR'): string {
  if (value === undefined) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** A labelled form field. Returns the wrapper and the control so callers can read the value later. */
export function field<T extends HTMLElement>(id: string, label: string, control: T, hint?: string) {
  control.id = id;
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
  return { wrap, control };
}

export function textInput(value = '', opts: { type?: string; placeholder?: string; autocomplete?: string } = {}) {
  return h('input', { type: opts.type ?? 'text', value, placeholder: opts.placeholder ?? '', autocomplete: opts.autocomplete ?? 'off', spellcheck: false });
}

export function select(options: Array<[string, string]>, value: string) {
  const el = h('select', null, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  el.value = value;
  return el;
}

export function checkGroup(name: string, options: string[], selected: string[], labels: Record<string, string> = {}) {
  const boxes = options.map((o) => h('input', { type: 'checkbox', value: o, checked: selected.includes(o), name }));
  const wrap = h('div', { class: 'checks' }, ...options.map((o, i) => h('label', null, boxes[i]!, labels[o] ?? o)));
  return { wrap, values: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

export const csvToList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function badge(text: string, kind: '' | 'ok' | 'warn' | 'bad' = '', title?: string) {
  const el = h('span', { class: `badge ${kind}`.trim() }, text);
  if (title) el.title = title;
  return el;
}

export function statusBadge(status: string, title?: string) {
  const kind = status === 'sent' || status === 'active' ? 'ok' : status === 'failed' || status === 'error' || status === 'suspended' ? 'bad' : status === 'skipped' ? '' : 'warn';
  const el = h('span', { class: `badge ${kind}`.trim() }, status);
  if (title) el.title = title;
  return el;
}

// ---- look and feel helpers -----------------------------------------------------------------------------------

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let tickerRun = 0;

/**
 * Show a number that counts up from zero (Number Ticker). Only plain whole numbers and percentages animate. The real
 * value is always what ends up on screen, even when the browser pauses animation frames (a background tab) or the
 * same element is given a newer number while an older count is still running.
 */
export function ticker(el: HTMLElement, text: string) {
  const run = ++tickerRun;
  el.dataset.tick = String(run);
  el.textContent = text;
  const m = /^(\d+)(%?)$/.exec(text);
  if (!m || reducedMotion()) return;
  const target = Number(m[1]);
  const suffix = m[2] ?? '';
  if (target === 0) return;
  const duration = 700;
  const start = performance.now();
  let done = false;
  const finish = () => {
    done = true;
    if (el.dataset.tick === String(run)) el.textContent = text;
  };
  el.textContent = `0${suffix}`;
  const step = (now: number) => {
    if (done || el.dataset.tick !== String(run)) return;
    const t = Math.min(1, (now - start) / duration);
    el.textContent = `${Math.round(target * (1 - Math.pow(1 - t, 3)))}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
    else finish();
  };
  requestAnimationFrame(step);
  setTimeout(finish, duration + 60);
}

/** Cards marked `spot` get a soft light that follows the cursor (Magic Card). One listener for the whole page. */
export function enableSpotlight() {
  document.addEventListener(
    'pointermove',
    (e) => {
      const card = (e.target as Element | null)?.closest?.('.spot') as HTMLElement | null;
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    },
    { passive: true },
  );
}

const THEME_KEY = 'console_theme';

/** Apply the choice saved in this browser, if any. Without one the page follows the system setting. */
export function applyStoredTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch {
    /* private mode: follow the system */
  }
}

export function themeButton(): HTMLButtonElement {
  const btn = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Switch between light and dark',
    'aria-label': 'Switch between light and dark theme',
  });
  const paint = () => btn.replaceChildren(icon(effectiveTheme() === 'dark' ? 'sun' : 'moon', 17));
  btn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* not saved: it lasts until the page is closed */
    }
    paint();
  });
  // Follow the system when the person has not chosen.
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', paint);
  paint();
  return btn;
}

// ---- icons ---------------------------------------------------------------------------------------------------

type Shape = [tag: 'path' | 'circle' | 'rect', attrs: Record<string, string>];
const ICONS: Record<string, Shape[]> = {
  sun: [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41' }]],
  moon: [['path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' }]],
  copy: [['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  search: [['circle', { cx: '11', cy: '11', r: '8' }], ['path', { d: 'm21 21-4.3-4.3' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  back: [['path', { d: 'm12 19-7-7 7-7M19 12H5' }]],
  alert: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 8v4M12 16h.01' }]],
  info: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 16v-4M12 8h.01' }]],
  x: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
};

/** A small inline SVG icon that takes the text colour. Decorative: hidden from screen readers. */
export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  svg.setAttribute('class', 'icon');
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

// ---- time ----------------------------------------------------------------------------------------------------

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then a plain date. */
export function relTime(value: string | Date | undefined, now: Date = new Date()): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const seconds = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 45) return seconds > 0 ? 'in a moment' : 'just now';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), 'day');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) });
}

/** A <time> element: relative text, with the exact date and time on hover and for machines. */
export function timeEl(value: string | Date | undefined): HTMLElement | string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return h('time', { datetime: d.toISOString(), title: fmtDate(d) }, relTime(d));
}

// ---- loading states ------------------------------------------------------------------------------------------

/** Grey placeholder blocks that shimmer, shown only when something takes noticeably long. */
export function skeleton(kind: 'page' | 'cards' | 'rows' = 'page'): HTMLElement {
  const bar = (w: string, hgt = 12) => h('div', { class: 'skeleton', style: `width:${w};height:${hgt}px` });
  const card = () => h('div', { class: 'card' }, bar('34%', 14), h('div', { style: 'height:14px' }), bar('88%'), h('div', { style: 'height:8px' }), bar('64%'));
  const rows = () => h('div', { class: 'card' }, ...[0, 1, 2, 3].flatMap((i) => [bar(i % 2 ? '78%' : '92%'), h('div', { style: 'height:14px' })]));
  const wrap = h('div', { class: 'stack skeleton-wrap', role: 'status', 'aria-label': 'Loading' }, kind === 'rows' ? rows() : kind === 'cards' ? card() : h('div', null), kind === 'page' ? card() : null, kind === 'page' ? rows() : null);
  wrap.append(h('span', { class: 'sr-only' }, 'Loading'));
  return wrap;
}

// ---- dialogs -------------------------------------------------------------------------------------------------

/** Add a dialog to the page and open it. It is removed again when it closes. */
export function openDialog(dialog: HTMLDialogElement): HTMLDialogElement {
  // Escape closes with the same exit animation as the buttons.
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog(dialog);
  });
  dialog.addEventListener('close', () => dialog.remove());
  if (!dialog.isConnected) document.body.appendChild(dialog);
  dialog.showModal();
  return dialog;
}

/** Close with a short fade instead of vanishing. */
export function closeDialog(dialog: HTMLDialogElement) {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return dialog.close();
  dialog.classList.add('closing');
  setTimeout(() => dialog.close(), 140);
}

/** An in-page replacement for the browser's confirm() pop-up. Resolves true on confirm, false on cancel or Escape. */
export function confirmDialog(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = h('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-body' }) as HTMLDialogElement;
    const ok = h('button', { class: opts.danger ? 'primary danger-solid' : 'primary', type: 'button', onclick: () => { answer = true; closeDialog(dialog); } }, opts.confirmLabel ?? 'Continue');
    const cancel = h('button', { type: 'button', onclick: () => closeDialog(dialog) }, 'Cancel');
    dialog.append(
      h('h2', { id: 'confirm-title' }, opts.title),
      h('p', { id: 'confirm-body', class: 'muted', style: 'margin:8px 0 18px' }, opts.message),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, cancel, ok),
    );
    dialog.addEventListener('close', () => resolve(answer));
    openDialog(dialog);
    // Focus the safe choice: Enter should not confirm something destructive by accident.
    (opts.danger ? cancel : ok).focus();
  });
}

// ---- buttons -------------------------------------------------------------------------------------------------

/**
 * Click handler for a button that does something slow: shows a spinner and blocks double clicks while it runs, and
 * reports a failure as a message instead of failing silently.
 */
export function runAction(btn: HTMLButtonElement, fn: () => Promise<void>) {
  return async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong', true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
    }
  };
}

/** A copy button that confirms on the button itself, not only with a pop-up. */
export function copyButton(value: string): HTMLButtonElement {
  const label = h('span', null, 'Copy');
  const btn = h('button', { type: 'button', class: 'copy-btn' }, icon('copy', 14), label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast('Copy failed: select the text and copy it by hand.', true);
      return;
    }
    btn.classList.add('copied');
    label.textContent = 'Copied';
    btn.replaceChild(icon('check', 14), btn.firstChild!);
    setTimeout(() => {
      btn.classList.remove('copied');
      label.textContent = 'Copy';
      btn.replaceChild(icon('copy', 14), btn.firstChild!);
    }, 1400);
  });
  return btn;
}

/** The theme toggle's icon follows the theme in effect: a moon in light mode, a sun in dark. */
export function effectiveTheme(): 'light' | 'dark' {
  return (document.documentElement.dataset.theme as 'light' | 'dark' | undefined) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
