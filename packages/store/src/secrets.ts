import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets (ad-platform tokens) before they are written to the database.
 * AES-256-GCM with a master key from the environment (SECRETS_KEY, 32 bytes, base64).
 *
 * This keeps tokens out of plain Firestore documents. For production at scale, swap the master key for
 * Cloud KMS / Secret Manager (envelope encryption) behind the same `seal` / `open` interface.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    this.key = Buffer.from(masterKeyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('secrets_key_must_be_32_bytes_base64');
  }

  static generateKey(): string {
    return randomBytes(32).toString('base64');
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('secret_format_invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}
