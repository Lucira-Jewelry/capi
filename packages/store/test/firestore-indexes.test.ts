import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The emulator answers every query without any index, so a missing index only shows up on real Firestore, as a
// failing queue. These tests keep deploy/firestore.indexes.json in step with the queries the code actually makes.

const root = new URL('../../..', import.meta.url).pathname;
const indexes = JSON.parse(readFileSync(join(root, 'deploy/firestore.indexes.json'), 'utf8')) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order: string }> }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean }>;
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'dist' || f === 'test') return [];
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
const code = sources(join(root, 'packages')).map((p) => ({ p, text: readFileSync(p, 'utf8') }));

const composite = (...fields: string[]) =>
  indexes.indexes.some((i) => i.collectionGroup === 'deliveries' && i.queryScope === 'COLLECTION_GROUP' && i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(',') === fields.map((f) => `${f}:ASCENDING`).join(','));

describe('deploy/firestore.indexes.json', () => {
  it('has an index for each query on the deliveries collection group (the sending queue)', () => {
    expect(composite('tenantId', 'status', 'createdAt')).toBe(true); // due: pending, oldest first
    expect(composite('tenantId', 'status', 'nextRetryAt')).toBe(true); // due: retry
    expect(composite('tenantId', 'status', 'leaseUntil')).toBe(true); // due: a worker died holding it
    expect(composite('tenantId', 'status', 'processingStatus', 'processingNextCheckAt')).toBe(true); // Google results to look up
    expect(indexes.indexes).toHaveLength(4); // and nothing unused, which would only cost writes
  });

  it('the code makes no other collection-group query: if it does, add its index above and list it here', () => {
    const groups = new Set(code.flatMap(({ text }) => [...text.matchAll(/collectionGroup\('([a-z_]+)'\)/g)].map((m) => m[1])));
    expect([...groups]).toEqual(['deliveries']);
  });

  it('the queue queries still filter and order on exactly the fields the indexes were written for', () => {
    const sales = code.find((c) => c.p.endsWith('store/src/sales.ts'))!.text;
    for (const needle of [
      ".where('status', '==', 'pending').orderBy('createdAt', 'asc')",
      ".where('status', '==', 'retry').where('nextRetryAt', '<=', now).orderBy('nextRetryAt', 'asc')",
      ".where('status', '==', 'sending').where('leaseUntil', '<=', now).orderBy('leaseUntil', 'asc')",
      ".where('processingNextCheckAt', '<=', now)",
      ".where('processingStatus', '==', 'processing')",
    ]) expect(sales).toContain(needle);
  });

  it('automatic deletion is set on every collection that gets an expiry time, and not on withdrawals', () => {
    const ttl = indexes.fieldOverrides.filter((o) => o.ttl).map((o) => `${o.collectionGroup}.${o.fieldPath}`).sort();
    expect(ttl).toEqual(['deliveries.expiresAt', 'identities.expiresAt', 'ingest_log.expiresAt', 'persons.expiresAt', 'sales.expiresAt', 'touches.expiresAt']);
    // a withdrawal must outlive the data it protects, so suppressions never expire
    const store = code.find((c) => c.p.endsWith('store/src/store.ts'))!.text;
    const suppressionWrites = [...store.matchAll(/this\.suppressions\.doc\([^)]*\)[\s\S]{0,200}/g)].map((m) => m[0]);
    expect(suppressionWrites.length).toBeGreaterThan(0);
    for (const w of suppressionWrites) expect(w).not.toContain('expiresAt');
  });
});

describe('deploy/firestore.rules', () => {
  it('refuses every direct read and write: only the collector, through its service account, may touch the data', () => {
    const rules = readFileSync(join(root, 'deploy/firestore.rules'), 'utf8');
    expect(rules).toContain('allow read, write: if false;');
    expect(rules).not.toMatch(/allow [a-z, ]+: if true/);
  });
});
