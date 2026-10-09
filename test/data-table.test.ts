import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DB_NULL,
  WireValueCode,
  addRow,
  decodeDataSet,
  decodeDataTable,
  decodeWireValue,
  deleteRow,
  encodeDataSet,
  encodeDataTable,
  encodeWireValue,
  hasChanges,
  setCell,
  type Contracts,
  type DataTable,
} from '../src/index.js';

/**
 * Offline checks for the DataTable codec and the editing functions. The framework's own samples
 * are verified in wire-fixtures; these cover what the samples do not, such as a Deleted row.
 */

function column(name: string, type: string, defaultValue: unknown = null): Contracts.DataColumnShape {
  return { name, type, allowNull: true, readOnly: false, maxLength: -1, caption: name, defaultValue };
}

function wireTable(): Contracts.DataTable {
  return {
    tableName: 'Employee',
    columns: [
      column('sys_rowid', 'Guid'),
      column('sys_id', 'String'),
      column('amount', 'Decimal'),
      column('ref_no', 'Long'),
      column('hired_at', 'DateTime'),
      column('birthday', 'Date'),
      column('active', 'Boolean', false),
      column('level', 'Integer', 0),
    ],
    primaryKeys: ['sys_id'],
    rows: [
      {
        state: 'Unchanged',
        current: {
          sys_rowid: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
          sys_id: 'E001',
          amount: '79228162514264337593543950335',
          ref_no: '9223372036854775807',
          hired_at: '2026-03-14T15:09:26.535',
          birthday: '1990-01-31T00:00:00',
          active: true,
          level: 3,
        },
      },
      {
        state: 'Deleted',
        original: {
          sys_rowid: '7f9619ff-8b86-d011-b42d-00c04fc964ff',
          sys_id: 'E002',
          amount: '0.0000000000000000000000000001',
          ref_no: '9007199254740993',
          hired_at: '2026-03-14T15:09:26.535',
          birthday: null,
          active: false,
          level: 1,
        },
      },
    ],
  };
}

describe('DataTable codec', () => {
  // A zone with an offset all year, so that reading the cell as local time would visibly shift it.
  const savedTz = process.env['TZ'];
  beforeAll(() => {
    process.env['TZ'] = 'Asia/Taipei';
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = savedTz;
  });

  it('converts each cell by its column type', () => {
    const row = decodeDataTable(wireTable()).rows[0]!.current!;

    expect(row['amount']).toBe('79228162514264337593543950335');
    expect(row['ref_no']).toBe(9223372036854775807n);
    expect(row['hired_at']).toBeInstanceOf(Date);
    expect(row['birthday']).toBe('1990-01-31');
    expect(row['active']).toBe(true);
    expect(row['level']).toBe(3);
    expect(row['sys_rowid']).toBe('6f9619ff-8b86-d011-b42d-00c04fc964ff');
  });

  it('reads a DateTime cell as UTC, not as the local time the specification would assume', () => {
    const cell = '2026-03-14T15:09:26.535';
    const hired = decodeDataTable(wireTable()).rows[0]!.current!['hired_at'] as Date;

    expect(hired.toISOString()).toBe('2026-03-14T15:09:26.535Z');
    // What this guards against: without a zone marker, `new Date` reads the text as Taipei time.
    expect(new Date(cell).toISOString()).not.toBe('2026-03-14T15:09:26.535Z');
  });

  it('reads the fractions .NET writes, from none to seven digits', () => {
    const table = wireTable();
    const cells = ['2026-03-14T15:09:26', '2026-03-14T15:09:26.5', '2026-03-14T15:09:26.5359999'];
    const decoded = cells.map(
      (hired_at) =>
        decodeDataTable({ ...table, rows: [{ state: 'Added', current: { hired_at } }] }).rows[0]!
          .current!['hired_at'] as Date,
    );

    expect(decoded.map((d) => d.toISOString())).toEqual([
      '2026-03-14T15:09:26.000Z',
      '2026-03-14T15:09:26.500Z',
      '2026-03-14T15:09:26.535Z',
    ]);
  });

  it('refuses a DateTime cell it cannot read rather than producing an invalid Date', () => {
    const table = wireTable();
    expect(() =>
      decodeDataTable({ ...table, rows: [{ state: 'Added', current: { hired_at: 'soon' } }] }),
    ).toThrow(/not a DateTime cell/);
  });

  it('fills every column, so a missing cell is null rather than undefined', () => {
    const table = wireTable();
    const row = decodeDataTable({ ...table, rows: [{ state: 'Added', current: { sys_id: 'E9' } }] })
      .rows[0]!.current!;

    expect(Object.keys(row)).toEqual(table.columns.map((c) => c.name));
    expect(row['amount']).toBeNull();
  });

  it('keeps a Deleted row as its original values only', () => {
    const deleted = decodeDataTable(wireTable()).rows[1]!;

    expect(deleted.state).toBe('Deleted');
    expect(deleted.current).toBeUndefined();
    expect(deleted.original!['sys_id']).toBe('E002');
    expect(deleted.original!['ref_no']).toBe(9007199254740993n);
    expect(deleted.original!['birthday']).toBeNull();
  });

  it('round-trips a table to the same JSON text, Deleted row included', () => {
    const raw = wireTable();
    expect(JSON.stringify(encodeDataTable(decodeDataTable(raw)))).toBe(JSON.stringify(raw));
  });

  it('decodes and re-encodes a DataTable inside an object-typed member', () => {
    const raw = [WireValueCode.DataTable, wireTable()];
    const decoded = decodeWireValue(raw) as DataTable;

    expect(decoded.rows[0]!.current!['ref_no']).toBe(9223372036854775807n);
    // A decoded table needs no marker: nothing else has its outline.
    expect(JSON.stringify(encodeWireValue(decoded))).toBe(JSON.stringify(raw));
  });

  it('accepts DB_NULL as null', () => {
    const table = decodeDataTable(wireTable());
    const changed = setCell(table, table.rows[0]!, 'amount', DB_NULL);

    expect(changed.rows[0]!.current!['amount']).toBeNull();
    expect(encodeDataTable(changed).rows[0]!.current!['amount']).toBeNull();
  });

  it('refuses to encode a Modified row without its original values', () => {
    const table = decodeDataTable(wireTable());
    const broken: DataTable = { ...table, rows: [{ state: 'Modified', current: table.rows[0]!.current! }] };

    expect(() => encodeDataTable(broken)).toThrow(/Modified row .* no 'original'/);
  });

  it('round-trips a data set, keeping its relations', () => {
    const raw: Contracts.DataSet = {
      dataSetName: 'Order',
      tables: [wireTable(), { ...wireTable(), tableName: 'Detail', rows: [] }],
      relations: [
        {
          name: 'Master_Detail',
          parentTable: 'Employee',
          childTable: 'Detail',
          parentColumns: ['sys_id'],
          childColumns: ['sys_id'],
        },
      ],
    };

    expect(JSON.stringify(encodeDataSet(decodeDataSet(raw)))).toBe(JSON.stringify(raw));
  });
});

describe('DataTable editing', () => {
  const fresh = () => decodeDataTable(wireTable());

  it('turns an Unchanged row Modified, keeping the values it was read with as original', () => {
    const table = fresh();
    const before = table.rows[0]!;

    const changed = setCell(table, before, 'amount', '100.50');

    expect(changed).not.toBe(table);
    expect(table.rows[0]).toBe(before); // the argument is left untouched
    expect(changed.rows[0]).toEqual({
      state: 'Modified',
      current: { ...before.current, amount: '100.50' },
      original: before.current,
    });
  });

  it('keeps the first original when a Modified row changes again', () => {
    let table = fresh();
    const read = table.rows[0]!.current!;

    table = setCell(table, table.rows[0]!, 'amount', '100.50');
    table = setCell(table, table.rows[0]!, 'amount', '200');

    expect(table.rows[0]!.state).toBe('Modified');
    expect(table.rows[0]!.original).toBe(read);
  });

  it('keeps an Added row Added, without an original', () => {
    let table = addRow(fresh(), { sys_id: 'E003' });
    table = setCell(table, table.rows[2]!, 'amount', '7');

    expect(table.rows[2]!.state).toBe('Added');
    expect(table.rows[2]!.original).toBeUndefined();
    expect(table.rows[2]!.current!['amount']).toBe('7');
  });

  it('changes nothing when a cell is set to the value it holds', () => {
    const table = fresh();
    const hired = table.rows[0]!.current!['hired_at'] as Date;

    expect(setCell(table, table.rows[0]!, 'hired_at', new Date(hired.getTime()))).toBe(table);
  });

  it('refuses a row that is not in the table, such as the one from before the last change', () => {
    const table = fresh();
    const stale = table.rows[0]!;
    const changed = setCell(table, stale, 'amount', '1');

    expect(() => setCell(changed, stale, 'amount', '2')).toThrow(/not in table 'Employee'/);
    expect(() => deleteRow(changed, stale)).toThrow(/not in table 'Employee'/);
  });

  it('refuses to change a Deleted row', () => {
    const table = fresh();
    expect(() => setCell(table, table.rows[1]!, 'amount', '1')).toThrow(/Deleted row/);
    expect(() => deleteRow(table, table.rows[1]!)).toThrow(/already Deleted/);
  });

  it('refuses an unknown column and a value of the wrong type', () => {
    const table = fresh();
    const row = table.rows[0]!;

    expect(() => setCell(table, row, 'nope', 'x')).toThrow(/no column 'nope'/);
    // A number would already have lost the precision the string keeps.
    expect(() => setCell(table, row, 'amount', 100.5)).toThrow(/as a string/);
    expect(() => setCell(table, row, 'amount', 'abc')).toThrow(/Decimal/);
    expect(() => setCell(table, row, 'ref_no', 1)).toThrow(/bigint/);
    expect(() => setCell(table, row, 'birthday', '1990/01/31')).toThrow(/YYYY-MM-DD/);
    expect(() => setCell(table, row, 'level', 1.5)).toThrow(/Integer/);
  });

  it('refuses to change the sys_rowid of a row the server has, which it would reject', () => {
    const table = fresh();
    expect(() =>
      setCell(table, table.rows[0]!, 'sys_rowid', '00000000-0000-0000-0000-000000000001'),
    ).toThrow(/sys_rowid/);

    const added = addRow(table);
    const withId = setCell(added, added.rows[2]!, 'sys_rowid', '00000000-0000-0000-0000-000000000001');
    expect(withId.rows[2]!.current!['sys_rowid']).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('adds a row carrying every column, defaults filled in', () => {
    const table = addRow(fresh(), { sys_id: 'E003', ref_no: 5n });
    const added = table.rows[2]!;

    expect(added.state).toBe('Added');
    expect(added.current).toEqual({
      sys_rowid: null,
      sys_id: 'E003',
      amount: null,
      ref_no: 5n,
      hired_at: null,
      birthday: null,
      active: false,
      level: 0,
    });
    expect(() => addRow(fresh(), { nope: 1 })).toThrow(/no column 'nope'/);
  });

  it('deletes an Unchanged row down to its original', () => {
    const table = fresh();
    const deleted = deleteRow(table, table.rows[0]!);

    expect(deleted.rows[0]).toEqual({ state: 'Deleted', original: table.rows[0]!.current });
  });

  it('deletes a Modified row down to the values it was read with, not the edited ones', () => {
    let table = fresh();
    const read = table.rows[0]!.current!;
    table = setCell(table, table.rows[0]!, 'amount', '1');
    table = deleteRow(table, table.rows[0]!);

    expect(table.rows[0]).toEqual({ state: 'Deleted', original: read });
  });

  it('removes an Added row outright, since the server never saw it', () => {
    let table = addRow(fresh(), { sys_id: 'E003' });
    table = deleteRow(table, table.rows[2]!);

    expect(table.rows).toHaveLength(2);
  });

  it('tells whether a table or a data set has anything to save', () => {
    const table = fresh();
    const unchanged: DataTable = { ...table, rows: [table.rows[0]!] };

    expect(hasChanges(unchanged)).toBe(false);
    expect(hasChanges(table)).toBe(true); // the Deleted row
    expect(hasChanges(setCell(unchanged, unchanged.rows[0]!, 'amount', '1'))).toBe(true);
    expect(hasChanges({ dataSetName: 'Order', tables: [unchanged], relations: [] })).toBe(false);
    expect(hasChanges({ dataSetName: 'Order', tables: [unchanged, table], relations: [] })).toBe(true);
  });
});
