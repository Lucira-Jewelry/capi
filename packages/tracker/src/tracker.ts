import { buildFbc, hasClickId, parseClickIds } from '@datahash/core/clickids';

export type ConsentState = 'granted' | 'denied' | 'unknown';

export interface TrackerConfig {
  /** Public site key, issued per brand site. */
  key: string;
  /** Base URL of the collector, e.g. https://track.brand.com */
  endpoint: string;
  /** Default country for phone numbers without a country code (server side). */
  country?: string;
  /**
   * opt_in: store click IDs and send data only after consent is granted (until then they are held in memory).
   * opt_out: store unless the visitor declined.
   */
  consentMode?: 'opt_in' | 'opt_out';
  /** Read the brand's consent banner. Default: whatever was passed to setConsent(), else 'unknown'. */
  getConsent?: () => ConsentState;
  /** Watch form submits for phone/email fields. Default true. */
  autoBind?: boolean;
  /**
   * Also ask the collector to remember the click in a signed first-party cookie it sets on the brand's own tracking
   * address (only works when the endpoint is that address; elsewhere the collector says "skipped"). The script tag
   * turns this on; leave it off in the library for tests. Default false.
   */
  serverCookie?: boolean;
  /** Max touches kept: the first plus the most recent ones. Default 5. */
  maxTouches?: number;
  /** Days to keep stored click IDs in the browser. Default 90 (Safari may cap this at about 7). */
  retentionDays?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface StoredTouch {
  clickedAt: number;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  fbc?: string;
  ctwaClid?: string;
  utm?: Record<string, string>;
  landingUrl?: string;
}

export interface IdentifyResult {
  sent: boolean;
  reason?: 'no_consent' | 'no_contact' | 'duplicate' | 'network_error' | 'rejected';
}

const DAY_MS = 24 * 60 * 60 * 1000;

const sig = (t: StoredTouch) =>
  [t.clickedAt, t.gclid, t.gbraid, t.wbraid, t.fbclid, t.ctwaClid].map((v) => v ?? '').join('|');

/** Same click (same IDs), whenever it was read. A reload of the landing page must not become a "new" click. */
const idsOf = (t: Pick<StoredTouch, 'gclid' | 'gbraid' | 'wbraid' | 'fbclid' | 'ctwaClid'>) =>
  [t.gclid, t.gbraid, t.wbraid, t.fbclid, t.ctwaClid].map((v) => v ?? '').join('|');

/**
 * Short fingerprint for "have I already sent this?". Not a security hash: it only keeps phone numbers and
 * emails out of sessionStorage.
 */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b + text.charCodeAt(i), 2246822519) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function rootDomain(): string | undefined {
  const parts = location.hostname.split('.');
  if (parts.length < 2 || /^\d+$/.test(parts[parts.length - 1] ?? '')) return undefined;
  for (let i = parts.length - 2; i >= 0; i--) {
    const d = parts.slice(i).join('.');
    document.cookie = `dh_test=1;domain=${d};path=/;max-age=10`;
    if (document.cookie.includes('dh_test=1')) {
      document.cookie = `dh_test=;domain=${d};path=/;max-age=0`;
      return d;
    }
  }
  return undefined;
}

export function extractContact(form: HTMLFormElement): { phone?: string; email?: string } {
  const out: { phone?: string; email?: string } = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el || el.tagName !== 'INPUT' || el.type === 'password') continue;
    const value = (el.value || '').trim();
    if (!value) continue;
    const hint = `${el.type} ${el.name} ${el.id} ${el.autocomplete}`.toLowerCase();
    if (!out.email && (el.type === 'email' || /e-?mail/.test(hint)) && value.includes('@')) {
      out.email = value;
    } else if (
      !out.phone &&
      (el.type === 'tel' || /phone|mobile|whatsapp|contact/.test(hint)) &&
      value.replace(/\D/g, '').length >= 7
    ) {
      out.phone = value;
    }
  }
  return out;
}

export function createTracker(config: TrackerConfig) {
  // Storage names carry the site key, so two brands (or two keys) on one origin never read each other's data.
  const safeKey = config.key.replace(/[^A-Za-z0-9_]/g, '_');
  const LS_KEY = `dh_touches:${config.key}`;
  const COOKIE_KEY = `dh_t_${safeKey}`;
  const SENT_KEY = `dh_sent:${config.key}`;
  const serverCookie = config.serverCookie === true;
  const consentMode = config.consentMode ?? 'opt_in';
  const maxTouches = config.maxTouches ?? 5;
  const retentionDays = config.retentionDays ?? 90;
  const now = config.now ?? (() => Date.now());
  const doFetch = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  let manualConsent: ConsentState = 'unknown';
  let pending: StoredTouch[] = []; // captured while consent is unknown; memory only
  const sentSignatures = new Set<string>(safe(() => JSON.parse(sessionStorage.getItem(SENT_KEY) ?? '[]') as string[], []));
  /** Kept in memory only, so setConsent(false) can tell the server who withdrew. Never written to storage. */
  let lastContact: { phone?: string; email?: string } | undefined;

  // The brand's banner hook wins when it has an answer; otherwise use what setConsent() recorded.
  const consent = (): ConsentState => {
    const fromBanner = config.getConsent ? config.getConsent() : 'unknown';
    return fromBanner !== 'unknown' ? fromBanner : manualConsent;
  };
  const canStore = () => {
    const c = consent();
    return consentMode === 'opt_in' ? c === 'granted' : c !== 'denied';
  };

  function readStored(): StoredTouch[] {
    const fromLs = safe(() => JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as StoredTouch[], []);
    const fromCookie = safe(() => {
      const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_KEY}=([^;]*)`));
      return m ? (JSON.parse(decodeURIComponent(m[1] ?? '')) as StoredTouch[]) : [];
    }, []);
    return merge([...fromLs, ...fromCookie]);
  }

  function merge(touches: StoredTouch[]): StoredTouch[] {
    const cutoff = now() - retentionDays * DAY_MS;
    const bySig = new Map<string, StoredTouch>();
    for (const t of touches) {
      if (t && typeof t.clickedAt === 'number' && t.clickedAt >= cutoff) bySig.set(sig(t), t);
    }
    const sorted = [...bySig.values()].sort((a, b) => a.clickedAt - b.clickedAt);
    if (sorted.length <= maxTouches) return sorted;
    return [sorted[0]!, ...sorted.slice(sorted.length - (maxTouches - 1))];
  }

  function persist(touches: StoredTouch[]) {
    safe(() => localStorage.setItem(LS_KEY, JSON.stringify(touches)), undefined);
    // The cookie mirror keeps only the first and latest touch to stay well under the 4 KB cookie limit.
    const compact = touches.length > 2 ? [touches[0]!, touches[touches.length - 1]!] : touches;
    safe(() => {
      const domain = rootDomain();
      const secure = location.protocol === 'https:' ? ';Secure' : '';
      document.cookie =
        `${COOKIE_KEY}=${encodeURIComponent(JSON.stringify(compact))};path=/;max-age=${retentionDays * 86400};SameSite=Lax` +
        (domain ? `;domain=${domain}` : '') +
        secure;
    }, undefined);
  }

  /** Best effort: the click is already safe in the browser, the cookie is a second, longer-lived copy. */
  async function post(path: string, payload: unknown) {
    try {
      const res = await doFetch(`${config.endpoint.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload),
        keepalive: true,
        // Lets the browser send and store the first-party cookie on this request.
        credentials: 'include',
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function sendTouchToServer(t: StoredTouch) {
    if (!serverCookie) return;
    const touch: Record<string, unknown> = { clickedAt: t.clickedAt };
    for (const k of ['gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'ctwaClid', 'utm'] as const) if (t[k] !== undefined) touch[k] = t[k];
    void post('/touch', { key: config.key, consent: consent() === 'granted' ? true : undefined, touch });
  }

  function addTouch(touch: StoredTouch) {
    if (canStore()) {
      persist(merge([...readStored(), ...pending, touch]));
      sendTouchToServer(touch);
    } else pending = merge([...pending, touch]);
  }

  /** Read the landing URL and keep any click IDs. Called once at start. */
  function capture(): StoredTouch | null {
    const ids = parseClickIds(location.href);
    if (!hasClickId(ids)) return null;
    const existing = [...readStored(), ...pending].find((t) => idsOf(t) === idsOf(ids));
    if (existing) return existing; // same click seen again (reload, back button): keep the original time
    const clickedAt = now();
    const touch: StoredTouch = { clickedAt, landingUrl: location.origin + location.pathname };
    if (ids.gclid) touch.gclid = ids.gclid;
    if (ids.gbraid) touch.gbraid = ids.gbraid;
    if (ids.wbraid) touch.wbraid = ids.wbraid;
    if (ids.fbclid) {
      touch.fbclid = ids.fbclid;
      touch.fbc = buildFbc(ids.fbclid, clickedAt);
    }
    if (ids.ctwaClid) touch.ctwaClid = ids.ctwaClid;
    if (Object.keys(ids.utm).length) touch.utm = ids.utm;
    addTouch(touch);
    return touch;
  }

  /** Remove everything this script keeps in the browser for this site key. */
  function clearLocal() {
    pending = [];
    sentSignatures.clear();
    safe(() => localStorage.removeItem(LS_KEY), undefined);
    safe(() => sessionStorage.removeItem(SENT_KEY), undefined);
    safe(() => {
      const domain = rootDomain();
      document.cookie = `${COOKIE_KEY}=;path=/;max-age=0`;
      if (domain) document.cookie = `${COOKIE_KEY}=;path=/;max-age=0;domain=${domain}`;
    }, undefined);
  }

  /**
   * The visitor withdrew consent: clear everything stored here and, when we know who they are (they identified
   * in this page view, or the caller passes their contact), tell the server so queued sales are not sent.
   */
  async function withdraw(contact?: { phone?: string; email?: string }): Promise<{ notified: boolean }> {
    const who = contact ?? lastContact;
    manualConsent = 'denied';
    clearLocal();
    lastContact = undefined;
    // The first-party cookie goes too, whether or not we know who the visitor is.
    if (serverCookie) void post('/touch', { key: config.key, clear: true });
    if (!who?.phone && !who?.email) return { notified: false };
    try {
      const res = await doFetch(`${config.endpoint.replace(/\/$/, '')}/consent`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ key: config.key, phone: who.phone, email: who.email }),
        keepalive: true,
        credentials: 'include',
      });
      return { notified: res.ok };
    } catch {
      return { notified: false };
    }
  }

  function setConsent(granted: boolean) {
    if (!granted) {
      void withdraw();
      return;
    }
    manualConsent = 'granted';
    if (pending.length) {
      const held = pending;
      persist(merge([...readStored(), ...held]));
      pending = [];
      held.forEach(sendTouchToServer);
    }
  }

  function touches(): StoredTouch[] {
    return merge([...(canStore() ? readStored() : []), ...pending]);
  }

  async function identify(contact: { phone?: string; email?: string }): Promise<IdentifyResult> {
    if (!contact.phone && !contact.email) return { sent: false, reason: 'no_contact' };
    if (!canStore()) return { sent: false, reason: 'no_consent' };

    lastContact = { ...(contact.phone ? { phone: contact.phone } : {}), ...(contact.email ? { email: contact.email } : {}) };
    const all = touches();
    const c = consent();
    const payload = {
      key: config.key,
      phone: contact.phone,
      email: contact.email,
      country: config.country,
      consent: c === 'unknown' ? undefined : { ads: c === 'granted' },
      touches: all,
    };

    const signature = fingerprint(JSON.stringify([payload.phone, payload.email, all.map(sig)]));
    if (sentSignatures.has(signature)) return { sent: false, reason: 'duplicate' };

    try {
      // text/plain keeps this a "simple" cross-origin request, so no CORS preflight is needed.
      const res = await doFetch(`${config.endpoint.replace(/\/$/, '')}/identify`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: 'include',
      });
      if (!res.ok) return { sent: false, reason: 'rejected' };
    } catch {
      return { sent: false, reason: 'network_error' };
    }

    sentSignatures.add(signature);
    safe(() => sessionStorage.setItem(SENT_KEY, JSON.stringify([...sentSignatures])), undefined);
    return { sent: true };
  }

  function bindForms() {
    document.addEventListener(
      'submit',
      (event) => {
        const form = event.target as HTMLFormElement | null;
        if (!form || form.tagName !== 'FORM') return;
        const contact = extractContact(form);
        if (contact.phone || contact.email) void identify(contact);
      },
      true,
    );
  }

  if (consent() === 'denied') clearLocal();
  capture();
  if (config.autoBind !== false) bindForms();

  return { identify, setConsent, withdraw, touches, capture };
}

export type Tracker = ReturnType<typeof createTracker>;
