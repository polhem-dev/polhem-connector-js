import { fromBase64, fromUtf8, toBase64, type Bytes } from './bytes.js';

/**
 * The RSA half of the login handshake, matching the framework's `RsaCryptor`.
 *
 * The client generates a key pair, sends the public key with the login request, and the server
 * returns the session key encrypted with it. Only the public key ever leaves this process — the
 * private key stays a non-extractable `CryptoKey`.
 */

const ALGORITHM = 'RSA-OAEP';
const MODULUS_LENGTH = 2048;
const HASH = 'SHA-256';
const PUBLIC_EXPONENT = new Uint8Array([0x01, 0x00, 0x01]); // 65537

/** A handshake key pair: the PEM to send, and the key that never leaves. */
export interface HandshakeKeyPair {
  /** SubjectPublicKeyInfo PEM, the form the server's `ImportFromPem` expects. */
  publicKeyPem: string;
  /** Kept in memory only; used to unwrap the session key the server returns. */
  privateKey: CryptoKey;
}

/** Wraps Base64 in PEM armour, wrapped at 64 characters as the format prescribes. */
function toPem(base64: string, label: string): string {
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Strips PEM armour and whitespace, leaving the Base64 body. */
function fromPem(pem: string): Bytes {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return fromBase64(body);
}

/**
 * Generates the 2048-bit RSA-OAEP/SHA-256 key pair the handshake uses.
 *
 * WARNING: the padding and hash have to match the server exactly. RSA-OAEP with the wrong hash
 * does not fail loudly at the server — it fails at decryption here, long after the request looked
 * like it succeeded.
 */
export async function generateHandshakeKeyPair(): Promise<HandshakeKeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: ALGORITHM,
      modulusLength: MODULUS_LENGTH,
      publicExponent: PUBLIC_EXPONENT,
      hash: HASH,
    },
    // Not extractable. Per the Web Crypto spec this flag governs the private key only — an RSA
    // public key is always exportable — so the PEM below still works while the private key cannot
    // leave the browser, not even through a bug in this package.
    false,
    ['encrypt', 'decrypt'],
  );

  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return {
    publicKeyPem: toPem(toBase64(spki), 'PUBLIC KEY'),
    privateKey: pair.privateKey,
  };
}

/**
 * Decrypts a Base64 ciphertext with the handshake private key, returning the UTF-8 text inside.
 *
 * Mirrors the server's `DecryptWithPrivateKey`, which encrypts a **string** rather than raw bytes.
 */
export async function decryptWithPrivateKey(
  base64CipherText: string,
  privateKey: CryptoKey,
): Promise<string> {
  const cipher = fromBase64(base64CipherText);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: ALGORITHM }, privateKey, cipher),
  );
  return fromUtf8(plain);
}

/**
 * Unwraps the session key returned by a successful login.
 *
 * WARNING: the value is double-encoded, and getting this wrong produces a key of the wrong length
 * rather than an error. The RSA ciphertext holds a **UTF-8 string**, that string is Base64, and
 * only decoding it yields the 64-byte combined key that
 * {@link import('./aes-cbc-hmac.js').encrypt} expects.
 */
export async function decryptSessionKey(
  apiEncryptionKey: string,
  privateKey: CryptoKey,
): Promise<Bytes> {
  const base64Key = await decryptWithPrivateKey(apiEncryptionKey, privateKey);
  const key = fromBase64(base64Key);
  if (key.length !== 64) {
    throw new Error(`Session key must be 64 bytes, got ${key.length}.`);
  }
  return key;
}

/** Imports a PKCS#8 private key PEM. Used by the wire-compatibility tests, not by the handshake. */
export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    fromPem(pem),
    { name: ALGORITHM, hash: HASH },
    false,
    ['decrypt'],
  );
}
