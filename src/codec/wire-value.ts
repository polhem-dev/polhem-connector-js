import { fromBase64, toBase64, type Bytes } from '../crypto/bytes.js';
import { DB_NULL } from './db-null.js';
import type * as Contracts from '../contracts/messages.js';
import { decodeDataTable, encodeDataTable, isDataTable, type DataTable } from '../data/data-table.js';

/**
 * The discriminated envelope the framework wraps `object`-typed wire members in.
 *
 * JSON cannot carry a value's type: a decimal and a double are both `1.0`, and a Guid, a DateTime
 * and a string are all quoted text. The server therefore writes every such member as a two-element
 * array — `[code, value]` — using the same discriminators as its MessagePack wire.
 *
 * WARNING: getting this wrong produces a wrong value, not an error. A decimal read as a JS number
 * loses precision silently; an int64 past 2^53 loses digits silently.
 */

/** Discriminators, fixed by the framework's wire format. Never renumber. */
export const WireValueCode = {
  Boolean: 1,
  Byte: 2,
  SByte: 3,
  Int16: 4,
  UInt16: 5,
  Int32: 6,
  UInt32: 7,
  Int64: 8,
  UInt64: 9,
  Single: 10,
  Double: 11,
  Decimal: 12,
  String: 13,
  DateTime: 14,
  DateTimeOffset: 15,
  TimeSpan: 16,
  DateOnly: 17,
  Guid: 18,
  ByteArray: 19,
  DBNull: 20,
  DataTable: 21,
  ObjectArray: 22,
} as const;

export type WireValueCodeValue = (typeof WireValueCode)[keyof typeof WireValueCode];

export { DB_NULL };

/**
 * A value carrying an explicit discriminator.
 *
 * Needed where JavaScript cannot express the distinction the server needs: a decimal and a double
 * are both `number`, a Guid and a string are both `string`. Build one with {@link tag}.
 */
export interface TaggedWireValue {
  readonly code: WireValueCodeValue;
  readonly value: unknown;
}

/** Values this codec can carry. */
export type WireValue =
  | boolean
  | number
  | bigint
  | string
  | Date
  | Bytes
  | typeof DB_NULL
  | TaggedWireValue
  | DataTable
  | readonly WireValue[]
  | null
  | undefined;

/** Marks a value with an explicit discriminator. */
export function tag(code: WireValueCodeValue, value: unknown): TaggedWireValue {
  return { code, value };
}

/** Convenience markers for the types JavaScript cannot tell apart on its own. */
export const wire = {
  /** A decimal. Pass the digits as a string — a JS number cannot hold decimal precision. */
  decimal: (value: string) => tag(WireValueCode.Decimal, value),
  /** A Guid in `D` format (`xxxxxxxx-xxxx-...`). */
  guid: (value: string) => tag(WireValueCode.Guid, value),
  /** A 32-bit integer, where a plain `number` would otherwise be sent as a double. */
  int32: (value: number) => tag(WireValueCode.Int32, value),
  /** A date without a time, as `yyyy-MM-dd`. */
  dateOnly: (value: string) => tag(WireValueCode.DateOnly, value),
  /** A time span in .NET's constant format, e.g. `1.02:03:04.0050000`. */
  timeSpan: (value: string) => tag(WireValueCode.TimeSpan, value),
  /** A date and time with an offset, in round-trip format. Kept as text to preserve the offset. */
  dateTimeOffset: (value: string) => tag(WireValueCode.DateTimeOffset, value),
} as const;

/** Formats a Date in .NET's round-trip (`O`) format, which carries seven fractional digits. */
function toRoundTripUtc(value: Date): string {
  // toISOString gives milliseconds; .NET reads the remaining ticks as zero.
  return value.toISOString().replace(/\.(\d{3})Z$/, '.$10000Z');
}

/**
 * Encodes a value into its wire envelope.
 *
 * `null` and `undefined` return `null`: the server omits a null object-typed member entirely, and
 * a reader must treat an absent property the same way.
 */
export function encodeWireValue(value: WireValue): unknown {
  if (value === null || value === undefined) return null;
  if (value === DB_NULL) return [WireValueCode.DBNull, null];

  if (typeof value === 'boolean') return [WireValueCode.Boolean, value];
  if (typeof value === 'bigint') return [WireValueCode.Int64, value.toString()];
  if (typeof value === 'string') return [WireValueCode.String, value];
  if (value instanceof Date) return [WireValueCode.DateTime, toRoundTripUtc(value)];
  if (value instanceof Uint8Array) return [WireValueCode.ByteArray, toBase64(value)];
  if (Array.isArray(value)) {
    return [WireValueCode.ObjectArray, value.map((item) => encodeWireValue(item as WireValue))];
  }

  if (typeof value === 'number') {
    // A whole number inside Int32 goes as Int32; anything else is a double. Use `wire.decimal`
    // when the server expects a decimal — that distinction cannot be inferred from a JS number.
    const isInt32 = Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    return [isInt32 ? WireValueCode.Int32 : WireValueCode.Double, value];
  }

  if (isDataTable(value)) return [WireValueCode.DataTable, encodeDataTable(value)];

  if (typeof value === 'object' && 'code' in value) {
    const tagged = value as TaggedWireValue;
    return [tagged.code, encodeTagged(tagged)];
  }

  throw new Error(`Cannot encode value of type ${typeof value} as a wire value.`);
}

function encodeTagged(tagged: TaggedWireValue): unknown {
  const { code, value } = tagged;
  if (code === WireValueCode.ByteArray) return toBase64(value as Bytes);
  if (code === WireValueCode.DateTime && value instanceof Date) return toRoundTripUtc(value);
  if (code === WireValueCode.Int64 || code === WireValueCode.UInt64) return String(value);
  // DBNull carries no payload — the discriminator is what distinguishes it from a real null.
  if (code === WireValueCode.DBNull) return null;
  if (code === WireValueCode.DataTable) return encodeDataTable(value as DataTable);
  // Each element carries its own discriminator, so the array recurses through the same envelope.
  if (code === WireValueCode.ObjectArray) {
    return (value as WireValue[]).map((item) => encodeWireValue(item));
  }
  return value;
}

/**
 * Decodes a wire envelope back into a JavaScript value.
 *
 * Type mapping worth knowing:
 * - `Int64` / `UInt64` become `bigint`, because a JS number cannot hold them.
 * - `Decimal` stays a **string**; JavaScript has no decimal, and converting would lose precision.
 * - `DateTime` becomes a `Date`. The wire is UTC in both directions, so no zone is inferred.
 * - `DateTimeOffset`, `TimeSpan` and `DateOnly` stay strings, which is the only lossless form here.
 * - `DBNull` becomes {@link DB_NULL}, distinct from a missing property.
 * - `DataTable` becomes a decoded {@link DataTable}, its cells converted by their column's type.
 *
 * IMPORTANT: decoding is lossy for the *narrower* codes, because JavaScript has no type to hold
 * them apart. A byte, an int16 and an int32 all decode to `number`; a decimal decodes to `string`
 * and is indistinguishable from a plain string afterwards. Re-encoding a decoded value therefore
 * infers a code, which may be wider than the original — inside an `ObjectArray` that applies to
 * every element. Where the exact code matters, mark it with {@link wire} (e.g. `wire.decimal`)
 * rather than relying on a value that came off the wire to remember what it was.
 */
export function decodeWireValue(raw: unknown): WireValue {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error('A wire value envelope must be a two-element array.');
  }

  const [code, value] = raw as [unknown, unknown];
  if (typeof code !== 'number') {
    // A string discriminator is the server's escape hatch for application-configured types.
    throw new Error(`Unsupported wire value discriminator '${String(code)}'.`);
  }

  switch (code) {
    case WireValueCode.Boolean:
      return value as boolean;

    case WireValueCode.Byte:
    case WireValueCode.SByte:
    case WireValueCode.Int16:
    case WireValueCode.UInt16:
    case WireValueCode.Int32:
    case WireValueCode.UInt32:
    case WireValueCode.Single:
    case WireValueCode.Double:
      return value as number;

    case WireValueCode.Int64:
    case WireValueCode.UInt64:
      return BigInt(value as string);

    // Kept as text on purpose: JavaScript has no decimal type, and `Number(value)` would silently
    // round anything past 2^53 or with more than 15 significant digits.
    case WireValueCode.Decimal:
    case WireValueCode.String:
    case WireValueCode.TimeSpan:
    case WireValueCode.DateOnly:
    case WireValueCode.Guid:
    case WireValueCode.DateTimeOffset:
      return value as string;

    case WireValueCode.DateTime:
      return new Date(value as string);

    case WireValueCode.ByteArray:
      return fromBase64(value as string);

    case WireValueCode.DBNull:
      return DB_NULL;

    case WireValueCode.ObjectArray:
      return (value as unknown[]).map(decodeWireValue);

    case WireValueCode.DataTable:
      return decodeDataTable(value as Contracts.DataTable);

    default:
      throw new Error(`Unknown wire value code ${code}.`);
  }
}
