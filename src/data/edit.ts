import type * as Contracts from '../contracts/messages.js';
import { cellEquals, checkCell, decodeCell, type CellInput, type CellValue } from './cells.js';
import type { DataRow, DataSet, DataTable } from './data-table.js';

/**
 * Pure functions that change a decoded DataTable the way `Save` needs it changed.
 *
 * Each returns a new table and leaves its argument untouched, so it fits any state store that
 * compares by reference. A row is named by the row object itself, not by its index: removing an
 * added row shifts every index after it.
 *
 * IMPORTANT: always pass a row taken from the table you pass. A changed row is a new object, so the
 * row from before an update is no longer in the table that update returned, and passing it throws.
 */

/** The column the server keys a row by; it refuses an update that changes it. */
const ROW_ID = 'sys_rowid';

/** The column that links a detail row to its master row's `sys_rowid`. */
const MASTER_ROW_ID = 'sys_master_rowid';

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Sets one cell.
 *
 * An `Unchanged` row becomes `Modified`, with `original` set to the values it had before. A
 * `Modified` row keeps its `original`; an `Added` row never gets one. Setting the value a cell
 * already holds changes nothing and returns the same table.
 *
 * @throws When the row is not in the table, is `Deleted`, or the column does not exist; when the
 * value does not fit the column's type (a `Decimal` takes a string, a `Long` a bigint, a `Date`
 * `'YYYY-MM-DD'`); and when the change would give a row the server already has a different
 * `sys_rowid`, which the server refuses.
 */
export function setCell(
  table: DataTable,
  row: DataRow,
  columnName: string,
  value: CellInput,
): DataTable {
  const index = indexOfRow(table, row);
  if (row.state === 'Deleted') throw new Error('Cannot set a cell of a Deleted row.');

  const cell = checkCell(columnOf(table, columnName), value);
  const current = row.current!;
  if (cellEquals(current[columnName], cell)) return table;

  if (columnName === ROW_ID && row.state !== 'Added') {
    throw new Error(`Cannot change ${ROW_ID} of a row the server already has; it would refuse the save.`);
  }

  const changed: DataRow =
    row.state === 'Added'
      ? { state: 'Added', current: { ...current, [columnName]: cell } }
      : {
          state: 'Modified',
          current: { ...current, [columnName]: cell },
          original: row.state === 'Modified' ? row.original! : current,
        };

  return withRows(table, table.rows.map((r, i) => (i === index ? changed : r)));
}

/** Options for {@link addRow}. */
export interface AddRowOptions {
  /**
   * The master row a detail row belongs to. Its `sys_rowid` becomes the new row's
   * `sys_master_rowid`, unless `values` names that column.
   */
  readonly master?: DataRow;
  /**
   * The IANA time zone whose day a `Date` column defaults to, normally the signed-in user's
   * (`client.timeZone`). Defaults to `UTC`.
   */
  readonly timeZone?: string;
}

/**
 * Adds an `Added` row, seeded the way the framework seeds a new row.
 *
 * Every column takes a value, so the row carries every column. A column named in `values` takes that
 * value. Otherwise `sys_rowid` gets a new Guid, `sys_master_rowid` gets the `sys_rowid` of
 * `options.master` when one is given, and any other column takes its default value from the table,
 * or, when the table has none, the empty value of its type: `''`, `0`, `'0'`, `0n`, `false`, the empty
 * Guid, today in `options.timeZone` for a `Date` and now for a `DateTime`. An `AutoIncrement` column
 * stays `null`; the database numbers it.
 *
 * NOTE: a table read by `getData` carries no column defaults, so its new rows take the empty values.
 * The server keys every row by `sys_rowid` through a unique index, and refuses a detail row whose
 * `sys_master_rowid` is not a master row of the same save.
 *
 * @throws When `values` names a column the table does not have, or holds a value that does not fit
 * its column; when `options.master` is `Deleted` or has no `sys_rowid`.
 */
export function addRow(
  table: DataTable,
  values: Readonly<Record<string, CellInput>> = {},
  options: AddRowOptions = {},
): DataTable {
  for (const name of Object.keys(values)) columnOf(table, name);

  const current: Record<string, CellValue> = {};
  for (const column of table.columns) {
    current[column.name] =
      column.name in values
        ? checkCell(column, values[column.name]!)
        : seedCell(column, options);
  }

  return withRows(table, [...table.rows, { state: 'Added', current }]);
}

/**
 * Deletes a row.
 *
 * An `Added` row is removed outright, since the server has never seen it. Any other row becomes
 * `Deleted` and keeps only its `original`: the values it was read with, not the edited ones, because
 * those are what the server finds it by.
 *
 * @throws When the row is not in the table or is already `Deleted`.
 */
export function deleteRow(table: DataTable, row: DataRow): DataTable {
  const index = indexOfRow(table, row);

  switch (row.state) {
    case 'Deleted':
      throw new Error('The row is already Deleted.');
    case 'Added':
      return withRows(table, table.rows.filter((_, i) => i !== index));
    default: {
      const deleted: DataRow = {
        state: 'Deleted',
        original: row.state === 'Modified' ? row.original! : row.current!,
      };
      return withRows(table, table.rows.map((r, i) => (i === index ? deleted : r)));
    }
  }
}

/** Whether any row of a table, or of any table in a set, is not `Unchanged`. */
export function hasChanges(data: DataTable | DataSet): boolean {
  const tables = 'tables' in data ? data.tables : [data];
  return tables.some((t) => t.rows.some((r) => r.state !== 'Unchanged'));
}

function indexOfRow(table: DataTable, row: DataRow): number {
  const index = table.rows.indexOf(row);
  if (index < 0) {
    throw new Error(
      `The row is not in table '${table.tableName}'. Each change returns a new table with new row ` +
        'objects; take the row from the table the last change returned.',
    );
  }
  return index;
}

function columnOf(table: DataTable, name: string): Contracts.DataColumnShape {
  const column = table.columns.find((c) => c.name === name);
  if (!column) throw new Error(`Table '${table.tableName}' has no column '${name}'.`);
  return column;
}

function withRows(table: DataTable, rows: readonly DataRow[]): DataTable {
  return { ...table, rows };
}

function seedCell(column: Contracts.DataColumnShape, options: AddRowOptions): CellValue {
  if (column.name === ROW_ID) return crypto.randomUUID();
  if (column.name === MASTER_ROW_ID && options.master) return masterRowIdOf(options.master);

  const fromTable = decodeCell(column, column.defaultValue);
  return fromTable ?? emptyValueOf(column, options.timeZone ?? 'UTC');
}

// The master's value is copied as it is, not re-parsed: on SQLite a stored Guid keeps the casing it
// was written with, and the framework links a detail row by the master's exact text.
function masterRowIdOf(master: DataRow): CellValue {
  const rowId = master.current?.[ROW_ID];
  if (rowId === undefined || rowId === null) {
    throw new Error(`The master row has no ${ROW_ID} to link to; a Deleted row cannot be a master.`);
  }
  return rowId;
}

/** The value `FormRowDefaults` gives a column of this type in the framework. */
function emptyValueOf(column: Contracts.DataColumnShape, timeZone: string): CellValue {
  switch (column.type) {
    case 'String':
    case 'Text':
    case 'Time':
      return '';
    case 'Boolean':
      return false;
    case 'Short':
    case 'Integer':
      return 0;
    case 'Long':
      return 0n;
    case 'Decimal':
    case 'Currency':
      return '0';
    case 'Guid':
      return EMPTY_GUID;
    case 'Date':
      return todayIn(timeZone);
    case 'DateTime':
      return new Date();
    case 'Binary':
      return new Uint8Array(0);
    default:
      // `AutoIncrement`, which the database numbers, and any type this package does not know.
      return null;
  }
}

function todayIn(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
