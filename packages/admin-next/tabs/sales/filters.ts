import type { SaleSummary } from '@/lib/types';

export type SaleStatusFilter = 'all' | 'attention' | 'waiting' | 'sent' | 'skipped';
export type DeliveryOf = SaleSummary['deliveries'][number];

export const STATUS_FILTERS: Array<[SaleStatusFilter, string]> = [
  ['all', 'All'],
  ['attention', 'Needs attention'],
  ['waiting', 'Waiting'],
  ['sent', 'Sent'],
  ['skipped', 'Skipped'],
];

const KNOWN = new Set<string>(STATUS_FILTERS.map(([k]) => k));

/**
 * The Overview opens Sales on exactly the sales behind a count, with the address
 *   /brand/?id=<brand>&tab=sales&filter=<all|attention|waiting|sent|skipped>&dest=<meta|google_ads>
 * Both are optional; an unknown value is ignored. They only set the starting point: the filters can be changed freely.
 */
export function presetFromParams(params: { get(name: string): string | null } | null): { status: SaleStatusFilter; dest: string } {
  const f = params?.get('filter') ?? '';
  const d = params?.get('dest') ?? '';
  return { status: KNOWN.has(f) ? (f as SaleStatusFilter) : 'all', dest: d === 'meta' || d === 'google_ads' ? d : '' };
}

/** Does one delivery fall under this heading? "Needs attention" is a failure, a platform rejection, or a retry that is not just waiting for a connection. */
export function deliveryMatches(d: DeliveryOf, status: SaleStatusFilter): boolean {
  switch (status) {
    case 'all':
      return true;
    case 'attention':
      return d.status === 'failed' || d.processingStatus === 'partial' || d.processingStatus === 'rejected' || (d.status === 'retry' && Boolean(d.lastError) && !d.lastError!.startsWith('not_connected'));
    case 'waiting':
      return d.status === 'pending' || d.status === 'sending' || d.status === 'retry';
    case 'sent':
      return d.status === 'sent';
    case 'skipped':
      return d.status === 'skipped';
  }
}

export function saleMatches(s: SaleSummary, status: SaleStatusFilter, dest: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q && !`${s.sale.eventId} ${s.sale.storeName ?? ''}`.toLowerCase().includes(q)) return false;
  const ds = dest ? s.deliveries.filter((d) => d.destination === dest) : s.deliveries;
  return status === 'all' ? ds.length > 0 || !dest : ds.some((d) => deliveryMatches(d, status));
}
