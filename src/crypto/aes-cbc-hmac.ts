import { concat, int32LE, readInt32LE, type Bytes } from './bytes.js';

/**
 * AES-256-CBC encryption with an HMAC-SHA256 authentication tag, wire-compatible with the
 * framework's `AesCbcHmacCryptor`.
 *
 * The layout is written by .NET's `BinaryWriter`, so the two length prefixes are
 * **little-endian** 32-bit signed integers:
 *
 * ```
 * [int32 ivLength][iv][int32 cipherLength][ciphertext][hmac (32 bytes)]
 * ```
 *
 * The HMAC covers everything before it — both length prefixes included — so a rewritten length
 * fails verification rather than shifting the parse.
 */

const IV_LENGTH = 16;
const HMAC_LENGTH = 32;
const KEY_LENGTH = 32;

/** Minimum: 4 + 16 (iv) + 4 + 16 (one cipher block) + 32 (hmac). */
const MIN_LENGTH = 72;

/**
 * Splits the 64-byte combined key into its AES and HMAC halves.
 *
 * The framework derives both from one key: the first 32 bytes encrypt, the last 32 authenticate.
 */
function splitKey(combinedKey: Bytes): { aesKey: Bytes; hmacKey: Bytes } {
  if (combinedKey.length !== KEY_LENGTH * 2) {
    throw new Error(`Combined key must be ${KEY_LENGTH * 2} bytes, got ${combinedKey.length}.`);
  }
  return {
    aesKey: combinedKey.subarray(0, KEY_LENGTH),
    hmacKey: combinedKey.subarray(KEY_LENGTH),
  };
}

async function importAesKey(raw: Bytes, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, [usage]);
}

async function importHmacKey(raw: Bytes, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/**
 * Encrypts a payload and appends its authentication tag.
 *
 * @param plain The bytes to encrypt.
 * @param combinedKey The 64-byte session key exchanged at login.
 */
export async function encrypt(plain: Bytes, combinedKey: Bytes): Promise<Bytes> {
  const { aesKey, hmacKey } = splitKey(combinedKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const key = await importAesKey(aesKey, 'encrypt');
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain));

  const authenticated = concat(int32LE(iv.length), iv, int32LE(cipher.length), cipher);

  const mac = await importHmacKey(hmacKey, ['sign']);
  const tag = new Uint8Array(await crypto.subtle.sign('HMAC', mac, authenticated));

  return concat(authenticated, tag);
}

/**
 * Verifies the authentication tag and decrypts.
 *
 * @param payload The encrypted bytes as produced by {@link encrypt} or by the server.
 * @param combinedKey The 64-byte session key exchanged at login.
 * @throws When the payload is malformed or its tag does not verify.
 */
export async function decrypt(payload: Bytes, combinedKey: Bytes): Promise<Bytes> {
  if (payload.length < MIN_LENGTH) {
    throw new Error('Invalid encrypted data.');
  }
  const { aesKey, hmacKey } = splitKey(combinedKey);

  const ivLength = readInt32LE(payload, 0);
  if (ivLength < 16 || ivLength > 32) {
    throw new Error('Invalid IV length.');
  }
  const iv = payload.subarray(4, 4 + ivLength);

  const cipherLength = readInt32LE(payload, 4 + ivLength);
  if (cipherLength <= 0 || cipherLength > payload.length - ivLength - 40) {
    throw new Error('Invalid cipher data length.');
  }

  const cipherStart = 8 + ivLength;
  const cipher = payload.subarray(cipherStart, cipherStart + cipherLength);
  const tag = payload.subarray(cipherStart + cipherLength, cipherStart + cipherLength + HMAC_LENGTH);
  const authenticated = payload.subarray(0, cipherStart + cipherLength);

  // `verify` compares in constant time, which is the property the framework's own
  // `FixedTimeEquals` provides on the other end.
  const mac = await importHmacKey(hmacKey, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', mac, tag, authenticated))) {
    throw new Error('HMAC validation failed.');
  }

  const key = await importAesKey(aesKey, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipher));
}
