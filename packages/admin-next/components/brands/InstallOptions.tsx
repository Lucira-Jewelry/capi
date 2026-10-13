'use client';
import { CopyField } from '@/components/ui';

function Option({ title, hint, code, rows }: { title: string; hint: string; code: string; rows: number }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{title}</div>
      <p className="text-xs text-muted">{hint}</p>
      <CopyField value={code} multiline rows={rows} />
    </div>
  );
}

/**
 * The two ways to put the script on a website, each with its own copy box: Google Tag Manager (a loader that builds the
 * script element) and a plain tag for a site whose pages the brand edits. Older servers send only the plain tag.
 */
export function InstallOptions({ snippet, gtmSnippet }: { snippet: string; gtmSnippet?: string }) {
  return (
    <div className="space-y-4">
      {gtmSnippet && <Option title="Google Tag Manager" hint="Add a Custom HTML tag with this code, set it to fire on All Pages, then Preview and Publish. Remove any older tracker tag first." code={gtmSnippet} rows={9} />}
      <Option title="Direct website installation" hint="Paste this on every page of the website, just before </head>." code={snippet} rows={3} />
      <details className="rounded-lg border border-border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">How to check it works</summary>
        <p className="mt-2 text-xs text-muted">Open the website, then in the browser console type:</p>
        <pre className="mt-1 overflow-x-auto rounded-md bg-surface-2 p-2 text-xs">{'typeof window.datahash   // "object" when the script loaded and has its settings'}</pre>
        <p className="mt-2 text-xs text-muted">If the brand had a tracker tag before, remove it so the script is not loaded twice. Loading the script does not prove that sign-ups or logins are captured on their own: a successful /identify call (status &quot;ok&quot; in the network tab) confirms a customer was stored.</p>
      </details>
    </div>
  );
}
