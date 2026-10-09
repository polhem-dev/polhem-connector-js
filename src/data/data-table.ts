import type * as Contracts from '../contracts/messages.js';
import { decodeCell, encodeCell, type CellValue } from './cells.js';

/**
 * The decoded form of the framework's `DataTable` and `DataSet`.
 *
 * The shape is the wire's own (`columns`, `primaryKeys`, `rows[].state/current/original`); only the
 * cells change, from raw JSON to the values their column type calls for. The wire shapes stay under
 * `Contracts` and never reach application code: `FormConnector` decodes what it reads and encodes
 * what it saves.
 *
 * The data is plain and read-only. Change it with `setCell`, `addRow` and `deleteRow`, which return
 * a new table and keep each row's `state` and `original` the way `Save` needs them.
 */

/** A row's state, which decides whether `Save` inserts, updates or deletes it. */
export type DataRowState = Contracts.DataRowShape['state'];

/** One version of a row: every column of the table, by name. */
export type DataRowValues = Readonly<Record<string, CellValue>>;

/**
 * A row and the versions its state implies.
 *
 * - `Unchanged` and `Added` rows carry `current` only.
 * - `Modified` rows carry `current` and `original`, the values as they were read.
 * - `Deleted` rows carry `original` only.
 */
export interface DataRow {
  readonly state: DataRowState;
  readonly current?: DataRowValues;
  readonly original?: DataRowValues;
}

/** A decoded DataTable. Columns and keys are the wire's own; they need no decoding. */
export interface DataTable {
  readonly tableName: string;
  readonly columns: readonly Contracts.DataColumnShape[];
  readonly primaryKeys: readonly string[];
  readonly rows: readonly DataRow[];
}

/**
 * A decoded DataSet.
 *
 * Relations are kept and sent back as they came: master-detail integrity is checked by the server.
 */
export interface DataSet {
  readonly dataSetName: string;
  readonly tables: readonly DataTable[];
  readonly relations: readonly Contracts.DataRelationShape[];
}

/**
 * A message type with every wire `DataTable` and `DataSet` in it, at any depth, replaced by its
 * decoded form.
 *
 * This is what `FormConnector` takes and returns, so no method signature exposes a wire shape.
 */
export type Decoded<T> = T extends Contracts.DataTable
  ? DataTable
  : T extends Contracts.DataSet
    ? DataSet
    : T extends object
      ? { [K in keyof T]: Decoded<T[K]> }
      : T;

/** Decodes a wire DataTable, converting each cell by its column's type. */
export function decodeDataTable(raw: Contracts.DataTable): DataTable {
  if (!isWireDataTable(raw)) {
    throw new Error('A DataTable must carry tableName, columns, primaryKeys and rows.');
  }
  const decodeValues = (values: Record<string, unknown> | undefined): DataRowValues => {
    const result: Record<string, CellValue> = {};
    // Every column is filled in, so a missing key never reaches the caller as `undefined`.
    for (const column of raw.columns) result[column.name] = decodeCell(column, values?.[column.name]);
    return result;
  };

  return {
    tableName: raw.tableName,
    columns: raw.columns,
    primaryKeys: raw.primaryKeys,
    rows: raw.rows.map((row): DataRow => {
      switch (row.state) {
        case 'Deleted':
          return { state: row.state, original: decodeValues(row.original) };
        case 'Modified':
          return {
            state: row.state,
            current: decodeValues(row.current),
            original: decodeValues(row.original),
          };
        default:
          return { state: row.state, current: decodeValues(row.current) };
      }
    }),
  };
}

/**
 * Encodes a DataTable into its wire form.
 *
 * Writes the versions the row's state implies, with every column in column order, as the server does.
 *
 * @throws When a `Modified` or `Deleted` row has no `original`. The server needs it to find the row
 * it updates or deletes, so sending one without it would fail there instead.
 */
export function encodeDataTable(table: DataTable): Contracts.DataTable {
  if (!isWireDataTable(table)) {
    throw new Error('A DataTable must carry tableName, columns, primaryKeys and rows.');
  }
  const encodeValues = (values: DataRowValues): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const column of table.columns) result[column.name] = encodeCell(column, values[column.name]);
    return result;
  };
  const required = (row: DataRow, version: 'current' | 'original'): DataRowValues => {
    const values = row[version];
    if (!values) {
      throw new Error(`A ${row.state} row of table '${table.tableName}' has no '${version}' values.`);
    }
    return values;
  };

  return {
    tableName: table.tableName,
    columns: [...table.columns],
    primaryKeys: [...table.primaryKeys],
    rows: table.rows.map((row): Contracts.DataRowShape => {
      switch (row.state) {
        case 'Deleted':
          return { state: row.state, original: encodeValues(required(row, 'original')) };
        case 'Modified':
          return {
            state: row.state,
            current: encodeValues(required(row, 'current')),
            original: encodeValues(required(row, 'original')),
          };
        default:
          return { state: row.state, current: encodeValues(required(row, 'current')) };
      }
    }),
  };
}

/** Decodes a wire DataSet. */
export function decodeDataSet(raw: Contracts.DataSet): DataSet {
  if (!Array.isArray(raw?.tables) || !Array.isArray(raw.relations)) {
    throw new Error('A DataSet must carry tables and relations.');
  }
  return {
    dataSetName: raw.dataSetName,
    tables: raw.tables.map(decodeDataTable),
    relations: raw.relations,
  };
}

/** Encodes a DataSet into its wire form. */
export function encodeDataSet(dataSet: DataSet): Contracts.DataSet {
  return {
    dataSetName: dataSet.dataSetName,
    tables: dataSet.tables.map(encodeDataTable),
    relations: [...dataSet.relations],
  };
}

/** Whether a value has the shape of a decoded DataTable, which is how the envelope encoder spots one. */
export function isDataTable(value: unknown): value is DataTable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DataTable).tableName === 'string' &&
    Array.isArray((value as DataTable).columns) &&
    Array.isArray((value as DataTable).rows)
  );
}

/** The decoded and the wire table share this outline; the cells are what tells them apart. */
function isWireDataTable(value: unknown): boolean {
  return isDataTable(value) && Array.isArray((value as DataTable).primaryKeys);
}
