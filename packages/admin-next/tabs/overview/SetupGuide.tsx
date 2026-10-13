import { Card } from '@/components/ui';
import { DEST_LABEL, type TenantView } from '@/lib/types';
import { LinkButton } from './LinkButton';
import { tabHref } from './links';

interface Step {
  done: boolean;
  title: string;
  hint: string;
  label: string;
  href: string;
}

/** The numbered setup steps for a new brand. */
export function setupSteps(id: string, view: TenantView, sales: number): Step[] {
  const t = view.tenant;
  const connected = (k: string) => view.connections.some((x) => x.kind === k && x.status === 'active');
  const adNames = t.destinations.map((d) => DEST_LABEL[d] ?? d).join(' and ');
  const broken = view.connections.filter((x) => x.status === 'error');
  return [
    { done: view.siteKeys.length > 0, title: 'Add your website', hint: 'So we can see which ad brought each visitor.', label: 'Add website', href: tabHref(id, 'website') },
    { done: Boolean(t.sources.zoho), title: 'Connect your CRM', hint: 'Zoho tells us when a sale is made.', label: 'Set up Zoho', href: tabHref(id, 'crm') },
    broken.length
      ? { done: false, title: 'Fix your ad account connection', hint: `${broken.map((x) => DEST_LABEL[x.kind] ?? x.kind).join(' and ')} stopped accepting sales.`, label: 'Fix', href: tabHref(id, 'connections') }
      : { done: t.destinations.every((d) => connected(d)), title: 'Connect your ad accounts', hint: adNames ? `Sales are sent to ${adNames}.` : 'Choose where sales are sent.', label: 'Connect', href: tabHref(id, 'connections') },
    { done: sales > 0, title: 'Receive your first sale', hint: 'It shows up under Sales soon after a deal is won.', label: 'See sales', href: tabHref(id, 'sales') },
  ];
}

/** Only the next step has a strong button. The caller shows nothing once every step is done. */
export function SetupGuide({ steps }: { steps: Step[] }) {
  const doneCount = steps.filter((s) => s.done).length;
  const current = steps.findIndex((s) => !s.done);
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Get set up</h2>
        <span className="text-sm text-muted">{doneCount} of {steps.length} done</span>
      </div>
      <div role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <ol className="mt-4 space-y-3">
        {steps.map((s, i) => {
          const state = s.done ? 'done' : i === current ? 'current' : 'next';
          return (
            <li key={s.title} data-state={state} aria-current={state === 'current' ? 'step' : undefined} className="flex items-center gap-3">
              <span aria-hidden className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${s.done ? 'bg-ok-bg text-ok' : state === 'current' ? 'bg-accent text-accent-contrast' : 'bg-surface-2 text-muted'}`}>{s.done ? '✓' : i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${s.done ? 'text-muted' : ''}`}>{s.title}{s.done && <span className="sr-only"> (done)</span>}</div>
                {!s.done && <div className="text-xs text-muted">{s.hint}</div>}
              </div>
              {!s.done && <LinkButton href={s.href} primary={state === 'current'}>{s.label}</LinkButton>}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
