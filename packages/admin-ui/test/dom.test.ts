// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDialog, confirmDialog, copyButton, h, icon, relTime, runAction, skeleton, ticker, timeEl, toast } from '../src/dom';
import { installBrowserShims, tick } from './setup';

installBrowserShims();
const NOW = new Date('2026-10-09T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeEach(() => {
  document.body.innerHTML = '<div id="toasts"></div>';
});

describe('relTime', () => {
  it.each([
    [10_000, 'just now'],
    [5 * 60_000, '5 minutes ago'],
    [3 * 3_600_000, '3 hours ago'],
    [24 * 3_600_000, 'yesterday'],
    [3 * 86_400_000, '3 days ago'],
  ])('%i ms ago reads "%s"', (ms, text) => {
    expect(relTime(ago(ms), NOW)).toBe(text);
  });

  it('older than a week is a plain date, with the year only when it is not this year', () => {
    expect(relTime(ago(20 * 86_400_000), NOW)).toMatch(/Sept?\s?19|19\s?Sept?/);
    expect(relTime(new Date('2025-03-02T10:00:00Z'), NOW)).toMatch(/2025/);
  });

  it('copes with the future and with rubbish', () => {
    expect(relTime(new Date(NOW.getTime() + 5_000), NOW)).toBe('in a moment');
    expect(relTime(new Date(NOW.getTime() + 2 * 3_600_000), NOW)).toBe('in 2 hours');
    expect(relTime('not a date', NOW)).toBe('');
    expect(relTime(undefined, NOW)).toBe('');
  });

  it('timeEl keeps the exact moment for hover and for machines', () => {
    const el = timeEl('2026-10-09T10:00:00Z') as HTMLElement;
    expect(el.tagName).toBe('TIME');
    expect(el.getAttribute('datetime')).toBe('2026-10-09T10:00:00.000Z');
    expect(el.title).toMatch(/2026/);
    expect(timeEl(undefined)).toBe('');
  });
});

describe('ticker', () => {
  it('ends on exactly the value, and leaves anything that is not a plain number alone', async () => {
    const el = h('div');
    ticker(el, '42');
    await tick(900);
    expect(el.textContent).toBe('42');
    ticker(el, '29%');
    await tick(900);
    expect(el.textContent).toBe('29%');
    ticker(el, '–');
    expect(el.textContent).toBe('–');
    ticker(el, '0');
    expect(el.textContent).toBe('0');
  });
});

describe('icon', () => {
  it('is a decorative SVG that follows the text colour', () => {
    const svg = icon('check', 20);
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.querySelector('path')).not.toBeNull();
    expect(icon('nope').children.length).toBe(0); // an unknown name draws nothing instead of failing
  });
});

describe('runAction', () => {
  it('shows a spinner while it runs, blocks a second click, and restores the button', async () => {
    const btn = h('button', null, 'Save');
    let finish!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const click = runAction(btn, fn);

    const first = click();
    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains('loading')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await click(); // a second click while busy does nothing
    expect(fn).toHaveBeenCalledTimes(1);

    finish();
    await first;
    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains('loading')).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('a failure becomes a message, and the button works again', async () => {
    const btn = h('button', null, 'Save');
    await runAction(btn, async () => { throw new Error('Nope, that failed'); })();
    expect(document.querySelector('.toast.bad')?.textContent).toContain('Nope, that failed');
    expect(btn.disabled).toBe(false);
  });
});

describe('confirmDialog', () => {
  const open = () => document.querySelector('dialog.confirm') as HTMLDialogElement;

  it('resolves true on the confirm button, false on cancel and on Escape, and removes itself', async () => {
    const yes = confirmDialog({ title: 'Disconnect?', message: 'Sales will wait.', confirmLabel: 'Disconnect', danger: true });
    expect(open().textContent).toContain('Disconnect?');
    const buttons = open().querySelectorAll('button');
    (buttons[1] as HTMLButtonElement).click(); // the confirm button is last
    await tick(200);
    expect(await yes).toBe(true);
    expect(document.querySelector('dialog')).toBeNull();

    const no = confirmDialog({ title: 'Sure?', message: 'x' });
    (open().querySelectorAll('button')[0] as HTMLButtonElement).click();
    await tick(200);
    expect(await no).toBe(false);

    const esc = confirmDialog({ title: 'Sure?', message: 'x' });
    open().dispatchEvent(new Event('cancel', { cancelable: true }));
    await tick(200);
    expect(await esc).toBe(false);
  });

  it('for something destructive the safe button has the focus, so Enter does not confirm by accident', async () => {
    const p = confirmDialog({ title: 'Delete?', message: 'x', danger: true, confirmLabel: 'Delete' });
    expect((document.activeElement as HTMLElement).textContent).toBe('Cancel');
    closeDialog(open());
    await tick(200);
    await p;
  });
});

describe('copyButton', () => {
  it('copies and says so on the button itself, then goes back', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const btn = copyButton('secret-value');
    document.body.append(btn);
    btn.click();
    await tick(10);
    expect(writeText).toHaveBeenCalledWith('secret-value');
    expect(btn.textContent).toBe('Copied');
    expect(btn.classList.contains('copied')).toBe(true);
    await tick(1500);
    expect(btn.textContent).toBe('Copy');
  });
});

describe('toast', () => {
  it('shows at most three, and a click dismisses one', async () => {
    for (let i = 0; i < 5; i++) toast(`message ${i}`);
    const shown = () => Array.from(document.querySelectorAll('.toast'));
    expect(shown()).toHaveLength(3);
    expect(shown()[2]?.textContent).toContain('message 4');
    (shown()[0] as HTMLElement).click();
    await tick(250);
    expect(shown()).toHaveLength(2);
  });

  it('errors are announced as alerts', () => {
    toast('bad thing', true);
    expect(document.querySelector('.toast.bad')?.getAttribute('role')).toBe('alert');
  });
});

describe('skeleton', () => {
  it('is announced as loading and draws placeholder bars', () => {
    const el = skeleton('page');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.querySelectorAll('.skeleton').length).toBeGreaterThan(3);
    expect(el.textContent).toContain('Loading');
  });
});
