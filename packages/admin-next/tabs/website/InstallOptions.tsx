'use client';
import { CopyField } from '@/components/ui';
import type { SiteKey } from '@/lib/types';
import { CodeBlock, More, StepTitle } from './util';

/**
 * The two ways to put the script on a website, each with its own copy box: Google Tag Manager (a loader that builds the
 * script element) and a plain tag for a site whose pages the brand edits. Older servers send only the plain tag.
 */
export function InstallOptions({ site }: { site: Pick<SiteKey, 'snippet' | 'gtmSnippet'> }) {
  return (
    <div className="space-y-5">
      {site.gtmSnippet && (
        <Option title="Google Tag Manager" hint="Add a Custom HTML tag with this code, set it to fire on All Pages, then Preview and Publish. Remove any older tracker tag first." code={site.gtmSnippet} rows={9} />
      )}
      <Option title="Direct website installation" hint="Paste this on every page of the website, just before </head>." code={site.snippet} rows={3} />
      <More summary="How to check it works">
        <p className="text-sm text-muted">Open the website, then in the browser console type:</p>
        <CodeBlock>{'typeof window.datahash   // "object" when the script loaded and has its settings'}</CodeBlock>
        <p className="text-sm text-muted">
          If the brand had a tracker tag before, remove it so the script is not loaded twice. Loading the script does not prove that sign-ups or logins are captured on their own: a successful /identify call (status
          &quot;ok&quot; in the network tab) confirms a customer was stored.
        </p>
      </More>
    </div>
  );
}

function Option({ title, hint, code, rows }: { title: string; hint: string; code: string; rows: number }) {
  return (
    <div className="space-y-1.5">
      <StepTitle>{title}</StepTitle>
      <p className="text-sm text-muted">{hint}</p>
      <CopyField value={code} multiline rows={rows} />
    </div>
  );
}
