import type { RunSummary, SendOverview } from './types';

/** A scheduler normally calls every minute or so. Longer than this without a run means it is not calling at all. */
export const SCHEDULER_STALE_MIN = 15;

export function ago(iso: string, now: Date = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export type SchedulerState = 'never' | 'ok' | 'stale';

/** Is something calling the scheduler endpoint? A manual "Send waiting sales now" does not count. */
export function schedulerState(last: SendOverview['lastRun'], now: Date = new Date()): SchedulerState {
  const run: RunSummary | undefined = last?.scheduler;
  if (!run) return 'never';
  return (now.getTime() - new Date(run.at).getTime()) / 60_000 > SCHEDULER_STALE_MIN ? 'stale' : 'ok';
}
