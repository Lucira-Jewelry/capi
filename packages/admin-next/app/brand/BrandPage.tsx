'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Login } from '@/components/Login';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/useApi';
import type { Meta, TenantView } from '@/lib/types';
import { AdAccounts } from '@/tabs/AdAccounts';
import { Crm } from '@/tabs/Crm';
import { Overview } from '@/tabs/Overview';
import { Sales } from '@/tabs/Sales';
import { Settings } from '@/tabs/Settings';
import { Website } from '@/tabs/Website';
import type { TabProps } from '@/tabs/types';

const TABS: Array<[string, string, (p: TabProps) => React.ReactElement]> = [
  ['overview', 'Overview', Overview],
  ['connections', 'Ad accounts', AdAccounts],
  ['website', 'Website', Website],
  ['crm', 'CRM', Crm],
  ['sales', 'Sales', Sales],
  ['settings', 'Settings', Settings],
];

export function BrandPage() {
  const { ready, signedIn } = useAuth();
  const params = useSearchParams();
  const id = params.get('id');
  const tab = TABS.find(([key]) => key === params.get('tab'))?.[0] ?? 'overview';
  const ok = ready && signedIn && Boolean(id);
  const view = useApi<TenantView>(ok ? `/tenants/${encodeURIComponent(id!)}` : null);
  const meta = useApi<Meta>(ok ? '/meta' : null);

  // A bookmark opened while signed out asks for the token here and then carries on to the same page.
  if (!ready) return <Skeleton className="h-64" />;
  if (!signedIn) return <Login />;
  if (!id) return <Card className="p-8 text-center text-sm text-muted">No brand chosen. <Link className="text-accent underline" href="/">Back to brands</Link></Card>;
  if (view.error) return <p role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">{view.error} <Link className="underline" href="/">Back to brands</Link></p>;
  if (meta.error) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">
        Could not load the console settings: {meta.error}
        <Button onClick={() => void meta.reload()}>Try again</Button>
        <Link className="underline" href="/">Back to brands</Link>
      </p>
    );
  }
  if (!view.data || !meta.data) return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /></div>;

  const t = view.data.tenant;
  const href = (next: string) => `/brand/?id=${encodeURIComponent(id)}&tab=${next}`;
  const Active = TABS.find(([key]) => key === tab)![2];
  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-muted hover:text-text">← Brands</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t.name}</h1>
          <Badge tone={t.status === 'active' ? 'ok' : 'warn'}>{t.status === 'active' ? 'Active' : 'Suspended'}</Badge>
        </div>
      </div>

      {view.data.sending && !view.data.sending.allowed && (
        <div role="status" className="rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">{view.data.sending.reason ?? 'Sending is switched off on this server.'}</div>
      )}

      <nav aria-label="Brand sections" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(([key, label]) => (
          <Link key={key} href={href(key)} aria-current={tab === key ? 'page' : undefined} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}`}>{label}</Link>
        ))}
      </nav>

      <Active id={id} view={view.data} meta={meta.data} reload={view.reload} />
    </div>
  );
}
