import { mapZohoDeal, zohoFieldsFromMapping } from './adapters/zoho';
import { processSale, type PipelineDeps } from './pipeline';
import type { ZohoClient } from './zoho-client';
import type { IngestTenant } from './types';

export interface SyncSummary {
  fetched: number;
  newSales: number;
  duplicates: number;
  rejected: Record<string, number>;
  errors: number;
}

/**
 * Backup for missed webhooks: pull recently changed won deals from Zoho and run them through the same
 * pipeline. Sales already received by webhook are recognised by deal ID and left alone.
 */
export async function syncZohoWonDeals(args: {
  client: Pick<ZohoClient, 'fetchWonDeals'>;
  tenant: IngestTenant;
  since: Date;
  deps: PipelineDeps;
}): Promise<SyncSummary> {
  const { client, tenant, since, deps } = args;
  const mapping = tenant.sources.zoho;
  if (!mapping) throw new Error('tenant_has_no_zoho_mapping');

  const summary: SyncSummary = { fetched: 0, newSales: 0, duplicates: 0, rejected: {}, errors: 0 };
  const query = {
    fields: zohoFieldsFromMapping(mapping),
    stageField: mapping.stage ?? 'Stage',
    wonStages: mapping.wonStages ?? [],
    since,
  };

  for await (const record of client.fetchWonDeals(query)) {
    summary.fetched++;
    try {
      const mapped = mapZohoDeal(record, mapping);
      if (!mapped.ok) {
        summary.rejected[mapped.reason] = (summary.rejected[mapped.reason] ?? 0) + 1;
        continue;
      }
      const result = await processSale(mapped.sale, tenant, deps);
      if (result.duplicate) summary.duplicates++;
      else summary.newSales++;
    } catch {
      summary.errors++;
    }
  }
  return summary;
}
