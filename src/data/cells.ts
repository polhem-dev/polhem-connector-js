import { fromBase64, toBase64, type Bytes } from '../crypto/bytes.js';
import { DB_NULL } from '../codec/db-null.js';
import type { DataColumnShape } from '../contracts/messages.js';

/**
 * Converts DataTable cells between their wire form and JavaScript values.
 *
 * A cell carries no discriminator: its type is the column's `type`, which is the framework's
 * `FieldDbType` name (`FieldDbType.cs` in the framework is the authority for the names). The
 * mapping follows `decodeWireValue` wherever the two overlap, so a caller learns one set of rules.
 */

/**
 * A decoded cell.
 *
 * `null` is the framework's `DBNull`: the wire writes `null` and `DBNull` the same way, so a cell
 * has only one kind of null. A value that is not there at all is a missing key, which decoding
 * never produces — every row carries every column.
 */
export type CellValue = string | number | bigint | boolean | Date | Bytes | null;

/** What the editing functions accept for a cell: a {@link CellValue}, or `DB_NULL` for `null`. */
export type CellInput = CellValue | typeof DB_NULL;

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z?$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parses a DateTime cell as UTC.
 *
 * WARNING: not `new Date(text)`. The cell has no zone marker, and the specification reads a date-time
 * string without one as *local* time, which shifts every cell by the device's offset. The fields are
 * taken apart instead, since `Date` parsing past three fractional digits (.NET writes up to seven) is
 * left to the engine. The digits past the millisecond are dropped.
 */
export function parseUtcCell(text: string): Date {
  const m = DATE_TIME.exec(text);
  if (!m) throw new Error(`'${text}' is not a DateTime cell.`);
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3));
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, ms));
}

/** Formats a Date the way the server writes a DateTime cell: UTC, no zone marker, milliseconds. */
export function formatUtcCell(value: Date): string {
  return value.toISOString().slice(0, -1);
}

/** Decodes one wire cell by its column's type. */
export function decodeCell(column: DataColumnShape, raw: unknown): CellValue {
  if (raw === null || raw === undefined) return null;

  switch (column.type) {
    case 'Decimal':
    case 'Currency':
      // The framework's reader still accepts a bare number from old payloads. Its precision is
      // already gone by now, but the cell keeps the one type callers expect.
      return typeof raw === 'number' ? String(raw) : expect(column, raw, 'string');

    case 'Long':
      if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
      return BigInt(expect(column, raw, 'string'));

    case 'Short':
    case 'Integer':
    case 'AutoIncrement':
      return expect(column, raw, 'number');

    case 'Boolean':
      return expect(column, raw, 'boolean');

    case 'DateTime':
      return parseUtcCell(expect(column, raw, 'string'));

    case 'Date': {
      // A calendar day, not an instant: kept as text so that no time zone can move it by a day.
      const text = expect(column, raw, 'string').slice(0, 10);
      if (!CALENDAR_DATE.test(text)) throw cellError(column, raw);
      return text;
    }

    case 'Binary':
      return fromBase64(expect(column, raw, 'string'));

    case 'String':
    case 'Text':
    case 'Guid':
    case 'Time':
      return expect(column, raw, 'string');

    default:
      // `Unknown`, or a type newer than this package: a JSON primitive passes through as it is.
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
      throw cellError(column, raw);
  }
}

/** Encodes one decoded cell into its wire form. */
export function encodeCell(column: DataColumnShape, value: CellInput | undefined): unknown {
  if (value === null || value === undefined || value === DB_NULL) return null;

  switch (column.type) {
    case 'Long':
      return String(value);
    case 'DateTime':
      return value instanceof Date ? formatUtcCell(value) : value;
    case 'Date':
      // The server writes a calendar day as midnight; written back the same way.
      return typeof value === 'string' && CALENDAR_DATE.test(value) ? `${value}T00:00:00` : value;
    case 'Binary':
      return value instanceof Uint8Array ? toBase64(value) : value;
    default:
      return value;
  }
}

/**
 * Checks that a value fits its column before it goes into a row, and normalizes `DB_NULL` to `null`.
 *
 * Stricter than decoding on purpose: a number for a `Decimal` column is refused rather than
 * converted, because its precision may already be gone by the time it gets here.
 */
export function checkCell(column: DataColumnShape, value: CellInput): CellValue {
  if (value === null || value === DB_NULL) return null;

  const fits = ((): boolean => {
    switch (column.type) {
      case 'Decimal':
      case 'Currency':
        return typeof value === 'string' && DECIMAL.test(value);
      case 'Long':
        return typeof value === 'bigint';
      case 'Short':
      case 'Integer':
      case 'AutoIncrement':
        return typeof value === 'number' && Number.isInteger(value);
      case 'Boolean':
        return typeof value === 'boolean';
      case 'DateTime':
        return value instanceof Date && !Number.isNaN(value.getTime());
      case 'Date':
        return typeof value === 'string' && CALENDAR_DATE.test(value);
      case 'Binary':
        return value instanceof Uint8Array;
      case 'String':
      case 'Text':
      case 'Guid':
      case 'Time':
        return typeof value === 'string';
      default:
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    }
  })();

  if (!fits) {
    throw new Error(
      `A ${describe(value)} does not fit column '${column.name}' of type ${column.type}.` +
        hintFor(column.type),
    );
  }
  return value;
}

/** Whether two decoded cells hold the same value. */
export function cellEquals(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  return a === b;
}

function expect<T extends 'string' | 'number' | 'boolean'>(
  column: DataColumnShape,
  raw: unknown,
  type: T,
): T extends 'string' ? string : T extends 'number' ? number : boolean {
  if (typeof raw !== type) throw cellError(column, raw);
  return raw as never;
}

function cellError(column: DataColumnShape, raw: unknown): Error {
  return new Error(
    `Cannot read ${JSON.stringify(raw)} as a cell of column '${column.name}' of type ${column.type}.`,
  );
}

function describe(value: unknown): string {
  if (value instanceof Date) return 'Date';
  if (value instanceof Uint8Array) return 'Uint8Array';
  return typeof value;
}

function hintFor(type: string): string {
  switch (type) {
    case 'Decimal':
    case 'Currency':
      return ' Pass the digits as a string; a JS number cannot hold decimal precision.';
    case 'Long':
      return ' Pass a bigint; a JS number cannot hold every 64-bit integer.';
    case 'Date':
      return " Pass the day as 'YYYY-MM-DD'.";
    default:
      return '';
  }
}
