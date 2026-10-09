import { ApiError, api, getToken, setToken, setUnauthorizedHandler } from './api';
import { showBrand } from './brand';
import { renderBrands } from './brands';
import type { Meta, SendOverview, Tenant } from './types';
import { field, h, runAction, skeleton, textInput, themeButton, toast } from './dom';

const SLOW_MS = 160;

/**
 * Builds the page frame once (top bar, main area, toasts) and then only ever swaps what is inside the main area, so
 * moving around never redraws the top bar or flashes the screen. Each navigation gets a number; an answer that
 * arrives after you have moved on is discarded.
 */
export function startApp(root: HTMLElement): { route: () => Promise<void>; stop: () => void } {
  const view = h('main', { id: 'view', class: 'page', tabindex: '-1' });
  const signOut = h('button', { type: 'button' }, 'Sign out');
  const toasts = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
  const skip = h('a', { class: 'skip-link', href: '#/' }, 'Skip to content');
  skip.addEventListener('click', (e) => {
    e.preventDefault(); // a normal "#view" link would change the address and trigger the router
    view.focus();
  });

  root.replaceChildren(
    skip,
    h(
      'header',
      { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), 'Conversions Console'),
      h('div', { class: 'row' }, themeButton(), signOut),
    ),
    view,
    toasts,
  );

  let nav = 0;
  let metaPromise: Promise<Meta> | null = null;
  const loadMeta = () => (metaPromise ??= api<Meta>('GET', '/meta').catch((e) => { metaPromise = null; throw e; }));

  const leave = () => {
    setToken(null);
    metaPromise = null;
    location.hash = '#/';
    void route();
  };
  signOut.addEventListener('click', leave);
  setUnauthorizedHandler(() => {
    toast('Signed out: that token is no longer accepted.', true);
    leave();
  });

  function show(page: HTMLElement, focus: string | null = 'h1') {
    view.replaceChildren(page);
    window.scrollTo(0, 0); // a different page starts at the top
    page.classList.add('enter');
    if (focus) (page.querySelector(focus) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  function showLogin() {
    signOut.hidden = true;
    document.title = 'Sign in · Conversions Console';
    const token = textInput('', { type: 'password', autocomplete: 'current-password' });
    const error = h('div', { class: 'alert', hidden: true, role: 'alert' });
    const button = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
    const submit = (e: Event) => {
      e.preventDefault();
      error.hidden = true;
      void runAction(button, async () => {
        const value = token.value.trim();
        try {
          await api('GET', '/me', undefined, value);
        } catch (err) {
          error.textContent = err instanceof ApiError && err.status === 401 ? 'That token is not right.' : err instanceof ApiError && err.status === 429 ? err.message : 'Could not reach the server.';
          error.hidden = false;
          token.focus();
          token.select();
          return;
        }
        setToken(value);
        await route();
      })();
    };
    show(
      h(
        'div',
        { class: 'login card beam spot' },
        h('h1', { tabindex: '-1' }, h('span', { class: 'gradient-text' }, 'Conversions'), ' Console'),
        h('p', { class: 'muted' }, 'Sign in to manage brands, connections and sales.'),
        error,
        h('form', { onsubmit: submit }, field('token', 'Admin token', token, 'The ADMIN_TOKEN set on the server.').wrap, button),
      ),
      null,
    );
    token.focus();
  }

  async function showBrands(current: () => boolean) {
    document.title = 'Brands · Conversions Console';
    const timer = setTimeout(() => current() && view.replaceChildren(skeleton('rows')), SLOW_MS);
    let tenants: Tenant[];
    let meta: Meta;
    let sending: SendOverview | null = null;
    try {
      [{ tenants }, meta, sending] = await Promise.all([api<{ tenants: Tenant[] }>('GET', '/tenants'), loadMeta(), api<SendOverview>('GET', '/sending').catch(() => null)]);
    } finally {
      clearTimeout(timer);
    }
    if (!current()) return;
    show(renderBrands(tenants, meta, (id) => (location.hash = `#/brand/${id}/overview`), sending));
  }

  function showError(e: unknown, notFound?: string) {
    document.title = 'Something went wrong · Conversions Console';
    const missing = e instanceof ApiError && e.status === 404;
    show(
      h(
        'div',
        { class: 'card empty' },
        h('h1', { tabindex: '-1', style: 'font-size:1.2rem' }, missing && notFound ? notFound : 'Something went wrong'),
        missing ? null : h('div', { class: 'alert' }, e instanceof Error ? e.message : 'Could not load this page.'),
        h('div', { class: 'row', style: 'justify-content:center' }, h('a', { href: '#/' }, 'Back to brands'), missing ? null : h('button', { type: 'button', onclick: () => void route() }, 'Try again')),
      ),
    );
  }

  async function route(): Promise<void> {
    const my = ++nav;
    const current = () => my === nav;
    if (!getToken()) return showLogin();
    signOut.hidden = false;

    const parts = location.hash.replace(/^#\/?/, '').split('/');
    try {
      if (parts[0] === 'brand' && parts[1]) await showBrand(view, parts[1], parts[2] ?? 'overview', loadMeta, current);
      else await showBrands(current);
    } catch (e) {
      if (current()) showError(e, parts[0] === 'brand' ? 'Brand not found' : undefined);
    }
  }

  const onHashChange = () => void route();
  window.addEventListener('hashchange', onHashChange);
  void route();
  return { route, stop: () => window.removeEventListener('hashchange', onHashChange) };
}
