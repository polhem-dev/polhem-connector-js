import type { Bytes } from '../crypto/bytes.js';
import {
  PayloadDirection,
  PayloadFormat,
  buildPayload,
  restorePayload,
  toJsonRpcError,
  type JsonRpcErrorBody,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PayloadFormatValue,
} from './envelope.js';

/** Header names the server reads. */
const HEADER_API_KEY = 'X-Api-Key';
const HEADER_AUTHORIZATION = 'Authorization';

export interface TransportOptions {
  /** The API endpoint, e.g. `https://host/api`. */
  endpoint: string;
  /** The application identity the server records and gates on. */
  apiKey: string;
  /** Overrides `globalThis.fetch`; useful for tests and for hosts with their own HTTP stack. */
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** Defaults to `Encrypted` when a session key is set, `Plain` otherwise. */
  format?: PayloadFormatValue;
  /** Required for any format other than Plain. */
  typeName?: string;
}

/**
 * Sends JSON-RPC calls to a Polhem backend.
 *
 * Holds the two pieces of per-session state a call needs: the access token that authenticates it,
 * and the session key that encrypts it. Both are set by the login flow.
 */
export class JsonRpcTransport {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  #accessToken: string | null = null;
  #encryptionKey: Bytes | null = null;

  constructor(options: TransportOptions) {
    if (!options.endpoint) throw new Error('endpoint is required.');
    this.#endpoint = options.endpoint;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The current access token, or null before login. */
  get accessToken(): string | null {
    return this.#accessToken;
  }

  set accessToken(value: string | null) {
    this.#accessToken = value;
  }

  /** Whether a session key is available, i.e. whether calls can be encrypted. */
  get hasEncryptionKey(): boolean {
    return this.#encryptionKey !== null;
  }

  /** Installs the session key unwrapped from the login response. */
  setEncryptionKey(key: Bytes | null): void {
    this.#encryptionKey = key;
  }

  /** Clears both pieces of session state. Call on logout. */
  clearSession(): void {
    this.#accessToken = null;
    this.#encryptionKey = null;
  }

  /**
   * Executes one JSON-RPC method.
   *
   * @param method `progId.action`, e.g. `System.Login` or `Employee.GetList`.
   * @param value The request object.
   * @param options Format and type name; both default sensibly for an encrypted session.
   */
  async execute<T>(method: string, value: unknown, options: CallOptions = {}): Promise<T> {
    const format =
      options.format ?? (this.#encryptionKey ? PayloadFormat.Encrypted : PayloadFormat.Plain);

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params: await buildPayload(
        value,
        format,
        options.typeName,
        this.#encryptionKey ?? undefined,
        { direction: PayloadDirection.Request, method },
      ),
      id: crypto.randomUUID(),
    };

    const response = await this.#post(request);

    if (response.error) {
      throw toJsonRpcError(response.error);
    }
    if (!response.result) {
      throw new Error(`The response to '${method}' carried neither a result nor an error.`);
    }

    return (await restorePayload(response.result, this.#encryptionKey ?? undefined, {
      direction: PayloadDirection.Response,
      method,
    })) as T;
  }

  async #post(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [HEADER_API_KEY]: this.#apiKey,
    };
    // Only with a session. A request without the header is an anonymous call, which is what a call
    // before sign-in is; the server lets the method's own access declaration decide whether that is
    // enough. Sending a placeholder token instead would claim a header a deployment may have chosen
    // to require for a method (`IsAuthorizationRequired` on the server's authorization validator).
    if (this.#accessToken) {
      headers[HEADER_AUTHORIZATION] = `Bearer ${this.#accessToken}`;
    }

    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      // The server rejects a request at its HTTP gate (API key, malformed Authorization header,
      // unreadable body) with a JSON-RPC error body, which carries the useful part.
      const text = await response.text();
      const error = parseErrorBody(text);
      if (error) throw toJsonRpcError(error, response.status);
      throw new Error(`HTTP ${response.status} from ${this.#endpoint}: ${text.slice(0, 500)}`);
    }

    return (await response.json()) as JsonRpcResponse;
  }
}

/** Reads the JSON-RPC error out of a non-200 response body, or null when it carries none. */
function parseErrorBody(text: string): JsonRpcErrorBody | null {
  try {
    const body = JSON.parse(text) as Partial<JsonRpcResponse> | null;
    const error = body?.error;
    return error && typeof error.code === 'number' ? error : null;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}
