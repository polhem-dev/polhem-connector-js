import type { JsonRpcTransport } from '../transport/client.js';
import { WireTypeNames } from '../contracts/type-names.js';
import type * as Contracts from '../contracts/messages.js';

/**
 * CRUD calls against one form.
 *
 * Method names are `<progId>.<action>` — the progId identifies the form, and the server resolves it
 * to a business object through its own registry. One connector is bound to one form.
 */
export class FormConnector {
  readonly #transport: JsonRpcTransport;
  readonly #progId: string;

  /**
   * @param transport A signed-in transport; these methods all require authentication.
   * @param progId The form identifier, e.g. `Employee`.
   */
  constructor(transport: JsonRpcTransport, progId: string) {
    if (!progId) throw new Error('progId is required.');
    this.#transport = transport;
    this.#progId = progId;
  }

  /** The form this connector is bound to. */
  get progId(): string {
    return this.#progId;
  }

  /**
   * Queries rows.
   *
   * A filter's condition values are `object`-typed on the server, so mark them with the `wire`
   * helpers — an unmarked decimal arrives as a string and an unmarked Guid as plain text.
   */
  async getList(request: Contracts.GetListRequest = {}): Promise<Contracts.GetListResponse> {
    return this.#call<Contracts.GetListResponse>('GetList', request, WireTypeNames.GetListRequest);
  }

  /** Reads one row by its key. */
  async getData(request: Contracts.GetDataRequest): Promise<Contracts.GetDataResponse> {
    return this.#call<Contracts.GetDataResponse>('GetData', request, WireTypeNames.GetDataRequest);
  }

  /** Builds an unsaved row carrying the form's defaults. */
  async getNewData(
    request: Contracts.GetNewDataRequest = {},
  ): Promise<Contracts.GetNewDataResponse> {
    return this.#call<Contracts.GetNewDataResponse>(
      'GetNewData',
      request,
      WireTypeNames.GetNewDataRequest,
    );
  }

  /** Reads the rows a lookup field offers. */
  async getLookup(request: Contracts.GetLookupRequest): Promise<Contracts.GetLookupResponse> {
    return this.#call<Contracts.GetLookupResponse>(
      'GetLookup',
      request,
      WireTypeNames.GetLookupRequest,
    );
  }

  /**
   * Persists a change set.
   *
   * WARNING: the server applies rows by their `state`, so a DataSet round-tripped through a plain
   * `JSON.parse` — which drops that metadata — saves nothing. Send back what `getData` or
   * `getNewData` returned, with the state fields intact.
   */
  async save(request: Contracts.SaveRequest): Promise<Contracts.SaveResponse> {
    return this.#call<Contracts.SaveResponse>('Save', request, WireTypeNames.SaveRequest);
  }

  /** Deletes a row by its key. */
  async delete(request: Contracts.DeleteRequest): Promise<Contracts.DeleteResponse> {
    return this.#call<Contracts.DeleteResponse>('Delete', request, WireTypeNames.DeleteRequest);
  }

  #call<T>(action: string, value: unknown, typeName: string): Promise<T> {
    return this.#transport.execute<T>(`${this.#progId}.${action}`, value, { typeName });
  }
}
