import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src';

describe('SecretBox', () => {
  const box = new SecretBox(SecretBox.generateKey());

  it('round-trips a secret and never stores it in the clear', () => {
    const sealed = box.seal('EAAG-meta-token-123');
    expect(sealed).not.toContain('EAAG');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(box.open(sealed)).toBe('EAAG-meta-token-123');
  });

  it('uses a fresh IV each time', () => {
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('rejects tampering and the wrong key', () => {
    const sealed = box.seal('secret');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
    expect(() => box.open(tampered)).toThrow();
    expect(() => new SecretBox(SecretBox.generateKey()).open(sealed)).toThrow();
    expect(() => box.open('garbage')).toThrow('secret_format_invalid');
  });

  it('requires a 32-byte key', () => {
    expect(() => new SecretBox(Buffer.from('short').toString('base64'))).toThrow('secrets_key_must_be_32_bytes_base64');
  });
});
