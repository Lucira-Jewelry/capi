import type { Touch } from '@datahash/core';
import type { SaleRecord } from '@datahash/store';

/** Everything a sender needs to build one event. */
export interface SendContext {
  saleKey: string;
  sale: SaleRecord;
  /** The click credited for this sale, if any. */
  touch: Touch | null;
}

export type SendResult =
  /** `requestId` is the platform's ID for an accepted request whose processing result can be looked up later. */
  | { outcome: 'sent'; response: string; requestId?: string }
  /** Temporary problem (rate limit, outage, network): try again later. */
  | { outcome: 'retry'; error: string }
  /** The platform refused it. `authError` means the brand's token or access needs fixing first. */
  | { outcome: 'failed'; error: string; authError?: boolean };

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Fetch with a timeout. Network failures and timeouts are reported as retryable by the senders. */
export async function timedFetch(url: string, init: RequestInit, opts: HttpOptions = {}): Promise<Response> {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
