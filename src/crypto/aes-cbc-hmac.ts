import { concat, int32LE, readInt32LE, type Bytes } from './bytes.js';

/**
 * AES-256-CBC encryption with an HMAC-SHA256 authentication tag over associated data, matching the
 * payload encryption of Polhem.JsonRpc 1.1.0 (ADR-003 in polhem-dev/polhem-jsonrpc).
 *
 * The layout is written by .NET's `BinaryWriter`, so the two length prefixes are
 * **little-endian** 32-bit signed integers:
 *
 * ```
 * [int32 ivLength][iv][int32 cipherLength][ciphertext][hmac (32 bytes)]
 * ```
 *
 * The HMAC covers everything before it — both length prefixes included — so a rewritten length
 * fails verification rather than shifting the parse. It then covers the associated data, which is
 * not written to the payload: both ends supply it from the call. The JSON-RPC transport passes the
 * direction and the method (see `buildPayload`), so a payload opens only as the call it was written
 * for. With empty associated data the tag is the one the framework's `AesCbcHmacCryptor` computes
 * for its settings, which stay unbound; `buildPayload` never produces that form.
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

/** Refuses a missing binding from a caller the type checker did not see, such as plain JavaScript. */
function assertAssociatedData(associatedData: Bytes): void {
  if (!(associatedData instanceof Uint8Array)) {
    throw new Error('Associated data is required.');
  }
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
 * @param associatedData Authenticated after the ciphertext but not written to the payload; the
 *   reader must supply the same bytes to {@link decrypt}.
 */
export async function encrypt(
  plain: Bytes,
  combinedKey: Bytes,
  associatedData: Bytes,
): Promise<Bytes> {
  assertAssociatedData(associatedData);
  const { aesKey, hmacKey } = splitKey(combinedKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const key = await importAesKey(aesKey, 'encrypt');
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain));

  const authenticated = concat(int32LE(iv.length), iv, int32LE(cipher.length), cipher);

  const mac = await importHmacKey(hmacKey, ['sign']);
  const tag = new Uint8Array(
    await crypto.subtle.sign('HMAC', mac, concat(authenticated, associatedData)),
  );

  return concat(authenticated, tag);
}

/**
 * Verifies the authentication tag and decrypts.
 *
 * @param payload The encrypted bytes as produced by {@link encrypt} or by the server.
 * @param combinedKey The 64-byte session key exchanged at login.
 * @param associatedData The bytes the writer passed to {@link encrypt}. There is no retry
 *   without them: a reader that also accepted a payload tagged without its binding could be
 *   downgraded by anyone who sends one.
 * @throws When the payload is malformed or its tag does not verify.
 */
export async function decrypt(
  payload: Bytes,
  combinedKey: Bytes,
  associatedData: Bytes,
): Promise<Bytes> {
  assertAssociatedData(associatedData);
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
  const authenticated = concat(payload.subarray(0, cipherStart + cipherLength), associatedData);

  // `verify` compares in constant time, which is the property the framework's own
  // `FixedTimeEquals` provides on the other end.
  const mac = await importHmacKey(hmacKey, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', mac, tag, authenticated))) {
    throw new Error('HMAC validation failed.');
  }

  const key = await importAesKey(aesKey, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipher));
}
