/**
 * One object per brand AND retention period, created on first use. A brand's retention can be changed in the console;
 * keying by it means the next request after the (short) tenant cache expires uses the new value, instead of whatever
 * the first request after a restart happened to see.
 */
export class KeyedCache<T> {
  private readonly items = new Map<string, T>();

  constructor(private readonly make: (tenantId: string, retentionDays?: number) => T) {}

  get(tenantId: string, retentionDays?: number): T {
    const key = `${tenantId}|${retentionDays ?? 'default'}`;
    let item = this.items.get(key);
    if (!item) {
      item = this.make(tenantId, retentionDays);
      this.items.set(key, item);
    }
    return item;
  }
}
