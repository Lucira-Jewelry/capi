'use client';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-xl border border-border bg-surface', className)}>{children}</div>;
}

export function Button({ variant = 'default', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' }) {
  const look =
    variant === 'primary'
      ? 'bg-accent text-accent-contrast border-transparent hover:opacity-90'
      : variant === 'danger'
        ? 'bg-bad-bg text-bad border-transparent hover:opacity-90'
        : 'bg-surface text-text border-border hover:bg-surface-2';
  return <button type="button" {...p} className={cx('inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50', look, className)} />;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const look = tone === 'ok' ? 'bg-ok-bg text-ok' : tone === 'warn' ? 'bg-warn-bg text-warn' : tone === 'bad' ? 'bg-bad-bg text-bad' : 'bg-surface-2 text-muted';
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', look)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-lg bg-surface-2', className)} />;
}

/** An on/off switch with a visible label, announced as a switch to screen readers. */
export function Switch({ on, label, busy, onChange }: { on: boolean; label: string; busy?: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className="group inline-flex h-9 items-center gap-2.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
    >
      <span className={cx('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-accent' : 'bg-border')}>
        <span className={cx('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', on && 'translate-x-4')} />
      </span>
      {on ? 'Sending on' : 'Sending off'}
    </button>
  );
}

// ---- toasts ---------------------------------------------------------------------------------------------
type Toast = { id: number; text: string; bad: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l, { id, text, bad }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), bad ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div key={t.id} role={t.bad ? 'alert' : 'status'} className={cx('pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-sm shadow-lg', t.bad ? 'border-transparent bg-bad-bg text-bad' : 'border-border bg-surface text-text')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- modal and form pieces --------------------------------------------------------------------------------
/**
 * A dialog over the page, using the browser's own modal dialog: the page behind it cannot be reached by keyboard or
 * pointer, Tab stays inside, Escape closes it, and dialogs opened from a dialog stack correctly.
 */
export function Modal({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!open || !d) return;
    const before = document.activeElement as HTMLElement | null;
    if (typeof d.showModal === 'function') {
      if (!d.open) d.showModal();
    } else {
      d.setAttribute('open', ''); // environments without modal dialogs (the test DOM)
    }
    // The browser focuses the first control, which is the close button: start on the first field instead.
    (d.querySelector<HTMLElement>('input:not([readonly]):not([type=hidden]), textarea, select, button:not([aria-label=Close])') ?? d.querySelector<HTMLElement>('button'))?.focus();
    return () => {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
      before?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className={cx('m-auto max-h-[90vh] w-full overflow-y-auto rounded-xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/40', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mt-1 -mr-1 rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-text">✕</button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </dialog>
  );
}

const control = 'w-full rounded-lg border border-border bg-bg px-3 text-sm placeholder:text-muted/70';

/** A label, the control, and an optional hint, wired together for screen readers. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <div className="mt-1.5">{children({ id, ...(hint ? { 'aria-describedby': hintId } : {}) })}</div>
      {hint && <p id={hintId} className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(control, 'h-10', className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(control, 'py-2 font-mono text-xs', className)} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(control, 'h-10', className)} />;

/** A read-only value with a copy button that says it copied. */
export function CopyField({ value, multiline, rows = 3 }: { value: string; multiline?: boolean; rows?: number }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* the text is selectable, so it can still be copied by hand */
    }
  };
  return (
    <div className="flex items-start gap-2">
      {multiline ? <Textarea readOnly rows={rows} value={value} onFocus={(e) => e.currentTarget.select()} /> : <Input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />}
      <Button onClick={copy} className="shrink-0">{done ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

/** Runs an async action, keeps the button busy meanwhile, and reports a failure as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong', true);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}

// ---- confirm dialog -------------------------------------------------------------------------------------
export function ConfirmDialog({ open, title, message, confirmLabel, danger, onConfirm, onCancel }: { open: boolean; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p className="text-sm text-muted">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
