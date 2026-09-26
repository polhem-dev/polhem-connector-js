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

/** Decompresses gzip bytes. */
export async function gunzip(data: Bytes): Promise<Bytes> {
  return through(data, new DecompressionStream('gzip'));
}
