export interface ZohoClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** India data centre by default (zoho.in). VERIFY the hosts for other data centres. */
  accountsHost?: string;
  apiHost?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WonDealsQuery {
  fields: string[];
  stageField: string;
  wonStages: string[];
  since: Date;
}

const PAGE = 200;

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Minimal Zoho CRM client for the daily backup sync.
 * The COQL query shape, field names and limits are written from memory: VERIFY against Zoho's current API docs
 * before relying on them.
 */
export class ZohoClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly accountsHost: string;
  private readonly apiHost: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: ZohoClientConfig) {
    this.accountsHost = cfg.accountsHost ?? 'https://accounts.zoho.in';
    this.apiHost = cfg.apiHost ?? 'https://www.zohoapis.in';
    this.doFetch = cfg.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = cfg.now ?? (() => Date.now());
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    const params = new URLSearchParams({
      refresh_token: this.cfg.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: 'refresh_token',
    });
    const res = await this.doFetch(`${this.accountsHost}/oauth/v2/token?${params}`, { method: 'POST' });
    if (!res.ok) throw new Error(`zoho_token_http_${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!json.access_token) throw new Error(`zoho_token_${json.error ?? 'missing'}`);
    this.token = { value: json.access_token, expiresAt: this.now() + ((json.expires_in ?? 3600) - 60) * 1000 };
    return json.access_token;
  }

  /** Deals in a won stage that changed since `since`, page by page. */
  async *fetchWonDeals(query: WonDealsQuery): AsyncGenerator<Record<string, unknown>> {
    const stages = query.wonStages.map(q).join(', ');
    const since = query.since.toISOString().replace('Z', '+00:00');
    for (let offset = 0; ; offset += PAGE) {
      const select =
        `select ${query.fields.join(', ')} from Deals ` +
        `where (${query.stageField} in (${stages}) and Modified_Time >= ${q(since)}) ` +
        `limit ${offset}, ${PAGE}`;
      const res = await this.doFetch(`${this.apiHost}/crm/v6/coql`, {
        method: 'POST',
        headers: {
          authorization: `Zoho-oauthtoken ${await this.accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ select_query: select }),
      });
      if (res.status === 204) return; // no records
      if (!res.ok) throw new Error(`zoho_coql_http_${res.status}`);
      const json = (await res.json()) as { data?: Record<string, unknown>[]; info?: { more_records?: boolean } };
      for (const record of json.data ?? []) yield record;
      if (!json.info?.more_records) return;
    }
  }
}
