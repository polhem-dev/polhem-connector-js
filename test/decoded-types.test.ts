import { describe, expect, it } from 'vitest';
import type { Contracts, DataSet, DataTable, Decoded, FormConnector } from '../src/index.js';

/**
 * Compile-time checks that no `FormConnector` signature exposes a wire `DataTable` or `DataSet`.
 *
 * They run under `npm run typecheck`: a signature that brings a wire shape back stops compiling
 * here. The runtime assertions only keep vitest from reporting an empty suite.
 */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type WireShape = Contracts.DataTable | Contracts.DataSet;

/**
 * Whether a wire shape appears anywhere inside `T`, down to a depth no message reaches. The limit
 * is there because a filter is a recursive tree, which a walk without one never leaves.
 */
type MentionsWire<T, Depth extends unknown[] = []> = T extends WireShape
  ? true
  : Depth['length'] extends 10
    ? false
    : T extends Date | Uint8Array | ((...args: never[]) => unknown)
      ? false
      : T extends object
        ? true extends { [K in keyof T]-?: MentionsWire<T[K], [...Depth, unknown]> }[keyof T]
          ? true
          : false
        : false;

type Methods = Pick<FormConnector, 'getList' | 'getData' | 'getNewData' | 'getLookup' | 'save' | 'delete'>;
type Signatures = {
  [K in keyof Methods]: [Parameters<Methods[K]>, Awaited<ReturnType<Methods[K]>>];
}[keyof Methods];

const assert = <T extends true>(): T => true as T;

describe('decoded message types', () => {
  it('keeps every wire table and data set out of the FormConnector signatures', () => {
    // The check is not vacuous: the raw messages do carry wire shapes.
    assert<MentionsWire<Contracts.GetListResponse>>();
    assert<MentionsWire<Contracts.SaveRequest>>();
    assert<MentionsWire<[[Contracts.SaveRequest], Contracts.DeleteResponse]>>();
    assert<Equal<MentionsWire<Signatures>, false>>();
    expect(true).toBe(true);
  });

  it('replaces the shapes and keeps optional members optional', () => {
    assert<Equal<Decoded<Contracts.GetListResponse>['table'], DataTable | undefined>>();
    assert<Equal<Decoded<Contracts.SaveRequest>['dataSet'], DataSet | undefined>>();

    // Every member stays optional, as on the wire.
    const empty: Decoded<Contracts.GetListResponse> = {};
    expect(empty).toEqual({});
  });

  it('reaches into nested objects and arrays, and leaves everything else alone', () => {
    type Nested = { outer?: { tables: Contracts.DataTable[]; sets?: Contracts.DataSet[] } };
    assert<Equal<Decoded<Nested>, { outer?: { tables: DataTable[]; sets?: DataSet[] } }>>();

    // A tuple stays a tuple, and a message with no table in it maps onto itself.
    assert<Equal<Decoded<Contracts.WireValueEnvelope>, Contracts.WireValueEnvelope>>();
    assert<Equal<Decoded<Contracts.DeleteRequest>, Contracts.DeleteRequest>>();
    expect(true).toBe(true);
  });
});
