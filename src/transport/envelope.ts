import { decrypt, encrypt } from '../crypto/aes-cbc-hmac.js';
import { fromBase64, fromUtf8, toBase64, utf8, type Bytes } from '../crypto/bytes.js';
import { gunzip, gzip } from '../crypto/gzip.js';
import { decodeBody, encodeBody } from '../codec/json-body.js';

/**
 * The JSON-RPC envelope and the payload pipeline inside it.
 *
 * The pipeline is serialize → compress → encrypt, and reverses on the way back. Which steps run is
 * decided by {@link PayloadFormat}; the body codec is named separately, because the two are
 * independent — the format says how well the body is protected, the codec says how it is spelled.
 */

/** How much of the pipeline a payload has been through. Travels as a number. */
export const PayloadFormat = {
  /** No transformation; `value` is the object itself. */
  Plain: 0,
  /** Serialized and compressed. */
  Encoded: 1,
  /** Serialized, compressed and encrypted. */
  Encrypted: 2,
} as const;

export type PayloadFormatValue = (typeof PayloadFormat)[keyof typeof PayloadFormat];

/**
 * The body codec this package speaks.
 *
 * An omitted codec means MessagePack, which is the framework's default and which this package does
 * not implement — so every encoded payload here names `json` explicitly.
 */
export const JSON_CODEC = 'json';

/** A JSON-RPC payload: the `params` of a request, or the `result` of a response. */
export interface ApiPayload {
  format: PayloadFormatValue;
  value: unknown;
  type?: string;
  codec?: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: ApiPayload;
  id: string;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  method?: string;
  result?: ApiPayload;
  error?: JsonRpcErrorBody;
  id: string | null;
}

/** An error returned by the server, carrying its JSON-RPC code. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Builds the payload for a request.
 *
 * @param value The request object.
 * @param format How far through the pipeline to take it.
 * @param typeName The assembly-qualified type name. Required unless the format is Plain: the server
 *   resolves the target type from it, and screens it against an allow-list first.
 * @param encryptionKey The session key from the login handshake; required for `Encrypted`.
 */
export async function buildPayload(
  value: unknown,
  format: PayloadFormatValue,
  typeName?: string,
  encryptionKey?: Bytes,
): Promise<ApiPayload> {
  if (format === PayloadFormat.Plain) {
    // A Plain payload carries the object itself and needs no type name — the server resolves the
    // target type from the business object's method signature instead.
    return { format, value };
  }

  if (!typeName) {
    throw new Error('An encoded payload must name its type.');
  }

  let bytes = await gzip(utf8(encodeBody(value)));

  if (format === PayloadFormat.Encrypted) {
    if (!encryptionKey) {
      throw new Error('Encryption key is required for an encrypted payload.');
    }
    bytes = await encrypt(bytes, encryptionKey);
  }

  return { format, codec: JSON_CODEC, type: typeName, value: toBase64(bytes) };
}

/**
 * Restores a payload received from the server.
 *
 * The codec is read off the payload rather than assumed: the server answers in whatever the request
 * asked for, so a mismatch should fail here rather than decode into something wrong.
 */
export async function restorePayload(payload: ApiPayload, encryptionKey?: Bytes): Promise<unknown> {
  if (payload.format === PayloadFormat.Plain) {
    return payload.value;
  }

  if (payload.codec && payload.codec !== JSON_CODEC) {
    throw new Error(
      `The server answered with the '${payload.codec}' codec, which this package cannot read.`,
    );
  }

  let bytes = fromBase64(payload.value as string);

  if (payload.format === PayloadFormat.Encrypted) {
    if (!encryptionKey) {
      throw new Error('Encryption key is required to read an encrypted payload.');
    }
    bytes = await decrypt(bytes, encryptionKey);
  }

  return decodeBody(fromUtf8(await gunzip(bytes)));
}
