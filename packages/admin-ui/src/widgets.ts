import { copyButton, h } from './dom';

export function copyField(value: string, multiline = false) {
  const control = multiline ? h('textarea', { readOnly: true, value, rows: 3 }) : h('input', { type: 'text', readOnly: true, value });
  // Selecting the whole value with one click makes copying by hand easy too.
  control.addEventListener('focus', () => (control as HTMLInputElement).select());
  return h('div', { class: 'copy-row' }, control, copyButton(value));
}

export function secretBox(title: string, secret: string, hint: string) {
  return h('div', { class: 'secret-box' }, h('strong', null, title), copyField(secret), h('div', { class: 'small' }, hint));
}
