'use client';
import type { ReactNode } from 'react';

/** "a, b ,c" -> ["a","b","c"] */
export const csvToList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/** A collapsed section for the less common things, so the main view stays short. */
export function More({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-surface-2/50 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-muted hover:text-text">{summary}</summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

export const CodeBlock = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-relaxed">{children}</pre>
);

export const StepTitle = ({ children }: { children: ReactNode }) => <div className="text-sm font-semibold">{children}</div>;
