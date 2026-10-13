import type { Meta, TenantView } from '@/lib/types';

/** What every tab of a brand receives. `reload` refetches the brand after a change. */
export interface TabProps {
  id: string;
  view: TenantView;
  meta: Meta;
  reload: () => Promise<void>;
}
