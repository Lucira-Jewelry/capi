/** The statuses the Sales tab can be opened on. These are the same groups the Sales tab offers. */
export type SaleStatusFilter = 'all' | 'attention' | 'waiting' | 'sent' | 'skipped';

const base = (id: string) => `/brand/?id=${encodeURIComponent(id)}`;

export const tabHref = (id: string, tab: string) => `${base(id)}&tab=${tab}`;

/** A link that opens the Sales tab showing exactly those sales: `dest` is meta or google_ads, `filter` one of the groups. */
export const salesHref = (id: string, filter: { status?: SaleStatusFilter; dest?: string }) =>
  `${tabHref(id, 'sales')}${filter.dest ? `&dest=${encodeURIComponent(filter.dest)}` : ''}${filter.status ? `&filter=${filter.status}` : ''}`;
