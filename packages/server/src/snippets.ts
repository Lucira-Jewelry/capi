/**
 * The two ways a brand puts our script on its website, built from the brand's real settings.
 *
 * - `script`: the normal tag, for a site whose HTML the brand edits directly.
 * - `gtm`: a small loader for a Google Tag Manager "Custom HTML" tag. It creates the script element and sets its
 *   attributes before adding it to the page. In one brand's Tag Manager install the plain tag loaded tracker.js but the
 *   attributes were missing on the resulting element (so the script did nothing); this loader worked there. The cause
 *   of the missing attributes was not established, so the loader is offered as the Tag Manager option, not as a fix
 *   for a known Tag Manager behaviour.
 *
 * Every value is escaped for the place it lands (HTML attribute, or JavaScript string inside an HTML <script>), so a
 * value can never end the tag or the string early.
 */
export interface InstallConfig {
  /** Full address of the script file, e.g. https://track.brand.com/tracker.js */
  trackerUrl: string;
  /** The brand's public site key. */
  key: string;
  /** Where the script sends its data (the tracking address). */
  endpoint: string;
  /** opt_in is the script's own default, so it is not written out. */
  consentMode: 'opt_in' | 'opt_out';
  /** Only written when set: two-letter code the script reports with its calls. */
  country?: string;
  /** Only written when false (the script turns the collector-set cookie on by default). */
  serverCookie?: boolean;
}

export interface InstallSnippets {
  script: string;
  gtm: string;
}

/** Text for a double-quoted HTML attribute. */
export const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A single-quoted JavaScript string literal that is also safe inside an HTML <script> element: no raw quote,
 * backslash, line break, "<" (so "</script>" cannot appear), ">" or "&".
 */
export function jsString(v: string): string {
  const body = v
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${body}'`;
}

/** The data-* settings, in the order they are written. Same list feeds both snippets, so they cannot disagree. */
function dataAttributes(c: InstallConfig): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['data-key', c.key],
    ['data-endpoint', c.endpoint],
  ];
  if (c.consentMode === 'opt_out') out.push(['data-consent-mode', 'opt_out']);
  if (c.country && /^[A-Za-z]{2}$/.test(c.country)) out.push(['data-country', c.country.toUpperCase()]);
  if (c.serverCookie === false) out.push(['data-server-cookie', 'false']);
  return out;
}

export function installSnippets(c: InstallConfig): InstallSnippets {
  const attrs = dataAttributes(c);
  const script = `<script src="${escapeAttr(c.trackerUrl)}" ${attrs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(' ')} async></script>`;
  const gtm = [
    '<script>',
    '(function () {',
    "  var s = document.createElement('script');",
    ...attrs.map(([k, v]) => `  s.setAttribute(${jsString(k)}, ${jsString(v)});`),
    `  s.src = ${jsString(c.trackerUrl)};`,
    '  s.async = true;',
    '  document.head.appendChild(s);',
    '})();',
    '</script>',
  ].join('\n');
  return { script, gtm };
}
