import { decryptSessionKey, generateHandshakeKeyPair } from '../crypto/rsa.js';
import { PayloadFormat, type PayloadFormatValue } from '../transport/envelope.js';
import type { JsonRpcTransport } from '../transport/client.js';
import { WireTypeNames } from '../contracts/type-names.js';
import type * as Contracts from '../contracts/messages.js';

/**
 * System-level calls: the session lifecycle and the definition endpoints.
 *
 * Method names are `System.<action>`, which is how the server routes them.
 */
export class SystemConnector {
  readonly #transport: JsonRpcTransport;
  #timeZone = 'UTC';
  #culture: string | undefined;

  constructor(transport: JsonRpcTransport) {
    this.#transport = transport;
  }

  /**
   * The signed-in user's time zone, an IANA id such as `Asia/Taipei`, from the login response.
   *
   * `UTC` before `login`, after `logout`, and when the account has none. This, not the device's
   * zone, is the one a `DateTime` is shown in.
   */
  get timeZone(): string {
    return this.#timeZone;
  }

  /** The signed-in user's culture, such as `zh-TW`, from the login response; absent when it has none. */
  get culture(): string | undefined {
    return this.#culture;
  }

  /**
   * Checks that the host is reachable.
   *
   * Anonymous, and the one method exempt from the API key — so it answers even when the database
   * is unavailable, which is what makes it usable as a health check.
   */
  async ping(clientName = 'polhem-connector'): Promise<Contracts.PingResponse> {
    return this.#transport.execute<Contracts.PingResponse>(
      'System.Ping',
      { clientName, traceId: crypto.randomUUID() } satisfies Contracts.PingRequest,
      { format: PayloadFormat.Plain },
    );
  }

  /**
   * Signs in, completing the RSA handshake and installing the session on the transport.
   *
   * The private key never leaves this call: the server wraps the session key with the public half,
   * and the unwrapped result goes straight onto the transport so subsequent calls can encrypt.
   * From here on, `execute` defaults to `Encrypted`.
   */
  async login(userId: string, password: string): Promise<Contracts.LoginResponse> {
    const { publicKeyPem, privateKey } = await generateHandshakeKeyPair();

    // Encoded rather than Encrypted: there is no session key yet — that is what this call fetches.
    const response = await this.#transport.execute<Contracts.LoginResponse>(
      'System.Login',
      { userId, password, clientPublicKey: publicKeyPem } satisfies Contracts.LoginRequest,
      { format: PayloadFormat.Encoded, typeName: WireTypeNames.LoginRequest },
    );

    // Absent means the empty Guid on this wire, which is no session at all.
    if (!response.accessToken) {
      throw new Error('The login response carried no access token.');
    }
    this.#transport.accessToken = response.accessToken;
    if (response.apiEncryptionKey) {
      this.#transport.setEncryptionKey(
        await decryptSessionKey(response.apiEncryptionKey, privateKey),
      );
    }
    this.#timeZone = response.timeZone || 'UTC';
    this.#culture = response.culture || undefined;

    return response;
  }

  /** Signs out and clears the session state this connector installed. */
  async logout(): Promise<Contracts.LogoutResponse> {
    try {
      return await this.#call<Contracts.LogoutResponse>(
        'Logout',
        {} satisfies Contracts.LogoutRequest,
        WireTypeNames.LogoutRequest,
      );
    } finally {
      // Cleared even when the call fails: the session is gone from this client's point of view
      // either way, and keeping a token that may already be void only produces confusing errors.
      this.#transport.clearSession();
      this.#timeZone = 'UTC';
      this.#culture = undefined;
    }
  }

  /** Reads the deployment's payload settings, which a client needs before it logs in. */
  async getCommonConfiguration(): Promise<Contracts.GetCommonConfigurationResponse> {
    return this.#transport.execute<Contracts.GetCommonConfigurationResponse>(
      'System.GetCommonConfiguration',
      {} satisfies Contracts.GetCommonConfigurationRequest,
      { format: PayloadFormat.Plain },
    );
  }

  /** Enters a company, scoping subsequent calls to its data. */
  async enterCompany(companyId: string): Promise<Contracts.EnterCompanyResponse> {
    return this.#call<Contracts.EnterCompanyResponse>(
      'EnterCompany',
      { companyId } satisfies Contracts.EnterCompanyRequest,
      WireTypeNames.EnterCompanyRequest,
    );
  }

  /** Leaves the current company. */
  async leaveCompany(): Promise<Contracts.LeaveCompanyResponse> {
    return this.#call<Contracts.LeaveCompanyResponse>(
      'LeaveCompany',
      {} satisfies Contracts.LeaveCompanyRequest,
      WireTypeNames.LeaveCompanyRequest,
    );
  }

  /**
   * Reads a form's schema.
   *
   * NOTE: the schema arrives as an **XML string** in `xml`, not as an object. Definitions travel
   * that way on every wire — their nested collections are get-only, so neither JSON nor MessagePack
   * can bind them back.
   */
  async getFormSchema(progId: string): Promise<Contracts.GetFormSchemaResponse> {
    return this.#call<Contracts.GetFormSchemaResponse>(
      'GetFormSchema',
      { progId } satisfies Contracts.GetFormSchemaRequest,
      WireTypeNames.GetFormSchemaRequest,
    );
  }

  /** Reads a form's layout. Like the schema, it arrives as an XML string. */
  async getFormLayout(progId: string): Promise<Contracts.GetFormLayoutResponse> {
    return this.#call<Contracts.GetFormLayoutResponse>(
      'GetFormLayout',
      { progId } satisfies Contracts.GetFormLayoutRequest,
      WireTypeNames.GetFormLayoutRequest,
    );
  }

  #call<T>(action: string, value: unknown, typeName: string, format?: PayloadFormatValue): Promise<T> {
    return this.#transport.execute<T>(`System.${action}`, value, { typeName, format });
  }
}
