import { copyButton, h } from './dom';
import { more } from './ui';

export function copyField(value: string, multiline = false, rows = 3) {
  const control = multiline ? h('textarea', { readOnly: true, value, rows }) : h('input', { type: 'text', readOnly: true, value });
  // Selecting the whole value with one click makes copying by hand easy too.
  control.addEventListener('focus', () => (control as HTMLInputElement).select());
  return h('div', { class: 'copy-row' }, control, copyButton(value));
}

export function secretBox(title: string, secret: string, hint: string) {
  return h('div', { class: 'secret-box' }, h('strong', null, title), copyField(secret), h('div', { class: 'small' }, hint));
}

/**
 * The two ways to put the script on a website, each with its own copy box: Google Tag Manager (a loader that builds the
 * script element) and a plain tag for a site whose pages the brand edits. Older servers send only the plain tag.
 */
export function installOptions(k: { snippet: string; gtmSnippet?: string }): HTMLElement {
  const option = (title: string, hint: string, code: string, rows: number) =>
    h('div', { class: 'stack tight' }, h('div', { class: 'step-title' }, title), h('p', { class: 'muted small' }, hint), copyField(code, true, rows));
  return h(
    'div',
    { class: 'stack' },
    k.gtmSnippet ? option('Google Tag Manager', 'Add a Custom HTML tag with this code, set it to fire on All Pages, then Preview and Publish. Remove any older tracker tag first.', k.gtmSnippet, 9) : null,
    option('Direct website installation', 'Paste this on every page of the website, just before </head>.', k.snippet, 3),
    more(
      'How to check it works',
      h('p', { class: 'muted small' }, 'Open the website, then in the browser console type:'),
      h('pre', { class: 'code-block' }, 'typeof window.datahash   // "object" when the script loaded and has its settings'),
      h('p', { class: 'muted small' }, 'If the brand had a tracker tag before, remove it so the script is not loaded twice. Loading the script does not prove that sign-ups or logins are captured on their own: a successful /identify call (status "ok" in the network tab) confirms a customer was stored.'),
    ),
  );
}
