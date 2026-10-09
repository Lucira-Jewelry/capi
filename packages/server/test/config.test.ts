import { describe, expect, it } from 'vitest';
import { assertProductionConfig, productionProblems } from '../src';

const good = {
  NODE_ENV: 'production',
  GOOGLE_CLOUD_PROJECT: 'my-staging-project',
  SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  ADMIN_TOKEN: 'a'.repeat(40),
  INTERNAL_TOKEN: 'b'.repeat(40),
  PUBLIC_URL: 'https://collector.example.com',
  TRACKER_FILE: '/app/assets/tracker.js',
  ADMIN_UI_DIR: '/app/assets/admin',
};
const exists = (_path: string) => true;
const problems = (over: Record<string, string | undefined>, fileExists = exists) => productionProblems({ ...good, ...over }, fileExists);

describe('production settings', () => {
  it('a complete, safe set has no problems', () => {
    expect(problems({})).toEqual([]);
  });

  it('the internal token is optional', () => {
    expect(problems({ INTERNAL_TOKEN: undefined })).toEqual([]);
  });

  it('the emulator and a missing project are refused', () => {
    expect(problems({ FIRESTORE_EMULATOR_HOST: 'localhost:8080' })).toEqual([expect.stringContaining('emulator')]);
    expect(problems({ GOOGLE_CLOUD_PROJECT: undefined })).toEqual([expect.stringContaining('GOOGLE_CLOUD_PROJECT')]);
  });

  it('the encryption key must be real: present, 32 bytes, and not the one in the repository', () => {
    expect(problems({ SECRETS_KEY: undefined })[0]).toContain('SECRETS_KEY');
    expect(problems({ SECRETS_KEY: 'ZGV2LW9ubHktc2VjcmV0cy1rZXktMzItYnl0ZXMhISE=' })[0]).toContain('development key');
    expect(problems({ SECRETS_KEY: Buffer.alloc(16).toString('base64') })[0]).toContain('32 bytes');
  });

  it('tokens must be long and not placeholders, and the two must differ', () => {
    expect(problems({ ADMIN_TOKEN: 'dev-admin-token' })[0]).toContain('ADMIN_TOKEN');
    expect(problems({ ADMIN_TOKEN: 'short' })[0]).toContain('ADMIN_TOKEN');
    expect(problems({ ADMIN_TOKEN: undefined })[0]).toContain('ADMIN_TOKEN');
    expect(problems({ INTERNAL_TOKEN: 'short' })[0]).toContain('INTERNAL_TOKEN');
    expect(problems({ INTERNAL_TOKEN: good.ADMIN_TOKEN })[0]).toContain('differ');
  });

  it('the public address must be a real https address', () => {
    expect(problems({ PUBLIC_URL: undefined })[0]).toContain('PUBLIC_URL');
    expect(problems({ PUBLIC_URL: 'http://collector.example.com' })[0]).toContain('https');
    expect(problems({ PUBLIC_URL: 'https://localhost:8787' })[0]).toContain('localhost');
    expect(problems({ PUBLIC_URL: 'https://127.0.0.1' })[0]).toContain('localhost');
    expect(problems({ PUBLIC_URL: 'not a url' })[0]).toContain('valid');
  });

  it('the local-only timer is refused, because a scheduler does that job', () => {
    expect(problems({ DISPATCH_INTERVAL_SECONDS: '30' })[0]).toContain('scheduler');
    expect(problems({ DISPATCH_INTERVAL_SECONDS: '0' })).toEqual([]);
  });

  it('the built script and console must be present', () => {
    expect(problems({ TRACKER_FILE: undefined })[0]).toContain('TRACKER_FILE');
    expect(problems({}, (p) => p !== '/app/assets/admin')).toEqual([expect.stringContaining('ADMIN_UI_DIR')]);
  });

  it('a bad proxy count is refused', () => {
    expect(problems({ TRUSTED_PROXY_HOPS: 'many' })[0]).toContain('TRUSTED_PROXY_HOPS');
    expect(problems({ TRUSTED_PROXY_HOPS: '2' })).toEqual([]);
  });

  it('start-up lists everything wrong at once', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production' })).toThrow(/Refusing to start[\s\S]*GOOGLE_CLOUD_PROJECT[\s\S]*SECRETS_KEY[\s\S]*ADMIN_TOKEN[\s\S]*PUBLIC_URL/);
  });

  it('outside production nothing is checked, so the local stack keeps working', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: 'localhost:8080' })).not.toThrow();
    expect(() => assertProductionConfig({})).not.toThrow();
  });
});
