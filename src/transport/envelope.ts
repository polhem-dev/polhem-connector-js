import { decrypt, encrypt } from '../crypto/aes-cbc-hmac.js';
import { concat, fromBase64, fromUtf8, toBase64, utf8, type Bytes } from '../crypto/bytes.js';
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

/** Which way an encrypted payload travels. Authenticated as the first byte of its binding. */
export const PayloadDirection = {
  /** The `params` of a call. */
  Request: 1,
  /** The `result` of a call. */
  Response: 2,
} as const;

export type PayloadDirectionValue = (typeof PayloadDirection)[keyof typeof PayloadDirection];

/**
 * What an encrypted payload is bound to: its direction and the JSON-RPC method of the call.
 *
 * The HMAC covers it but the payload does not carry it, so the reader supplies the same binding
 * from the call it is reading. A result is bound to the method of the request it answers. This is
 * what stops a captured payload being replayed as another method, or a result being sent back as
 * the parameters of a call (ADR-003 in polhem-dev/polhem-jsonrpc).
 */
export interface PayloadBinding {
  direction: PayloadDirectionValue;
  /** The JSON-RPC `method`, exactly as sent: `progId.action`. */
  method: string;
}

/** Spells a binding as the HMAC's associated data: the direction byte, then the method in UTF-8. */
function bindingBytes(binding: PayloadBinding | undefined): Bytes {
  if (!binding) {
    throw new Error('An encrypted payload must be bound to its direction and method.');
  }
  const { direction } = binding;
  if (direction !== PayloadDirection.Request && direction !== PayloadDirection.Response) {
    throw new Error(`Unknown payload direction ${String(direction)}.`);
  }
  if (typeof binding.method !== 'string' || binding.method.length === 0) {
    throw new Error('An encrypted payload must be bound to a method.');
  }
  return concat(Uint8Array.of(direction), utf8(binding.method));
}

function isPayloadFormat(value: unknown): value is PayloadFormatValue {
  return (
    value === PayloadFormat.Plain || value === PayloadFormat.Encoded || value === PayloadFormat.Encrypted
  );
}

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
 * @param binding The direction and method the payload is written for; required for `Encrypted`.
 *   A request's parameters are `{ direction: PayloadDirection.Request, method }`.
 */
export async function buildPayload(
  value: unknown,
  format: PayloadFormatValue,
  typeName?: string,
  encryptionKey?: Bytes,
  binding?: PayloadBinding,
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
    bytes = await encrypt(bytes, encryptionKey, bindingBytes(binding));
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
 * The payload must be in the format the caller expects, which for a result is the format its
 * request was sent in, and it is refused before anything is decoded or decrypted otherwise.
 * Without that, anybody on the way could answer an encrypted call with a plain result and the
 * binding would protect nothing (ADR-003, decision 6, in polhem-dev/polhem-jsonrpc).
 *
 * The codec is read off the payload rather than assumed: the server answers in whatever the request
 * asked for, so a mismatch should fail here rather than decode into something wrong.
 *
 * A null result names no type and has an empty body: zero bytes, or gzip of nothing. It reads as
 * `null`, and only after an encrypted one has passed its HMAC.
 *
 * @param payload The payload as received.
 * @param format The format the payload must be in. For a result, the format of its request.
 * @param encryptionKey The session key from the login handshake; required for `Encrypted`.
 * @param binding The direction and method the payload must have been written for; required for
 *   `Encrypted`. A call's result is `{ direction: PayloadDirection.Response, method }`, with the
 *   method of the request it answers. A payload written for anything else fails its HMAC.
 */
export async function restorePayload(
  payload: ApiPayload,
  format: PayloadFormatValue,
  encryptionKey?: Bytes,
  binding?: PayloadBinding,
): Promise<unknown> {
  // Checked before it is used, and never echoed: a caller still on the old signature passes the
  // session key here, and an error message must not carry it.
  if (!isPayloadFormat(format)) {
    throw new Error('The expected payload format must be 0, 1 or 2.');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('The payload is not a JSON object.');
  }

  // An absent format is Plain, as the .NET reader takes it; a null one is not a format.
  const received: unknown = 'format' in payload ? payload.format : PayloadFormat.Plain;
  if (!isPayloadFormat(received)) {
    throw new Error('The payload names an unknown format.');
  }
  if (received !== format) {
    throw new Error(`The payload is in format ${received}, but format ${format} was expected.`);
  }

  if (format === PayloadFormat.Plain) {
    return payload.value;
  }

  const type: unknown = payload.type;
  if (type !== undefined && type !== null && typeof type !== 'string') {
    throw new Error('The payload type must be a string.');
  }

  if (typeof payload.value !== 'string') {
    throw new Error('An encoded payload must carry its body as a Base64 string.');
  }
  let bytes = fromBase64(payload.value);

  if (format === PayloadFormat.Encrypted) {
    if (!encryptionKey) {
      throw new Error('Encryption key is required to read an encrypted payload.');
    }
    bytes = await decrypt(bytes, encryptionKey, bindingBytes(binding));
  }

  if (!type) {
    // The server writes a null result as zero bytes, uncompressed; gzip of nothing is read the same
    // way. Zero bytes are not valid gzip, so they are accepted before decompressing. An empty body
    // reads the same whatever the codec, so the codec is not checked here, as on .NET.
    if (bytes.length === 0 || (await gunzip(bytes)).length === 0) {
      return null;
    }
    throw new Error('A payload that names no type must have an empty body.');
  }

  if (payload.codec && payload.codec !== JSON_CODEC) {
    throw new Error(
      `The server answered with the '${payload.codec}' codec, which this package cannot read.`,
    );
  }

  return decodeBody(fromUtf8(await gunzip(bytes)));
}
