import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../src';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SerialQueue', () => {
  it('never runs two jobs at once, and keeps their order', async () => {
    const q = new SerialQueue();
    let running = 0;
    let peak = 0;
    const log: string[] = [];
    const job = (name: string, ms: number) => () =>
      (async () => {
        running++;
        peak = Math.max(peak, running);
        log.push(`start ${name}`);
        await wait(ms);
        log.push(`end ${name}`);
        running--;
        return name;
      })();
    const results = await Promise.all([q.run(job('a', 30)), q.run(job('b', 5)), q.run(job('c', 10))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('a job that fails reports its own error and does not block the ones after it', async () => {
    const q = new SerialQueue();
    const failing = q.run(async () => {
      throw new Error('boom');
    });
    const after = q.run(async () => 'still runs');
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('still runs');
  });

  it('a job started while the queue is idle starts at once', async () => {
    const q = new SerialQueue();
    expect(await q.run(async () => 1)).toBe(1);
    expect(await q.run(async () => 2)).toBe(2);
  });
});
