import Link from 'next/link';
import type { ReactNode } from 'react';

/** A link that looks like a button, for moving to another tab. */
export function LinkButton({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  const look = primary ? 'bg-accent text-accent-contrast border-transparent hover:opacity-90' : 'bg-surface text-text border-border hover:bg-surface-2';
  return (
    <Link href={href} className={`inline-flex h-9 shrink-0 items-center justify-center rounded-lg border px-3.5 text-sm font-medium transition ${look}`}>
      {children}
    </Link>
  );
}
