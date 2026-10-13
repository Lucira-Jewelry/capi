import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createFirestore, DispatchLog, SendControl, TenantRegistry } from '../src';

// Needs the Firestore emulator:  npm run test:emulator
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = emulator ? createFirestore() : (null as never);
afterAll(async () => {
  if (emulator) await db.terminate();
});

describe.skipIf(!emulator)('send pause (Firestore emulator)', () => {
  it('is not paused until an operator pauses it, then carries the reason, then resumes', async () => {
    const c = new SendControl(db, { cacheMs: 0 });
    await c.set(false);
    expect(await c.get()).toEqual({ paused: false });
    const at = new Date('2026-10-09T10:00:00Z');
    expect(await c.set(true, 'mapping check', at)).toEqual({ paused: true, reason: 'mapping check', at });
    expect((await c.set(false)).paused).toBe(false);
  });

  it('another instance sees a pause within the cache time, and not before', async () => {
    let t = 1_000_000;
    const writer = new SendControl(db, { cacheMs: 0 });
    const reader = new SendControl(db, { cacheMs: 3000, now: () => t });
    await writer.set(false);
    expect((await reader.get()).paused).toBe(false);
    await writer.set(true, 'stop');
    expect((await reader.get()).paused).toBe(false); // still the cached answer
    t += 3001;
    expect(await reader.get()).toMatchObject({ paused: true, reason: 'stop' });
    await writer.set(false);
  });

  it('a fresh read sees another instance\'s pause at once, however long the cache is, and refreshes the cache', async () => {
    const writer = new SendControl(db, { cacheMs: 0 });
    const reader = new SendControl(db, { cacheMs: 60_000 });
    await writer.set(false);
    expect((await reader.get()).paused).toBe(false); // cached for a minute
    await writer.set(true, 'stop now');
    expect((await reader.get()).paused).toBe(false); // the cache is behind
    expect(await reader.get({ fresh: true })).toMatchObject({ paused: true, reason: 'stop now' });
    expect((await reader.get()).paused).toBe(true); // and now the cache has caught up
    await writer.set(false);
  });

  it('setting it makes the same instance see it immediately', async () => {
    const c = new SendControl(db, { cacheMs: 60_000 });
    await c.set(false);
    await c.get();
    expect((await c.set(true)).paused).toBe(true);
    await c.set(false);
  });
});

describe.skipIf(!emulator)('fresh tenant reads (Firestore emulator)', () => {
  it('a suspension is seen at once with fresh, while the normal read may lag behind the cache', async () => {
    const registry = new TenantRegistry(db, { cacheMs: 60_000 });
    const { tenant } = await registry.createTenant({ name: `Fresh ${randomUUID().slice(0, 4)}` });
    expect((await registry.getTenant(tenant.tenantId))?.status).toBe('active'); // now cached
    // another instance suspends the brand (written straight to the database, so this instance's cache does not know)
    await db.collection('tenants').doc(tenant.tenantId).update({ status: 'suspended' });
    expect((await registry.getTenant(tenant.tenantId))?.status).toBe('active'); // the cache, up to a minute behind
    expect((await registry.getTenant(tenant.tenantId, { fresh: true }))?.status).toBe('suspended');
    expect((await registry.getTenant(tenant.tenantId))?.status).toBe('suspended'); // and the cache was refreshed
  });
});

describe.skipIf(!emulator)('last sending run (Firestore emulator)', () => {
  it('keeps the scheduler run apart from a manual one, so a button press cannot hide a broken scheduler', async () => {
    const log = new DispatchLog(db);
    await db.collection('system').doc('dispatch').delete();
    expect(await log.get()).toEqual({});

    const t1 = new Date('2026-10-13T10:00:00Z');
    const t2 = new Date('2026-10-13T11:30:00Z');
    await log.record({ at: t1, source: 'scheduler', considered: 3, sent: 2, retried: 1, failed: 0 });
    await log.record({ at: t2, source: 'console', considered: 1, sent: 1, retried: 0, failed: 0 });

    expect(await log.get()).toEqual({
      scheduler: { at: t1, source: 'scheduler', considered: 3, sent: 2, retried: 1, failed: 0 },
      console: { at: t2, source: 'console', considered: 1, sent: 1, retried: 0, failed: 0 },
    });
  });
});
