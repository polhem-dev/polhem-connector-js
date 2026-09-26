import { describe, expect, it } from 'vitest';
import { gunzip, gzip } from '../src/crypto/gzip.js';
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
});
