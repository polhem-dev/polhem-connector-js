/**
 * @polhem/connector — JavaScript/TypeScript connector for the Polhem JSON-RPC API.
 *
 * The payload pipeline is serialize → compress → encrypt, and reverses on the way back. Everything
 * below is built on the platform's own Web Crypto and compression streams; no cryptographic code
 * is reimplemented here.
 */

export { decrypt, encrypt } from './crypto/aes-cbc-hmac.js';
export { gunzip, gzip } from './crypto/gzip.js';
export {
  decryptSessionKey,
  decryptWithPrivateKey,
  generateHandshakeKeyPair,
  importPrivateKeyPem,
} from './crypto/rsa.js';
export type { HandshakeKeyPair } from './crypto/rsa.js';
export { concat, fromBase64, fromUtf8, toBase64, utf8 } from './crypto/bytes.js';
export type { Bytes } from './crypto/bytes.js';

export {
  DB_NULL,
  WireValueCode,
  decodeWireValue,
  encodeWireValue,
  tag,
  wire,
} from './codec/wire-value.js';
export type { TaggedWireValue, WireValue, WireValueCodeValue } from './codec/wire-value.js';

export { encodeBody, decodeBody } from './codec/json-body.js';
export {
  AuthenticationRequiredError,
  JSON_CODEC,
  JsonRpcError,
  JsonRpcErrorCode,
  PayloadDirection,
  PayloadFormat,
  buildPayload,
  restorePayload,
} from './transport/envelope.js';
export type {
  ApiPayload,
  JsonRpcErrorBody,
  JsonRpcRequest,
  JsonRpcResponse,
  PayloadBinding,
  PayloadDirectionValue,
  PayloadFormatValue,
} from './transport/envelope.js';
export { JsonRpcTransport } from './transport/client.js';
export type { CallOptions, TransportOptions } from './transport/client.js';

export { PolhemClient } from './connectors/client.js';
export { SystemConnector } from './connectors/system.js';
export { FormConnector } from './connectors/form.js';
export { WireTypeNames } from './contracts/type-names.js';
export type { WireTypeName } from './contracts/type-names.js';

/**
 * The API contract, generated from the framework's message types and synced into this repository.
 * `npm run contracts:check` (run in CI) fails if it drifts from the source.
 *
 * Exported under a namespace rather than flattened: it carries about ninety type names, and a
 * collision with this package's own exports would be dropped silently by a star re-export rather
 * than reported. `Contracts.LoginRequest` also reads as what it is — the server's shape, not ours.
 */
export type * as Contracts from './contracts/messages.js';
