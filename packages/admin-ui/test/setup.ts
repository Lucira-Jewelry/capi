import { vi } from 'vitest';

/** The few browser features the simulated browser (jsdom) lacks, so the console can run in tests. */
export function installBrowserShims() {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  window.scrollTo = vi.fn() as never;
}

type Handler = (body: unknown) => unknown | Promise<unknown>;

/** A fake server: maps "METHOD /path" to an answer (or a function giving one). Records every call. */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${u.pathname.replace('/admin/api', '')}`;
    calls.push(key);
    const handler = handlers[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as Response;
    const body = await handler(init?.body ? JSON.parse(String(init.body)) : undefined);
    if (body && typeof body === 'object' && '__status' in body) {
      const { __status, ...rest } = body as { __status: number };
      return { ok: false, status: __status, json: async () => rest } as Response;
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as never;
  return { calls };
}

/** A promise you resolve by hand, to hold an answer back and see what the page does meanwhile. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
