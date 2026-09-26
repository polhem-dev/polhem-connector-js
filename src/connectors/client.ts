import { JsonRpcTransport, type TransportOptions } from '../transport/client.js';
import { FormConnector } from './form.js';
import { SystemConnector } from './system.js';

/**
 * The entry point most callers want: one transport, with the connectors that ride on it.
 *
 * ```ts
 * const client = new PolhemClient({ endpoint: 'https://host/api', apiKey: '…' });
 * await client.system.login('demo', 'secret');
 * const employees = await client.form('Employee').getList();
 * ```
 *
 * Sign-in state lives on the shared transport, so logging in through `system` is what lets every
 * form connector encrypt — there is nothing else to wire up.
 */
export class PolhemClient {
  readonly transport: JsonRpcTransport;
  readonly system: SystemConnector;

  readonly #forms = new Map<string, FormConnector>();

  constructor(options: TransportOptions) {
    this.transport = new JsonRpcTransport(options);
    this.system = new SystemConnector(this.transport);
  }

  /** Returns the connector for one form, reusing the instance across calls. */
  form(progId: string): FormConnector {
    let connector = this.#forms.get(progId);
    if (!connector) {
      connector = new FormConnector(this.transport, progId);
      this.#forms.set(progId, connector);
    }
    return connector;
  }
}
