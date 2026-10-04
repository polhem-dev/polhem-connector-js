import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/crypto/aes-cbc-hmac.js';
import { concat, fromBase64, fromUtf8, toBase64, utf8 } from '../src/crypto/bytes.js';

/**
 * The vectors below were produced on .NET: the unbound one by the framework's `AesCbcHmacCryptor`,
 * the bound ones by Polhem.JsonRpc 1.1.0 (pinned there in
 * `PayloadWireVectorTests.AesCbcHmacDecrypt_BoundVector_OpensWithItsBindingOnly`).
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

const NO_AD = new Uint8Array(0);

const BOUND_PLAIN = 'Polhem ADR-003 binding vector';

/** Direction 0x01 (a request's parameters), then `Employee.GetList` in UTF-8. */
const REQUEST_AD_HEX = '01456D706C6F7965652E4765744C697374';
/** Direction 0x02 (a result), then the same method. */
const RESPONSE_AD_HEX = '02456D706C6F7965652E4765744C697374';

const BOUND_REQUEST_FROM_DOTNET_BASE64 =
  'EAAAAHYX5QeZX7jgLkq0NikmnpwgAAAAlY+Koj/+oH9tjwsGhMTJvpfpitn868rVNk1xXDCE6rttN7ChlpKWSuNVBWzvWb6tOEsV+p2NWiJMaEN5NLjfvw==';
const BOUND_RESPONSE_FROM_DOTNET_BASE64 =
  'EAAAAMMx+unW7jBIKA21I71abasgAAAA1wEXFaPoQxELAAFE/So1ZQRKNvzKJPspzQ9cb2SF8KIJvAM2Wt+jZpY0oUygUhM5JS6OpQbxsKD6IeqdHKA9Ew==';

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}

const requestAd = fromHex(REQUEST_AD_HEX);
const responseAd = fromHex(RESPONSE_AD_HEX);

describe('AES-CBC-HMAC', () => {
  it('decrypts an unbound payload produced by the .NET implementation, with empty associated data', async () => {
    const plain = await decrypt(fromBase64(CIPHER_FROM_DOTNET_BASE64), combinedKey, NO_AD);
    expect(fromUtf8(plain)).toBe(PLAIN);
  });

  it('spells the vector bindings as the direction byte followed by the method', () => {
    expect(requestAd).toEqual(concat(Uint8Array.of(1), utf8('Employee.GetList')));
    expect(responseAd).toEqual(concat(Uint8Array.of(2), utf8('Employee.GetList')));
  });

  it.each([
    ['request', BOUND_REQUEST_FROM_DOTNET_BASE64, requestAd],
    ['response', BOUND_RESPONSE_FROM_DOTNET_BASE64, responseAd],
  ] as const)('decrypts the bound .NET %s vector with its own binding', async (_name, vector, ad) => {
    const plain = await decrypt(fromBase64(vector), combinedKey, ad);
    expect(fromUtf8(plain)).toBe(BOUND_PLAIN);
  });

  it.each([
    ['request', 'the response binding', BOUND_REQUEST_FROM_DOTNET_BASE64, responseAd],
    ['request', 'empty associated data', BOUND_REQUEST_FROM_DOTNET_BASE64, NO_AD],
    ['response', 'the request binding', BOUND_RESPONSE_FROM_DOTNET_BASE64, requestAd],
    ['response', 'empty associated data', BOUND_RESPONSE_FROM_DOTNET_BASE64, NO_AD],
  ] as const)('refuses the bound .NET %s vector with %s', async (_name, _other, vector, ad) => {
    await expect(decrypt(fromBase64(vector), combinedKey, ad)).rejects.toThrow('HMAC validation failed.');
  });

  it('round-trips its own output', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey, requestAd);
    expect(fromUtf8(await decrypt(cipher, combinedKey, requestAd))).toBe(PLAIN);
  });

  it('refuses its own output under another method, another direction or no binding', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey, requestAd);
    for (const ad of [
      concat(Uint8Array.of(1), utf8('Employee.Delete')),
      responseAd,
      NO_AD,
      // A binding is not a prefix match: the method runs to the end of the HMAC input.
      concat(requestAd, utf8('x')),
      requestAd.subarray(0, requestAd.length - 1),
    ]) {
      await expect(decrypt(cipher, combinedKey, ad)).rejects.toThrow('HMAC validation failed.');
    }
  });

  it('produces a different IV each time, so identical plaintext never repeats on the wire', async () => {
    const a = await encrypt(utf8(PLAIN), combinedKey, requestAd);
    const b = await encrypt(utf8(PLAIN), combinedKey, requestAd);
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it('rejects a tampered ciphertext rather than returning wrong plaintext', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey, requestAd);
    const body = cipher.length - 40;
    cipher[body] = (cipher[body] ?? 0) ^ 0xff; // flip a bit inside the ciphertext body
    await expect(decrypt(cipher, combinedKey, requestAd)).rejects.toThrow(/HMAC/);
  });

  it('rejects a tampered length prefix, which the tag also covers', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey, requestAd);
    cipher[0] = (cipher[0] ?? 0) ^ 0x01; // rewrite the IV length
    await expect(decrypt(cipher, combinedKey, requestAd)).rejects.toThrow();
  });

  it('refuses a missing binding from a caller the type checker did not see', async () => {
    const cipher = await encrypt(utf8(PLAIN), combinedKey, requestAd);
    const untyped = undefined as unknown as Uint8Array<ArrayBuffer>;
    await expect(encrypt(utf8(PLAIN), combinedKey, untyped)).rejects.toThrow(/Associated data is required/);
    await expect(decrypt(cipher, combinedKey, untyped)).rejects.toThrow(/Associated data is required/);
  });

  it('rejects a combined key of the wrong size', async () => {
    await expect(encrypt(utf8('x'), new Uint8Array(32), requestAd)).rejects.toThrow(/64 bytes/);
  });
});
