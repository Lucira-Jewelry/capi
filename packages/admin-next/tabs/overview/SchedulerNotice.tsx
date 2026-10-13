'use client';
import { Card } from '@/components/ui';
import { ago, schedulerState } from '@/lib/runs';
import type { SendOverview, Stats } from '@/lib/types';
import { useApi } from '@/lib/useApi';

/** Sales waiting while nothing is calling the scheduler would sit there forever with no explanation. */
export function SchedulerNotice({ stats }: { stats: Stats }) {
  const sending = useApi<SendOverview>('/sending');
  const o = sending.data;
  if (!o || !o.enabled || o.paused) return null; // those states are explained elsewhere
  const waiting = Object.values(stats.deliveries).reduce((n, by) => n + (by.pending ?? 0) + (by.retry ?? 0), 0);
  const state = schedulerState(o.lastRun);
  if (state === 'ok') {
    const r = o.lastRun!.scheduler!;
    return <p className="text-xs text-muted">Last scheduled run {ago(r.at)}: {r.considered === 0 ? 'nothing was waiting' : `${r.sent} sent, ${r.retried} to retry, ${r.failed} failed`}.</p>;
  }
  if (waiting === 0) return null;
  return (
    <Card className="border-transparent bg-warn-bg p-4 text-sm text-warn">
      <div role="status">
        <strong className="font-semibold">{waiting.toLocaleString()} {waiting === 1 ? 'delivery is' : 'deliveries are'} waiting to be sent, and nothing is sending them.</strong>{' '}
        <span>(A sale going to Meta and Google Ads counts once for each.)</span>{' '}
        {state === 'never'
          ? 'The scheduler has never run on this server.'
          : `The last scheduled run was ${ago(o.lastRun!.scheduler!.at)}.`}{' '}
        A Cloud Scheduler job must call POST /internal/dispatch every minute. Until then, use “Send waiting sales now” on the Sales tab.
      </div>
    </Card>
  );
}
