import type { JsonRpcTransport } from '../transport/client.js';
import { WireTypeNames } from '../contracts/type-names.js';
import type * as Contracts from '../contracts/messages.js';
import {
  decodeDataSet,
  decodeDataTable,
  encodeDataSet,
  type Decoded,
} from '../data/data-table.js';

/**
 * CRUD calls against one form.
 *
 * Method names are `<progId>.<action>` — the progId identifies the form, and the server resolves it
 * to a business object through its own registry. One connector is bound to one form.
 *
 * Tables and data sets come back decoded (`DataTable`, `DataSet`): each cell is already the value its
 * column type calls for, and `save` encodes them back. No method here exposes their wire shape.
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
   * A filter is a tree of `FilterGroup` and `FilterCondition` nodes, told apart by `kind`. A
   * condition's values are `object`-typed on the server, so mark them with the `wire` helpers — an
   * unmarked decimal arrives as a string and an unmarked Guid as plain text. Marked values need an
   * encoded or encrypted call, which is the default once signed in; a Plain call refuses them.
   */
  async getList(
    request: Decoded<Contracts.GetListRequest> = {},
  ): Promise<Decoded<Contracts.GetListResponse>> {
    const response = await this.#call<Contracts.GetListResponse>(
      'GetList',
      request,
      WireTypeNames.GetListRequest,
    );
    return withTable(response);
  }

  /** Reads one row by its key. */
  async getData(
    request: Decoded<Contracts.GetDataRequest>,
  ): Promise<Decoded<Contracts.GetDataResponse>> {
    const response = await this.#call<Contracts.GetDataResponse>(
      'GetData',
      request,
      WireTypeNames.GetDataRequest,
    );
    return withDataSet(response);
  }

  /** Builds an unsaved row carrying the form's defaults. */
  async getNewData(
    request: Decoded<Contracts.GetNewDataRequest> = {},
  ): Promise<Decoded<Contracts.GetNewDataResponse>> {
    const response = await this.#call<Contracts.GetNewDataResponse>(
      'GetNewData',
      request,
      WireTypeNames.GetNewDataRequest,
    );
    return withDataSet(response);
  }

  /** Reads the rows a lookup field offers. */
  async getLookup(
    request: Decoded<Contracts.GetLookupRequest>,
  ): Promise<Decoded<Contracts.GetLookupResponse>> {
    const response = await this.#call<Contracts.GetLookupResponse>(
      'GetLookup',
      request,
      WireTypeNames.GetLookupRequest,
    );
    return withTable(response);
  }

  /**
   * Persists a change set.
   *
   * The server applies each row by its `state`, and finds a `Modified` or `Deleted` row by its
   * `original` values. Send back what `getData` or `getNewData` returned, changed through `setCell`,
   * `addRow` and `deleteRow`, which keep both right. Changing a row's values in place leaves its
   * state `Unchanged`, and the server then saves nothing for it.
   */
  async save(request: Decoded<Contracts.SaveRequest>): Promise<Decoded<Contracts.SaveResponse>> {
    const { dataSet, ...rest } = request;
    const wireRequest: Contracts.SaveRequest = dataSet
      ? { ...rest, dataSet: encodeDataSet(dataSet) }
      : rest;
    const response = await this.#call<Contracts.SaveResponse>(
      'Save',
      wireRequest,
      WireTypeNames.SaveRequest,
    );
    return withDataSet(response);
  }

  /** Deletes a row by its key. */
  async delete(request: Contracts.DeleteRequest): Promise<Contracts.DeleteResponse> {
    return this.#call<Contracts.DeleteResponse>('Delete', request, WireTypeNames.DeleteRequest);
  }

  #call<T>(action: string, value: unknown, typeName: string): Promise<T> {
    return this.#transport.execute<T>(`${this.#progId}.${action}`, value, { typeName });
  }
}

function withTable<T extends { table?: Contracts.DataTable }>(response: T): Decoded<T> {
  // A null result stays null, as it did before decoding was added.
  if (response == null) return response as Decoded<T>;
  const { table, ...rest } = response;
  return (table ? { ...rest, table: decodeDataTable(table) } : rest) as Decoded<T>;
}

function withDataSet<T extends { dataSet?: Contracts.DataSet }>(response: T): Decoded<T> {
  // A null result stays null, as it did before decoding was added.
  if (response == null) return response as Decoded<T>;
  const { dataSet, ...rest } = response;
  return (dataSet ? { ...rest, dataSet: decodeDataSet(dataSet) } : rest) as Decoded<T>;
}
