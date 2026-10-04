/**
 * gzip compression, matching the framework's `GzipPayloadCompressor`.
 *
 * Uses the platform's own streams rather than a bundled implementation: `CompressionStream` is
 * available in every browser this package targets and in Node 18+, so the compressed bytes are
 * produced by the same zlib every other tool uses.
 */

import type { Bytes } from './bytes.js';

async function through(data: Bytes, transform: GenericTransformStream): Promise<Bytes> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Compresses bytes with gzip. */
export async function gzip(data: Bytes): Promise<Bytes> {
  return through(data, new CompressionStream('gzip'));
}

/**
 * The most a payload may decompress to: 50 MiB, the default of the framework's
 * `GzipPayloadCompressor`.
 */
export const MAX_DECOMPRESSED_LENGTH = 50 * 1024 * 1024;

/**
 * Decompresses gzip bytes.
 *
 * Counts while it decompresses and stops at the limit, so a small payload that inflates without
 * bound is refused before it is held in memory.
 *
 * @param maxLength The most the output may be, in bytes.
 * @throws When the output would exceed `maxLength`, or the input is not valid gzip.
 */
export async function gunzip(data: Bytes, maxLength = MAX_DECOMPRESSED_LENGTH): Promise<Bytes> {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxLength) {
      await reader.cancel();
      throw new Error(`The payload decompresses to more than ${maxLength} bytes.`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
