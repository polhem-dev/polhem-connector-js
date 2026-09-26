import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/crypto/aes-cbc-hmac.js';
import { fromBase64, fromUtf8, toBase64, utf8 } from '../src/crypto/bytes.js';

/**
 * The vectors below were produced by the framework's own `AesCbcHmacCryptor` on .NET.
 *
 * A round-trip inside this package proves only that it agrees with itself; a payload the server
 * actually produced is the only thing that proves the two ends agree on the wire layout — the
 * little-endian length prefixes and which half of the combined key does what.
 */
const COMBINED_KEY_BASE64 =
  'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw==';

const PLAIN = 'Polhem wire compatibility vector — 跨語言驗證';

const CIPHER_FROM_DOTNET_BASE64 =
  'EAAAANPZb1cW8cHgW5r3qzhfZSpAAAAA8qoBGOTLFerJyNOyitGWwI002nHkDnS0O5my5IvDDvD9GVE1cEe40E45+tPOqoFfD5tGj/zHrzJZ3GjzUgZODoP9pnhV3gt2u/6g5Hn3lS50AyMFVFtQohECDh3uhP9y';

const combinedKey = fromBase64(COMBINED_KEY_BASE64);

describe('AES-CBC-HMAC', () => {
  it('decrypts a payload produced by the .NET implementation', async () => {
    const plain = await decrypt(fromBase64(CIPHER_FROM_DOTNET_BASE64), combinedKey);
    expect(fromUtf8(plain)).toBe(PLAIN);
  });

  it('round-trips its own output', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey);
    expect(fromUtf8(await decrypt(cipher, combinedKey))).toBe(PLAIN);
  });

  it('produces a different IV each time, so identical plaintext never repeats on the wire', async () => {
    const a = await encrypt(utf8(PLAIN), combinedKey);
    const b = await encrypt(utf8(PLAIN), combinedKey);
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it('rejects a tampered ciphertext rather than returning wrong plaintext', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey);
    const body = cipher.length - 40;
    cipher[body] = (cipher[body] ?? 0) ^ 0xff; // flip a bit inside the ciphertext body
    await expect(decrypt(cipher, combinedKey)).rejects.toThrow(/HMAC/);
  });

  it('rejects a tampered length prefix, which the tag also covers', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey);
    cipher[0] = (cipher[0] ?? 0) ^ 0x01; // rewrite the IV length
    await expect(decrypt(cipher, combinedKey)).rejects.toThrow();
  });

  it('rejects a combined key of the wrong size', async () => {
    await expect(encrypt(utf8('x'), new Uint8Array(32))).rejects.toThrow(/64 bytes/);
  });
});
