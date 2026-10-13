'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { NewBrandDialog } from '@/components/brands/NewBrandDialog';
import { SendingStrip } from '@/components/brands/SendingStrip';
import { Login } from '@/components/Login';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/useApi';
import { CHANNEL_LABEL, DEST_LABEL, type Meta, type SendOverview, type Tenant } from '@/lib/types';

export default function Home() {
  const { ready, signedIn } = useAuth();
  if (!ready) return <Skeleton className="mx-auto mt-16 h-48 max-w-sm" />;
  return signedIn ? <Brands /> : <Login />;
}

const PAGE = 50;
type StatusFilter = 'all' | 'active' | 'suspended';

function Brands() {
  const router = useRouter();
  const brands = useApi<{ tenants: Tenant[] }>('/tenants');
  const sending = useApi<SendOverview>('/sending');
  const meta = useApi<Meta>('/meta');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [creating, setCreating] = useState(false);
  // With many brands only the first page is drawn: a long list is slow to scroll. Search and filters always look at all of them.
  const [limit, setLimit] = useState(PAGE);

  const all = brands.data?.tenants ?? [];
  const count = (st: string) => all.filter((t) => t.status === st).length;
  // The status filter only appears once there is more than one status to tell apart.
  const mixed = new Set(all.map((t) => t.status)).size > 1;
  const query = q.trim().toLowerCase();
  const matching = all.filter((t) => (status === 'all' || t.status === status) && (!query || t.name.toLowerCase().includes(query) || t.tenantId.toLowerCase().includes(query)));
  const shown = matching.slice(0, limit);
  const filtered = Boolean(query) || status !== 'all';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Brands</h1>
          <p className="mt-1 text-sm text-muted" role="status">{brands.data ? (filtered ? `${matching.length} of ${all.length} brands` : `${all.length} ${all.length === 1 ? 'brand' : 'brands'}`) : ' '}</p>
        </div>
        <Button variant="primary" disabled={!meta.data} onClick={() => setCreating(true)}>New brand</Button>
      </div>

      {sending.data && <SendingStrip initial={sending.data} />}

      <div className="flex flex-wrap items-center gap-3">
        <input type="search" aria-label="Search brands" placeholder="Search brands" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm sm:w-64" />
        {mixed && (
          <div role="group" aria-label="Filter brands by status" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {([['all', 'All', all.length], ['active', 'Active', count('active')], ['suspended', 'Suspended', count('suspended')]] as const).map(([key, label, n]) => (
              <button key={key} type="button" aria-pressed={status === key} onClick={() => { setStatus(key); setLimit(PAGE); }} className={`rounded-md px-3 py-1 text-sm ${status === key ? 'bg-accent text-accent-contrast' : 'text-muted hover:text-text'}`}>
                {label} <span className="tabular-nums opacity-70">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {brands.error && <p role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">{brands.error}</p>}
      {brands.loading && !brands.data && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
      {brands.data && shown.length === 0 && (
        <Card className="p-8 text-center">
          <h2 className="font-semibold">{all.length === 0 ? 'No brands yet' : 'No brands match'}</h2>
          <p className="mt-1 text-sm text-muted">
            {all.length === 0 ? 'Add your first brand to get a website script, a CRM webhook and ad-account connections.' : query ? `Nothing matches “${q.trim()}”.` : 'No brands have this status.'}
          </p>
          {all.length > 0 && <Button className="mt-4" onClick={() => { setQ(''); setStatus('all'); }}>Clear filters</Button>}
        </Card>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {shown.map((t) => (
          <Link key={t.tenantId} href={`/brand/?id=${encodeURIComponent(t.tenantId)}`} className="group">
            <Card className="p-4 transition group-hover:border-accent">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{t.name}</div>
                  <div className="truncate font-mono text-xs text-muted">{t.tenantId}</div>
                </div>
                <Badge tone={t.status === 'active' ? 'ok' : 'warn'}>{t.status === 'active' ? 'Active' : 'Suspended'}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>Reports to {t.destinations.map((d) => DEST_LABEL[d] ?? d).join(', ') || 'nothing yet'}</span>
                <span>{t.allowedChannels.map((c) => CHANNEL_LABEL[c] ?? c).join(', ')}</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
      {matching.length > shown.length && (
        <div className="flex items-center justify-center gap-3">
          <span className="text-sm text-muted">Showing {shown.length} of {matching.length}</span>
          <Button onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, matching.length - shown.length)} more</Button>
        </div>
      )}

      {meta.error && !meta.data && (
        <p role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">
          Could not load the options for new brands: {meta.error}
          <Button onClick={() => void meta.reload()}>Try again</Button>
        </p>
      )}

      {/* Mounted only while open, so every opening starts from the safe defaults and nothing from the last one is left. */}
      {meta.data && creating && (
        <NewBrandDialog
          open={creating}
          meta={meta.data}
          onClose={(created) => { setCreating(false); if (created) void brands.reload(); }}
          onOpenBrand={(id) => { setCreating(false); void brands.reload(); router.push(`/brand/?id=${encodeURIComponent(id)}`); }}
        />
      )}
    </div>
  );
}
