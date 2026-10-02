import { decrypt, encrypt } from '../crypto/aes-cbc-hmac.js';
import { fromBase64, fromUtf8, toBase64, utf8, type Bytes } from '../crypto/bytes.js';
import { gunzip, gzip } from '../crypto/gzip.js';
import { decodeBody, encodeBody, isTaggedWireValue } from '../codec/json-body.js';

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
  result?: ApiPayload;
  error?: JsonRpcErrorBody;
  id: string | null;
}

/**
 * The JSON-RPC error codes the server sends.
 *
 * The authority is the framework's `JsonRpcErrorCode` enum (`src/Polhem.Api.Core/JsonRpc/` in
 * polhem-dev/polhem), which documents when each one is raised. Framework 1.2.0 renumbered
 * `InternalError` from -32000 to -32603, the code JSON-RPC 2.0 defines, so a change there is possible
 * and must be followed here (see ADR-049 in that repository).
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** No usable access token: none, or one that is unknown, invalid or expired. Sign in again. */
  Unauthorized: -32001,
  CompanyNotEntered: -32002,
  CompanyAccessDenied: -32003,
  PermissionDenied: -32004,
  ReplayRejected: -32005,
  /** A message written for the end user by business logic. */
  UserMessage: -32099,
} as const;

/** An error returned by the server, carrying its JSON-RPC code. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  /**
   * The HTTP status the error arrived with, when it was not 200. From framework 1.2.0 every
   * JSON-RPC error arrives with 200, a rejected API key included, so this is set only by a server
   * that answers otherwise, such as an older framework or a proxy in front of it.
   */
  readonly httpStatus: number | undefined;

  constructor(code: number, message: string, data?: unknown, httpStatus?: number) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

/**
 * The call needs a signed-in caller and the server has no usable session for it: the client never
 * signed in, or its access token is unknown, invalid or expired (code
 * {@link JsonRpcErrorCode.Unauthorized}).
 *
 * The remedy is to sign in again; retrying the same call will not help. The transport does not
 * clear its session state when this is raised, because a sign-in may already have replaced the
 * token that failed. A new `login` overwrites both the token and the session key.
 *
 * Distinct from {@link JsonRpcErrorCode.PermissionDenied}, where the caller is signed in but lacks
 * the right, and from an API key rejection, which is an `InvalidRequest` at the HTTP layer.
 */
export class AuthenticationRequiredError extends JsonRpcError {
  constructor(message: string, data?: unknown, httpStatus?: number) {
    super(JsonRpcErrorCode.Unauthorized, message, data, httpStatus);
    this.name = 'AuthenticationRequiredError';
  }
}

/** Builds the error for a JSON-RPC error body, choosing the subclass its code calls for. */
export function toJsonRpcError(error: JsonRpcErrorBody, httpStatus?: number): JsonRpcError {
  return error.code === JsonRpcErrorCode.Unauthorized
    ? new AuthenticationRequiredError(error.message, error.data, httpStatus)
    : new JsonRpcError(error.code, error.message, error.data, httpStatus);
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
    assertNoWireValues(value);
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
 * Refuses a marked wire value inside a Plain payload.
 *
 * A Plain body has no envelope: the server binds an `object`-typed member by its JSON kind (a
 * string stays a string, a number becomes an integer or a decimal), and a JSON object has no CLR
 * counterpart at all. A marked value would travel as `{ code, value }` and reach the data layer as
 * something no database can bind. Typed values need the Encoded or Encrypted format, whose JSON
 * body codec carries the discriminator.
 */
function assertNoWireValues(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  if (isTaggedWireValue(value)) {
    throw new Error(
      'A Plain payload cannot carry a marked wire value; the server binds Plain values by their ' +
        'JSON kind. Use the Encoded or Encrypted format for typed values, or send the bare value.',
    );
  }
  seen.add(value);
  for (const member of Object.values(value)) assertNoWireValues(member, seen);
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
