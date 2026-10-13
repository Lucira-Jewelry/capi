'use client';
import { useState, type ReactNode } from 'react';
import { Card, Select, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/useApi';
import type { Stats } from '@/lib/types';
import { SchedulerNotice } from './overview/SchedulerNotice';
import { AttentionCard } from './overview/AttentionCard';
import { PlatformCard, SkipTable } from './overview/PlatformCards';
import { SetupGuide, setupSteps } from './overview/SetupGuide';
import type { TabProps } from './types';

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '–');

function Stat({ label, value, hint, big }: { label: string; value: ReactNode; hint?: string; big?: boolean }) {
  return (
    <Card className="p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1.5 font-semibold tabular-nums ${big ? 'text-4xl' : 'text-2xl'}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}

export function Overview({ id, view }: TabProps) {
  const enc = encodeURIComponent(id);
  const [days, setDays] = useState(30);
  // The first 30 days decide what a new brand sees; picking another period loads on top of it.
  const first = useApi<Stats>(`/tenants/${enc}/stats?days=30`);
  const other = useApi<Stats>(days === 30 ? null : `/tenants/${enc}/stats?days=${days}`);

  if (first.error) return <p role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">{first.error}</p>;
  if (!first.data) return <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>;

  const steps = setupSteps(id, view, first.data.sales);
  const guideOpen = steps.some((s) => !s.done);
  // Keep the old numbers on screen (dimmed) while another period loads, instead of blanking the page.
  const s = days === 30 || !other.data ? first.data : other.data;
  const shownDays = days === 30 || !other.data ? 30 : days;
  const refreshing = days !== 30 && other.loading;

  return (
    <div className="space-y-6">
      <AttentionCard id={id} view={view} stats={first.data} />
      <SchedulerNotice stats={first.data} />
      {guideOpen && <SetupGuide steps={steps} />}
      {/* A new brand sees only what to do next; the numbers appear once there is something to count. */}
      {(!guideOpen || first.data.sales > 0) && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Activity</h2>
            <div className="w-44">
              <Select aria-label="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </Select>
            </div>
          </div>
          {other.error && <p role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-sm text-bad">{other.error}</p>}
          <div aria-busy={refreshing} className={`space-y-4 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
            <div className="grid gap-4 lg:grid-cols-2">
              <Stat big label="Sales received" value={s.sales.toLocaleString()} hint={`in the last ${shownDays} days`} />
              <Card className="p-5">
                <div className="text-xs font-medium uppercase tracking-wide text-muted">How sales were matched</div>
                <div className="mt-3 grid grid-cols-3 gap-4">
                  <Metric value={pct(s.matchedToPerson, s.sales)} label="Linked to a website visit" />
                  <Metric value={s.withClickId.toLocaleString()} label="Sent or queued with a click ID" />
                  <Metric value={s.contactOnly.toLocaleString()} label="Sent or queued on phone and email only" />
                </div>
              </Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {view.tenant.destinations.map((d) => <PlatformCard key={d} id={id} dest={d} stats={s} />)}
            </div>
            <SkipTable stats={s} />
          </div>
        </>
      )}
    </div>
  );
}
