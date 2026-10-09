import {
  genericLogView,
  mapGenericSale,
  mapZohoDeal,
  zohoLogView,
  type AdapterResult,
  type IngestTenant,
  type ProcessResult,
} from '@datahash/ingest';
import type { IncomingSale } from '@datahash/ingest';

export interface WebhookDeps {
  /** The brand's settings, or null if unknown / suspended. */
  getTenant: (tenantId: string) => Promise<IngestTenant | null>;
  /** Check the shared secret the caller presented (only a hash is stored). */
  verifySecret: (tenantId: string, secret: string | undefined) => Promise<boolean>;
  process: (tenant: IngestTenant, sale: IncomingSale) => Promise<ProcessResult>;
  /** Called with a redacted copy of what arrived and what happened. Failures here must not break ingestion. */
  log?: (tenant: IngestTenant, source: string, payload: unknown, outcome: unknown) => Promise<void>;
}

export interface WebhookRequest {
  tenantId: string;
  source: string;
  secret?: string | undefined;
  body: string;
  contentType?: string | undefined;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/** JSON or form-encoded (Zoho workflows can send either). */
export function parseWebhookBody(raw: string, contentType = ''): unknown {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Accept a single record, an array, or a Zoho-style { data: [...] } wrapper. */
function recordsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data;
  }
  return [payload];
}

export async function handleWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<WebhookResponse> {
  if (req.source !== 'zoho' && req.source !== 'generic') return { status: 404, body: { error: 'not_found' } };
  const tenant = await deps.getTenant(req.tenantId);
  // Unknown brands and bad secrets look the same to the caller.
  if (!tenant || !(await deps.verifySecret(req.tenantId, req.secret))) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const zoho = tenant.sources.zoho;
  if (req.source === 'zoho' && !zoho) return { status: 404, body: { error: 'zoho_not_configured' } };

  const payload = parseWebhookBody(req.body, req.contentType);
  if (payload === null || typeof payload !== 'object') return { status: 400, body: { error: 'invalid_body' } };

  const results: Array<Record<string, unknown>> = [];
  for (const record of recordsOf(payload)) {
    const mapped: AdapterResult =
      req.source === 'zoho' ? mapZohoDeal(record, zoho!) : mapGenericSale(record);

    let outcome: Record<string, unknown>;
    if (!mapped.ok) {
      outcome = { status: 'rejected', reason: mapped.reason };
    } else {
      try {
        const r = await deps.process(tenant, mapped.sale);
        outcome = { status: r.duplicate ? 'duplicate' : 'recorded', saleKey: r.saleKey, deliveries: r.deliveries };
      } catch {
        outcome = { status: 'error' };
      }
    }
    results.push(outcome);

    try {
      // Log an allowlisted view of the record, never the record itself.
      await deps.log?.(tenant, req.source, req.source === 'zoho' ? zohoLogView(record, zoho!) : genericLogView(record), outcome);
    } catch {
      /* logging is best effort */
    }
  }

  // Per-record rejections (not won, bad amount...) are reported in the body with a 200 so Zoho does not retry them.
  // A real processing failure returns 500 so the sender retries; that is safe because sales are idempotent.
  const anyError = results.some((r) => r.status === 'error');
  return { status: anyError ? 500 : 200, body: { results } };
}
