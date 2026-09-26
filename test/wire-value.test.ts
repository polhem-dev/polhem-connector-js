import { describe, expect, it } from 'vitest';
import {
  DB_NULL,
  WireValueCode,
  decodeWireValue,
  encodeWireValue,
  tag,
  wire,
} from '../src/codec/wire-value.js';
import { toBase64 } from '../src/crypto/bytes.js';

/** Offline checks for the envelope's own rules; cross-language proof lives in wire-fixtures. */
describe('wire value envelope', () => {
  it('omits a null member rather than writing a null value', () => {
    expect(encodeWireValue(null)).toBeNull();
    expect(encodeWireValue(undefined)).toBeNull();
    // Decoding must treat an absent property the same way.
    expect(decodeWireValue(null)).toBeNull();
  });

  it('keeps DBNull distinct from a real null', () => {
    expect(encodeWireValue(DB_NULL)).toEqual([WireValueCode.DBNull, null]);
    expect(decodeWireValue([WireValueCode.DBNull, null])).toBe(DB_NULL);
  });

  it('infers int32 for whole numbers in range and double otherwise', () => {
    expect(encodeWireValue(42)).toEqual([WireValueCode.Int32, 42]);
    expect(encodeWireValue(2147483648)).toEqual([WireValueCode.Double, 2147483648]);
    expect(encodeWireValue(1.5)).toEqual([WireValueCode.Double, 1.5]);
  });

  it('sends bigint as quoted int64, which a JSON number could not hold', () => {
    expect(encodeWireValue(9007199254740993n)).toEqual([WireValueCode.Int64, '9007199254740993']);
  });

  it('requires an explicit marker for types JavaScript cannot tell apart', () => {
    // Both are `string` and `number` in JavaScript; only the marker says which the server gets.
    expect(encodeWireValue(wire.decimal('12.50'))).toEqual([WireValueCode.Decimal, '12.50']);
    expect(encodeWireValue(wire.guid('6f9619ff-8b86-d011-b42d-00c04fc964ff'))).toEqual([
      WireValueCode.Guid,
      '6f9619ff-8b86-d011-b42d-00c04fc964ff',
    ]);
    expect(encodeWireValue('12.50')).toEqual([WireValueCode.String, '12.50']);
  });

  it('writes dates in the round-trip format the server parses', () => {
    const value = new Date(Date.UTC(2026, 2, 14, 15, 9, 26, 535));
    expect(encodeWireValue(value)).toEqual([WireValueCode.DateTime, '2026-03-14T15:09:26.5350000Z']);
  });

  it('carries byte arrays as base64', () => {
    const bytes = new Uint8Array([1, 2, 250, 255]);
    expect(encodeWireValue(bytes)).toEqual([WireValueCode.ByteArray, toBase64(bytes)]);
    expect(decodeWireValue([WireValueCode.ByteArray, toBase64(bytes)])).toEqual(bytes);
  });

  it('recurses through object arrays, each element carrying its own code', () => {
    expect(encodeWireValue([1, 'two'])).toEqual([
      WireValueCode.ObjectArray,
      [[WireValueCode.Int32, 1], [WireValueCode.String, 'two']],
    ]);
  });

  it('refuses a malformed envelope instead of guessing', () => {
    expect(() => decodeWireValue([1])).toThrow(/two-element/);
    expect(() => decodeWireValue('bare')).toThrow(/two-element/);
    expect(() => decodeWireValue([999, 'x'])).toThrow(/Unknown wire value code/);
  });

  it('refuses a string discriminator, the server-side escape hatch this codec does not implement', () => {
    expect(() => decodeWireValue(['Some.Type, Some.Assembly', {}])).toThrow(/discriminator/);
  });

  it('rejects an unsupported tagged payload rather than sending something wrong', () => {
    expect(() => decodeWireValue([WireValueCode.DataTable, {}])).toThrow(/DataTable/);
    expect(() => encodeWireValue(tag(WireValueCode.DataTable, {}))).not.toThrow();
  });
});
