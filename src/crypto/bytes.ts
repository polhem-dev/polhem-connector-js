/** Byte helpers shared by the payload pipeline. */

/**
 * A byte array backed by a plain `ArrayBuffer`.
 *
 * Web Crypto refuses a buffer that might be shared, and since TypeScript 5.7 `Uint8Array` carries
 * its buffer type as a parameter — so the bare `Uint8Array` (which widens to `ArrayBufferLike`)
 * does not satisfy `BufferSource`. Naming the narrow form once keeps that detail out of every
 * signature.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Decodes a Base64 string into bytes. */
export function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes bytes as a Base64 string. */
export function toBase64(bytes: Bytes): string {
  let binary = '';
  // Chunked to keep the argument list well inside the engine's limit for large payloads.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Concatenates byte arrays into one. */
export function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Encodes a 32-bit signed integer as little-endian bytes, matching .NET's BinaryWriter. */
export function int32LE(value: number): Bytes {
  const buffer = new Uint8Array(4);
  new DataView(buffer.buffer).setInt32(0, value, true);
  return buffer;
}

/** Reads a little-endian 32-bit signed integer. */
export function readInt32LE(bytes: Bytes, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

/** UTF-8 encodes a string. */
export function utf8(value: string): Bytes {
  return new TextEncoder().encode(value);
}

/** Decodes UTF-8 bytes into a string. */
export function fromUtf8(bytes: Bytes): string {
  return new TextDecoder().decode(bytes);
}
