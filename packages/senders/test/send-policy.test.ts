import { describe, expect, it } from 'vitest';
import { describeSendPolicy, parseSendPolicy, sendBlockReason } from '../src';

describe('parseSendPolicy', () => {
  it('is off unless explicitly switched on', () => {
    expect(parseSendPolicy({})).toEqual({ enabled: false });
    expect(parseSendPolicy({ OUTBOUND_SENDS: '' })).toEqual({ enabled: false });
    expect(parseSendPolicy({ OUTBOUND_SENDS: 'off' })).toEqual({ enabled: false });
    expect(parseSendPolicy({ OUTBOUND_SENDS: ' ON ' })).toEqual({ enabled: true });
  });

  it('refuses a value it does not understand rather than guessing', () => {
    for (const v of ['true', '1', 'yes', 'enabled']) expect(() => parseSendPolicy({ OUTBOUND_SENDS: v })).toThrow(/"on" or "off"/);
  });

  it('reads the brand and platform lists, and rejects a platform that does not exist', () => {
    expect(parseSendPolicy({ OUTBOUND_SENDS: 'on', SEND_ALLOWED_TENANTS: ' a , b ,', SEND_ALLOWED_DESTINATIONS: 'meta' })).toEqual({ enabled: true, tenants: ['a', 'b'], destinations: ['meta'] });
    expect(() => parseSendPolicy({ OUTBOUND_SENDS: 'on', SEND_ALLOWED_DESTINATIONS: 'meta,tiktok' })).toThrow(/tiktok/);
  });
});

describe('sendBlockReason', () => {
  it('blocks everything when off, whatever the lists say', () => {
    const policy = { enabled: false, tenants: ['a'], destinations: ['meta'] };
    expect(sendBlockReason(policy, 'a')).toContain('switched off');
    expect(sendBlockReason(policy, 'a', 'meta')).toContain('switched off');
  });

  it('allows everything when on with no lists', () => {
    expect(sendBlockReason({ enabled: true }, 'any', 'google_ads')).toBeNull();
  });

  it('only listed brands may send', () => {
    const policy = { enabled: true, tenants: ['staging'] };
    expect(sendBlockReason(policy, 'staging', 'meta')).toBeNull();
    expect(sendBlockReason(policy, 'other')).toContain('not on the list');
    expect(sendBlockReason(policy, 'other', 'meta')).toContain('not on the list');
  });

  it('only listed platforms are sent to, and the brand-wide question is not affected by the platform list', () => {
    const policy = { enabled: true, destinations: ['meta'] };
    expect(sendBlockReason(policy, 'a')).toBeNull();
    expect(sendBlockReason(policy, 'a', 'meta')).toBeNull();
    expect(sendBlockReason(policy, 'a', 'google_ads')).toContain('google_ads');
  });

  it('describes the policy for the admin screens', () => {
    expect(describeSendPolicy({ enabled: false }, 'a')).toMatchObject({ allowed: false, reason: expect.stringContaining('switched off') });
    expect(describeSendPolicy({ enabled: true, tenants: ['b'] }, 'a')).toMatchObject({ allowed: false });
    expect(describeSendPolicy({ enabled: true, destinations: ['meta'] }, 'a')).toEqual({ allowed: true, destinations: ['meta'] });
    expect(describeSendPolicy({ enabled: true }, 'a')).toEqual({ allowed: true });
  });
});
