export interface ParsedClickIds {
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  ctwaClid?: string;
  utm: Record<string, string>;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

/** Read click IDs and UTMs from a landing URL (or just its query string). */
export function parseClickIds(urlOrQuery: string): ParsedClickIds {
  const query = urlOrQuery.includes('?') ? urlOrQuery.slice(urlOrQuery.indexOf('?') + 1).split('#')[0]! : urlOrQuery;
  const params = new URLSearchParams(query);
  const result: ParsedClickIds = { utm: {} };

  const gclid = params.get('gclid');
  const gbraid = params.get('gbraid');
  const wbraid = params.get('wbraid');
  const fbclid = params.get('fbclid');
  const ctwa = params.get('ctwa_clid');
  if (gclid) result.gclid = gclid;
  if (gbraid) result.gbraid = gbraid;
  if (wbraid) result.wbraid = wbraid;
  if (fbclid) result.fbclid = fbclid;
  if (ctwa) result.ctwaClid = ctwa;

  for (const key of UTM_KEYS) {
    const v = params.get(key);
    if (v) result.utm[key] = v;
  }
  return result;
}

export function hasClickId(ids: ParsedClickIds): boolean {
  return Boolean(ids.gclid || ids.gbraid || ids.wbraid || ids.fbclid || ids.ctwaClid);
}

/**
 * Meta's fbc format: fb.<subdomainIndex>.<clickTimeMs>.<fbclid>
 * subdomainIndex is 1 for a root domain cookie. Always use the ORIGINAL click time, never "now" later on.
 */
export function buildFbc(fbclid: string, clickTimeMs: number, subdomainIndex = 1): string {
  return `fb.${subdomainIndex}.${clickTimeMs}.${fbclid}`;
}
