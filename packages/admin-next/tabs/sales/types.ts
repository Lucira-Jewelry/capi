export interface ImportSummary {
  rows: number;
  newSales: number;
  alreadyImported: number;
  withContact: number;
  withoutContact: number;
  consent: { yes: number; no: number; notStated: number };
  withName: number;
  withPostalCode: number;
  value: Record<string, number>;
  firstDate: string | null;
  lastDate: string | null;
}

export interface ImportCheck {
  dryRun: boolean;
  counts: Record<string, number>;
  results: Array<{ line: number; status: string; error?: string }>;
  summary?: ImportSummary;
  checkToken?: string;
}

export interface DispatchResult {
  considered: number;
  sent: number;
  retried: number;
  failed: number;
  notConnected: number;
  withdrawn?: number;
  suspended?: boolean;
  blocked?: number;
  blockedReason?: string;
}

export interface PreviewResult {
  url?: string;
  body?: unknown;
  notes?: string[];
  error?: string;
}
