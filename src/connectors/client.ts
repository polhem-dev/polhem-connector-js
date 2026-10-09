import { JsonRpcTransport, type TransportOptions } from '../transport/client.js';
import { FormConnector } from './form.js';
import { SystemConnector } from './system.js';

/** Options for {@link PolhemClient.formatDateTime}: `Intl` options, with the zone fixed to the user's. */
export type DateTimeFormatOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'> & {
  /** A BCP 47 locale; defaults to the user's culture. */
  readonly locale?: string;
};

/**
 * The entry point most callers want: one transport, with the connectors that ride on it.
 *
 * ```ts
 * const client = new PolhemClient({ endpoint: 'https://host/api', apiKey: '…' });
 * await client.system.login('demo', 'secret');
 * await client.system.enterCompany('DEMO');
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

  /**
   * The signed-in user's time zone (an IANA id); `UTC` until `login`. See
   * {@link SystemConnector.timeZone}.
   *
   * For components that take a zone themselves, such as a date picker. To show a `DateTime`, use
   * {@link PolhemClient.formatDateTime}.
   */
  get timeZone(): string {
    return this.system.timeZone;
  }

  /**
   * Formats a `DateTime` in the signed-in user's time zone.
   *
   * WARNING: `Date.prototype.toLocaleString()` and `getHours()` use the device's zone, which is not
   * the user's: an account set to Tokyo, used from a laptop in Taipei, would show Taipei time.
   *
   * @param value The instant, e.g. a `DateTime` cell, which is decoded as UTC.
   * @param options `Intl.DateTimeFormat` options, without `timeZone`; when left out, the date and
   * the time in the medium style. `locale` defaults to the user's culture from the login response,
   * then to the runtime's own.
   */
  formatDateTime(value: Date, options?: DateTimeFormatOptions): string {
    const { locale, ...format } = options ?? { dateStyle: 'medium', timeStyle: 'medium' };
    return new Intl.DateTimeFormat(locale ?? this.system.culture, {
      ...format,
      timeZone: this.timeZone,
    }).format(value);
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
