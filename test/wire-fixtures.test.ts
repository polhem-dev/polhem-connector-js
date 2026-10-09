import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WireValueCode, decodeWireValue, encodeWireValue, tag, type WireValueCodeValue } from '../src/codec/wire-value.js';
import type * as Contracts from '../src/contracts/messages.js';
import {
  decodeDataSet,
  decodeDataTable,
  encodeDataSet,
  encodeDataTable,
  type DataTable,
} from '../src/data/data-table.js';

/**
 * Verifies this package against the golden samples published by the framework repository.
 *
 * Run with `npm run test:wire`, which fetches them first. They are not committed here on purpose:
 * a copy would be a second authority for the wire format, and it would drift.
 */

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Fixture {
  case: string;
  description: string;
  codec: string;
  type: string;
  body: Record<string, unknown>;
}

function loadFixtures(): Fixture[] {
  const names = readdirSync(fixtureDir).filter((n) => n.endsWith('.json') && n !== 'SOURCE.json');
  return names.map((n) => JSON.parse(readFileSync(join(fixtureDir, n), 'utf8')) as Fixture);
}

const fixtures = loadFixtures();

/** Samples built by wrapping one value in a `Parameter`, i.e. the object-typed member cases. */
const valueFixtures = fixtures.filter((f) => f.case.startsWith('value-'));

describe('wire fixtures', () => {
  it('found the fixtures (an empty set would make every check below vacuous)', () => {
    expect(fixtures.length).toBeGreaterThan(20);
    expect(valueFixtures.length).toBeGreaterThan(15);
  });

  it('covers every discriminator the encoder claims to support', () => {
    const codes = new Set(
      valueFixtures
        .map((f) => f.body['value'])
        .filter((v): v is [number, unknown] => Array.isArray(v))
        .map(([code]) => code),
    );
    // Every discriminator the framework can put on this wire has a sample, DataTable included.
    expect(codes.size).toBeGreaterThanOrEqual(20);
  });

  it.each(valueFixtures.map((f) => [f.case, f] as const))(
    'round-trips %s through decode and encode',
    (_name, fixture) => {
      const raw = fixture.body['value'];

      if (raw === undefined) {
        // A null object-typed member is omitted entirely — the property is absent, not null.
        expect(fixture.case).toBe('value-null');
        expect(encodeWireValue(null)).toBeNull();
        return;
      }

      const [code] = raw as [WireValueCodeValue, unknown];

      if (fixture.case === 'value-datatable') {
        // Compared as text, so key order and every digit of the extreme values count too.
        expect(code).toBe(WireValueCode.DataTable);
        expect(JSON.stringify(encodeWireValue(decodeWireValue(raw)))).toBe(JSON.stringify(raw));
        return;
      }

      const decoded = decodeWireValue(raw);

      if (fixture.case === 'value-objectarray') {
        // Decoding is lossy for the narrower codes, and inside an array that loss applies to every
        // element: the decimal `[12, "3.5"]` comes back as a plain string and re-encodes as
        // `[13, "3.5"]`. Asserting byte equality here would be asserting something this codec
        // cannot promise — the elements' values survive, their discriminators do not.
        expect(decoded).toEqual([1, 'two', '3.5']);
        return;
      }

      // Re-tagged with the discriminator it arrived with: JavaScript cannot tell a byte from an
      // int32 once decoded, so inference alone could not reproduce the narrower codes.
      expect(encodeWireValue(tag(code, decoded))).toEqual(raw);
    },
  );

  it('re-encodes an object array by inference, widening the element codes', () => {
    const fixture = valueFixtures.find((f) => f.case === 'value-objectarray');
    const raw = fixture!.body['value'];

    const reencoded = encodeWireValue(tag(22, decodeWireValue(raw)));

    // Documented consequence rather than a bug: the decimal element widens to a string. Callers
    // that need the original code must mark it with `wire.decimal` when building the value.
    expect(reencoded).toEqual([22, [[6, 1], [13, 'two'], [13, '3.5']]]);
  });

  it('keeps decimal precision that a JS number would lose', () => {
    const fixture = valueFixtures.find((f) => f.case === 'value-decimal');
    expect(fixture).toBeDefined();

    const [, value] = fixture!.body['value'] as [number, string];
    const decoded = decodeWireValue(fixture!.body['value']);

    expect(typeof decoded).toBe('string');
    expect(decoded).toBe(value);
    // The point of keeping it as text: through a JS number this digit sequence does not survive.
    expect(String(Number(value))).not.toBe(value);
  });

  it('reads int64 past 2^53 as bigint without losing digits', () => {
    const fixture = valueFixtures.find((f) => f.case === 'value-int64');
    const [, value] = fixture!.body['value'] as [number, string];

    const decoded = decodeWireValue(fixture!.body['value']);

    expect(typeof decoded).toBe('bigint');
    expect((decoded as bigint).toString()).toBe(value);
    expect(Number(value).toString()).not.toBe(value);
  });

  describe('DataTable and DataSet', () => {
    const body = (name: string) => fixtures.find((f) => f.case === name)!.body;

    it('found the top-level samples, which no value-* case covers', () => {
      expect(fixtures.map((f) => f.case)).toEqual(expect.arrayContaining(['datatable', 'dataset']));
    });

    it('round-trips the top-level datatable sample to the same JSON text', () => {
      const raw = body('datatable') as unknown as Contracts.DataTable;
      expect(JSON.stringify(encodeDataTable(decodeDataTable(raw)))).toBe(JSON.stringify(raw));
    });

    it('round-trips the top-level dataset sample to the same JSON text', () => {
      const raw = body('dataset') as unknown as Contracts.DataSet;
      expect(JSON.stringify(encodeDataSet(decodeDataSet(raw)))).toBe(JSON.stringify(raw));
    });

    it('decodes the cells by column type, keeping the extreme values digit for digit', () => {
      const raw = body('datatable') as unknown as Contracts.DataTable;
      const table = decodeDataTable(raw);
      const [unchanged, modified, added] = table.rows;

      expect(unchanged!.current!['amount']).toBe('79228162514264337593543950335');
      expect(modified!.current!['amount']).toBe('0.0000000000000000000000000001');
      expect(unchanged!.current!['ref_no']).toBe(9007199254740993n);
      expect(added!.current!['ref_no']).toBe(9223372036854775807n);
      // Through a JS number, neither survives.
      expect(String(Number('9007199254740993'))).not.toBe('9007199254740993');

      // A DateTime cell has no zone marker and is UTC; read as local time it would shift.
      expect((unchanged!.current!['hired_at'] as Date).toISOString()).toBe('2026-03-14T15:09:26.535Z');
      expect(unchanged!.current!['row_guid']).toBe('6f9619ff-8b86-d011-b42d-00c04fc964ff');

      expect(modified!.state).toBe('Modified');
      expect(modified!.original!['amount']).toBe('10');
      expect(added!.state).toBe('Added');
      expect(added!.original).toBeUndefined();
    });

    it('decodes the enveloped sample to the same table as the top-level one', () => {
      const enveloped = decodeWireValue(valueFixtures.find((f) => f.case === 'value-datatable')!.body['value']);
      const topLevel = decodeDataTable(body('datatable') as unknown as Contracts.DataTable);
      expect(enveloped as DataTable).toEqual(topLevel);
    });

    it('keeps the relations of the dataset sample', () => {
      const dataSet = decodeDataSet(body('dataset') as unknown as Contracts.DataSet);
      expect(dataSet.tables.map((t) => t.tableName)).toEqual(['Master', 'Detail']);
      expect(dataSet.relations[0]!.childColumns).toEqual(['sys_master_rowid']);
    });
  });
});
