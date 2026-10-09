import { describe, expect, it } from 'vitest';
import { parseTrackingHost } from '../src';

describe('parseTrackingHost', () => {
  it.each([
    ['track.brand.com', 'track.brand.com'],
    ['  Track.Brand.COM ', 'track.brand.com'],
    ['t.shop.brand.co.in', 't.shop.brand.co.in'],
    ['track-1.brand.com', 'track-1.brand.com'],
    ['track.brand.localhost:8787', 'track.brand.localhost:8787'],
    ['track.brand.localhost', 'track.brand.localhost'],
  ])('accepts %s', (raw, expected) => {
    expect(parseTrackingHost(raw)).toEqual({ ok: true, host: expected });
  });

  it.each([
    ['https://track.brand.com'],
    ['track.brand.com/path'],
    ['track.brand.com:8080'], // a port is only for local testing
    ['brand'], // needs at least two labels
    ['192.168.1.10'],
    ['-bad.brand.com'],
    ['bad_.brand.com'],
    ['track..brand.com'],
    [''],
    ['track brand.com'],
    [`${'a'.repeat(64)}.brand.com`],
  ])('rejects %s', (raw) => {
    expect(parseTrackingHost(raw)).toMatchObject({ ok: false });
  });
});
