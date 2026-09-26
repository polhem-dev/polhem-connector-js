import { toBase64, type Bytes } from '../crypto/bytes.js';
import { encodeWireValue, type TaggedWireValue } from './wire-value.js';

/**
 * Serializes and parses the JSON body the server's `json` codec reads.
 *
 * IMPORTANT: only **explicitly marked** values get the discriminated envelope. This package cannot
 * infer which members are `object`-typed on the server — a request's `DateTime` property is a plain
 * ISO string on the wire, while the same value inside a filter condition needs `[14, "…"]`. Mark
 * the latter with the `wire` helpers; everything else is serialized as its natural JSON form, which
 * is what System.Text.Json expects for a typed property.
 */

function isTagged(value: unknown): value is TaggedWireValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'value' in value &&
    typeof (value as TaggedWireValue).code === 'number'
  );
}

/**
 * Encodes a request body as JSON text.
 *
 * Handles the three JavaScript types `JSON.stringify` cannot serialize on its own the way the
 * server expects: marked wire values become their envelope, byte arrays become Base64 (matching
 * System.Text.Json's `byte[]`), and bigint becomes a JSON number.
 */
export function encodeBody(value: unknown): string {
  return JSON.stringify(value, function replacer(this: Record<string, unknown>, key, current) {
    // `current` has already been through `toJSON`, so a Date arrives as its ISO string — which is
    // what a typed DateTime property should be. The raw value is needed for the rest.
    const raw = this[key];

    if (isTagged(raw)) return encodeWireValue(raw);
    if (raw instanceof Uint8Array) return toBase64(raw as Bytes);
    if (typeof raw === 'bigint') {
      // A typed 64-bit property is a JSON number to System.Text.Json. Values past 2^53 cannot
      // survive that, and silently truncating one would be worse than refusing.
      if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error(
          `Cannot serialize ${raw}n as a typed property: it exceeds the range a JSON number holds. ` +
            'Wrap it as a wire value if the server member is object-typed.',
        );
      }
      return Number(raw);
    }

    return current;
  });
}

/** Parses a response body. */
export function decodeBody(json: string): unknown {
  return JSON.parse(json);
}
