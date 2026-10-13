import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
import { ToastProvider } from '@/components/ui';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = { title: 'Conversions Console', robots: { index: false } };

// Applies the saved theme before the first paint, so there is no flash of the wrong one.
const themeScript = `try{var t=localStorage.getItem('console_theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AuthProvider>
          <ToastProvider>
            <Shell>{children}</Shell>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
