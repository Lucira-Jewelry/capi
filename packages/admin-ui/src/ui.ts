import { closeDialog, h, openDialog, runAction, type Child } from './dom';

/**
 * A dialog with a title, one line of explanation, the form, and Cancel plus a main button that stays in view.
 * `onSubmit` runs with a spinner on the button; the dialog closes when it finishes, and stays open (with the error
 * shown as a message) when it throws. Return `false` from it to keep the dialog open without an error.
 */
export function formDialog(opts: {
  title: string;
  lead?: string;
  body: Child[];
  submitLabel: string;
  onSubmit: () => Promise<void | false>;
  /** Extra button at the left of the footer, for example Disconnect. */
  extra?: HTMLElement | null;
  wide?: boolean;
  /** No Cancel / submit pair: just a Close button (for read-only dialogs). */
  closeOnly?: boolean;
  /** The main button is red: for something that cannot be undone. */
  danger?: boolean;
}): HTMLDialogElement {
  const dialog = h('dialog', { 'aria-label': opts.title, class: opts.wide ? 'wide' : '' }) as HTMLDialogElement;
  const cancel = h('button', { type: 'button', onclick: () => closeDialog(dialog) }, opts.closeOnly ? 'Close' : 'Cancel');
  const submit = h('button', { class: opts.danger ? 'primary danger-solid' : 'primary', type: 'submit' }, opts.submitLabel);
  const form = h(
    'form',
    { novalidate: true },
    h('h2', null, opts.title),
    opts.lead ? h('p', { class: 'muted lead' }, opts.lead) : null,
    h('div', { class: 'stack tight' }, ...opts.body),
    h('div', { class: 'row dialog-actions' }, opts.extra ? h('span', { class: 'grow' }, opts.extra) : h('span', { class: 'grow' }), cancel, opts.closeOnly ? null : submit),
  );
  const run = runAction(submit, async () => {
    if ((await opts.onSubmit()) !== false) closeDialog(dialog);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
  dialog.append(form);
  openDialog(dialog);
  // Start in the first empty box, so a new user can just type.
  const first = Array.from(dialog.querySelectorAll<HTMLInputElement>('input:not([readonly]):not([type=hidden]):not([type=checkbox]):not([type=file]), textarea:not([readonly])')).find((i) => !i.value);
  (first ?? dialog.querySelector<HTMLElement>('button.primary'))?.focus({ preventScroll: true });
  return dialog;
}

/** A section that is closed until asked for: keeps the rarely needed parts out of a new user's way. */
export function more(summary: string, ...children: Child[]): HTMLElement {
  return h('details', { class: 'more' }, h('summary', null, summary), h('div', { class: 'more-body stack tight' }, ...children));
}

/** One line in a list: what it is, its state, and what you can do with it. */
export function listRow(opts: { title: Child; sub?: Child; badge?: HTMLElement | null; actions?: Array<HTMLElement | null>; alert?: string | null }): HTMLElement {
  return h(
    'div',
    { class: 'card list-row' },
    h(
      'div',
      { class: 'list-main' },
      h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, opts.title, opts.badge ?? null), opts.sub ? h('div', { class: 'list-sub' }, opts.sub) : null),
      h('div', { class: 'list-actions' }, ...(opts.actions ?? []).filter(Boolean)),
    ),
    opts.alert ? h('div', { class: 'alert', style: 'margin-top:12px' }, opts.alert) : null,
  );
}

/** A friendly empty state with one clear button. */
export function emptyState(title: string, text: string, ...actions: HTMLElement[]): HTMLElement {
  return h('div', { class: 'card empty' }, h('h2', null, title), h('p', { class: 'muted' }, text), actions.length ? h('div', { class: 'row center' }, ...actions) : null);
}
