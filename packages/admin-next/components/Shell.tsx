'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { legacyTarget } from '@/lib/legacy';
import { Button } from './ui';

const THEME_KEY = 'console_theme';

function ThemeButton() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)), []);
  const flip = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* the choice just lasts until the page closes */ }
    setDark(!dark);
  };
  return <Button onClick={flip} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} className="w-9 px-0">{dark ? '☀' : '☾'}</Button>;
}

/** Sends an old-style #/brand/... address to the page that replaced it. */
function LegacyLinks() {
  const router = useRouter();
  useEffect(() => {
    const go = () => {
      const target = legacyTarget(location.hash);
      if (target) router.replace(target);
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [router]);
  return null;
}

export function Shell({ children }: { children: ReactNode }) {
  const { signedIn, signOut } = useAuth();
  return (
    <>
      <LegacyLinks />
      <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <span aria-hidden className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-sm text-accent-contrast">C</span>
            Conversions Console
          </Link>
          <div className="flex items-center gap-2">
            <ThemeButton />
            {signedIn && <Button onClick={signOut}>Sign out</Button>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </>
  );
}
