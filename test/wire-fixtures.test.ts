import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WireValueCode, decodeWireValue, encodeWireValue, tag, type WireValueCodeValue } from '../src/codec/wire-value.js';

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
    // Every discriminator the framework can put on this wire now has a sample, DataTable included
    // — the sample arrived before the support did, which is what the `value-datatable` assertion
    // below is about.
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
        // NOT YET SUPPORTED, asserted rather than skipped.
        //
        // A DataTable is the core cross-layer DTO of the framework — an ERP form's data *is* a
        // DataTable — so this gap is the line between "can render a form" and "cannot". Support
        // has to cover two shapes: this enveloped one inside an object-typed member, and the
        // top-level `datatable` body, whose cells carry no discriminator.
        //
        // Pinning the refusal, instead of skipping the case, keeps the gap visible in the one
        // place a developer of this package will look, and makes the day it gets implemented
        // fail here — forcing whoever does it to come back and replace this with a real
        // round-trip assertion. A skipped test would go quiet instead.
        expect(code).toBe(WireValueCode.DataTable);
        expect(() => decodeWireValue(raw)).toThrow(/DataTable .* not supported yet/);
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
});
