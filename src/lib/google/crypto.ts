// AES-256-GCM encryption for Google refresh tokens.
//
// The key comes from the GOOGLE_TOKEN_KEY env var, base64-encoded
// 32 bytes. Missing / wrong-length key = every operation fails with
// a clear error so the admin UI can surface "not configured" honestly.
//
// Ciphertext format (all base64):
//   iv$ciphertext$authTag
// Single-string so we store one column in google_connections.

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard

function readKey(): Buffer {
  const raw = process.env.GOOGLE_TOKEN_KEY;
  if (!raw) {
    throw new Error(
      'GOOGLE_TOKEN_KEY env var is not set. Generate 32 random bytes and base64-encode them.'
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('GOOGLE_TOKEN_KEY is not valid base64.');
  }
  if (buf.length !== 32) {
    throw new Error(
      `GOOGLE_TOKEN_KEY must decode to exactly 32 bytes (got ${buf.length}).`
    );
  }
  return buf;
}

export function isGoogleCryptoConfigured(): boolean {
  try {
    readKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const key = readKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    ciphertext.toString('base64'),
    authTag.toString('base64'),
  ].join('$');
}

export function decryptSecret(envelope: string): string {
  const key = readKey();
  const parts = envelope.split('$');
  if (parts.length !== 3) {
    throw new Error('malformed encrypted envelope');
  }
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_LENGTH) throw new Error('bad IV length');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
