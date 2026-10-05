import { describe, expect, it } from 'vitest';
import { MAX_DECOMPRESSED_LENGTH, gunzip, gzip } from '../src/crypto/gzip.js';
import { fromBase64, fromUtf8, utf8 } from '../src/crypto/bytes.js';

const PLAIN = 'Polhem wire compatibility vector — 跨語言驗證';

/** Produced by the framework's `GzipPayloadCompressor`. */
const GZIP_FROM_DOTNET_BASE64 =
  'H4sIAAAAAAAAEwE0AMv/UG9saGVtIHdpcmUgY29tcGF0aWJpbGl0eSB2ZWN0b3Ig4oCUIOi3qOiqnuiogOmpl+itiVaaraQ0AAAA';

describe('gzip', () => {
  it('decompresses output produced by the .NET implementation', async () => {
    expect(fromUtf8(await gunzip(fromBase64(GZIP_FROM_DOTNET_BASE64)))).toBe(PLAIN);
  });

  it('round-trips its own output', async () => {
    expect(fromUtf8(await gunzip(await gzip(utf8(PLAIN))))).toBe(PLAIN);
  });

  it('accepts output up to the limit and refuses output past it', async () => {
    const compressed = await gzip(new Uint8Array(1000));
    expect(await gunzip(compressed, 1000)).toHaveLength(1000);
    await expect(gunzip(compressed, 999)).rejects.toThrow(/more than 999 bytes/);
  });

  it('refuses a limit that is not a positive number', async () => {
    const compressed = await gzip(new Uint8Array(10));
    for (const limit of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      await expect(gunzip(compressed, limit)).rejects.toThrow(RangeError);
    }
  });

  it('limits output to 50 MiB by default, as the framework does', async () => {
    expect(MAX_DECOMPRESSED_LENGTH).toBe(50 * 1024 * 1024);
    const atLimit = await gzip(new Uint8Array(MAX_DECOMPRESSED_LENGTH));
    expect(await gunzip(atLimit)).toHaveLength(MAX_DECOMPRESSED_LENGTH);
    const pastLimit = await gzip(new Uint8Array(MAX_DECOMPRESSED_LENGTH + 1));
    await expect(gunzip(pastLimit)).rejects.toThrow(/more than 52428800 bytes/);
  });
});
