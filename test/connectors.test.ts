import { describe, expect, it, vi } from 'vitest';
import { PolhemClient } from '../src/connectors/client.js';
import type * as Contracts from '../src/contracts/messages.js';
import { setCell } from '../src/data/edit.js';
import { WireTypeNames } from '../src/contracts/type-names.js';
import type { JsonRpcRequest } from '../src/transport/envelope.js';
import { PayloadDirection, PayloadFormat, buildPayload, restorePayload } from '../src/transport/envelope.js';

const ENDPOINT = 'https://example.test/api';

/** Records requests and answers with whatever the scenario supplies. */
function mockFetch(reply: (request: JsonRpcRequest) => unknown) {
  const calls: JsonRpcRequest[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string) as JsonRpcRequest;
    calls.push(request);
    return new Response(JSON.stringify(await reply(request)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function clientWith(fetchImpl: typeof fetch) {
  return new PolhemClient({ endpoint: ENDPOINT, apiKey: 'test-key', fetch: fetchImpl });
}

describe('connectors', () => {
  it('routes system calls as System.<action>', async () => {
    const { fn, calls } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: { format: PayloadFormat.Plain, value: { status: 'ok' } },
    }));

    await clientWith(fn).system.ping();

    expect(calls[0]!.method).toBe('System.Ping');
  });

  it('routes form calls as <progId>.<action> and names the request type', async () => {
    const key = new Uint8Array(64).map((_, i) => i);
    const { fn, calls } = mockFetch(async (req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: await buildPayload({}, PayloadFormat.Encrypted, WireTypeNames.GetListResponse, key, {
        direction: PayloadDirection.Response,
        method: req.method,
      }),
    }));

    const client = clientWith(fn);
    client.transport.setEncryptionKey(key); // as login would

    await client.form('Employee').getList({ selectFields: 'sys_id' });

    expect(calls[0]!.method).toBe('Employee.GetList');
    expect(calls[0]!.params.type).toBe(WireTypeNames.GetListRequest);
    expect(calls[0]!.params.codec).toBe('json');
  });

  it('falls back to Plain before a session key exists, which the form methods still allow', async () => {
    const { fn, calls } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: { format: PayloadFormat.Plain, value: {} },
    }));

    // The form methods are declared Public + Authenticated on the server: they need a token, but
    // not encryption. So an un-encrypted call is refused for lacking a token, not for being Plain.
    await clientWith(fn).form('Employee').getList();

    expect(calls[0]!.params.format).toBe(PayloadFormat.Plain);
    expect(calls[0]!.params.type).toBeUndefined();
  });

  it('reuses one connector instance per form', () => {
    const client = clientWith(mockFetch(() => ({})).fn);
    expect(client.form('Employee')).toBe(client.form('Employee'));
    expect(client.form('Employee')).not.toBe(client.form('Customer'));
  });

  it('completes the handshake on login and encrypts everything after it', async () => {
    // Stand in for the server: wrap a session key with the public key the client just sent.
    const sessionKey = new Uint8Array(64).map((_, i) => i);

    const { fn, calls } = mockFetch(async (req) => {
      if (req.method === 'System.Login') {
        const login = (await restorePayload(req.params, PayloadFormat.Encoded)) as { clientPublicKey: string };
        const spki = Uint8Array.from(
          atob(login.clientPublicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')),
          (c) => c.charCodeAt(0),
        );
        const publicKey = await crypto.subtle.importKey(
          'spki',
          spki,
          { name: 'RSA-OAEP', hash: 'SHA-256' },
          false,
          ['encrypt'],
        );
        // The server encrypts the key's Base64 *text*, which is the double encoding the client
        // has to undo.
        const wrapped = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: 'RSA-OAEP' },
            publicKey,
            new TextEncoder().encode(btoa(String.fromCharCode(...sessionKey))),
          ),
        );
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: await buildPayload(
            {
              accessToken: '11111111-2222-3333-4444-555555555555',
              apiEncryptionKey: btoa(String.fromCharCode(...wrapped)),
              expiredAt: '2026-09-04T00:00:00.0000000Z',
            },
            PayloadFormat.Encoded,
            WireTypeNames.LoginResponse,
          ),
        };
      }

      return {
        jsonrpc: '2.0',
        id: req.id,
        result: await buildPayload({}, PayloadFormat.Encrypted, WireTypeNames.GetListResponse, sessionKey, {
          direction: PayloadDirection.Response,
          method: req.method,
        }),
      };
    });

    const client = clientWith(fn);
    const login = await client.system.login('demo', 'secret');

    expect(login.accessToken).toBe('11111111-2222-3333-4444-555555555555');
    expect(client.transport.accessToken).toBe(login.accessToken);
    expect(client.transport.hasEncryptionKey).toBe(true);

    // Login itself goes out Encoded — there is no session key yet, that call is what fetches it.
    expect(calls[0]!.params.format).toBe(PayloadFormat.Encoded);

    // Everything after it encrypts without the caller asking.
    await client.form('Employee').getList();
    expect(calls[1]!.params.format).toBe(PayloadFormat.Encrypted);
  });

  it('refuses a login response without an access token rather than signing in anonymously', async () => {
    const { fn } = mockFetch(async (req) => ({
      jsonrpc: '2.0',
      id: req.id,
      // The wire leaves out an empty Guid, so a missing token is the server saying "no session".
      result: await buildPayload({}, PayloadFormat.Encoded, WireTypeNames.LoginResponse),
    }));

    const client = clientWith(fn);

    await expect(client.system.login('demo', 'secret')).rejects.toThrow(/no access token/);
    expect(client.transport.accessToken).toBeNull();
  });

  it('clears the session on logout even when the call fails', async () => {
    const { fn } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32603, message: 'session already gone' },
    }));

    const client = clientWith(fn);
    client.transport.accessToken = '11111111-2222-3333-4444-555555555555';

    await expect(client.system.logout()).rejects.toThrow();

    // Keeping a token that may already be void only produces confusing errors later.
    expect(client.transport.accessToken).toBeNull();
    expect(client.transport.hasEncryptionKey).toBe(false);
  });

  it('rejects a form connector without a progId', () => {
    const client = clientWith(mockFetch(() => ({})).fn);
    expect(() => client.form('')).toThrow(/progId/);
  });

  it('decodes the tables and data sets it reads, and encodes the one it saves', async () => {
    const table: Contracts.DataTable = {
      tableName: 'Employee',
      columns: [
        { name: 'sys_id', type: 'String', allowNull: false, readOnly: false, maxLength: -1, caption: 'sys_id', defaultValue: null },
        { name: 'ref_no', type: 'Long', allowNull: true, readOnly: false, maxLength: -1, caption: 'ref_no', defaultValue: null },
        { name: 'hired_at', type: 'DateTime', allowNull: true, readOnly: false, maxLength: -1, caption: 'hired_at', defaultValue: null },
      ],
      primaryKeys: ['sys_id'],
      rows: [
        {
          state: 'Unchanged',
          current: { sys_id: 'E001', ref_no: '9007199254740993', hired_at: '2026-03-14T15:09:26.535' },
        },
      ],
    };
    const dataSet: Contracts.DataSet = { dataSetName: 'Employee', tables: [table], relations: [] };

    const { fn, calls } = mockFetch(async (req) => {
      const value = req.method.endsWith('.GetList')
        ? { table }
        : req.method.endsWith('.GetData')
          ? { dataSet }
          : { affectedRows: { Employee: 1 }, dataSet };
      return { jsonrpc: '2.0', id: req.id, result: { format: PayloadFormat.Plain, value } };
    });
    const form = clientWith(fn).form('Employee');

    const list = await form.getList();
    expect(list.table!.rows[0]!.current!['ref_no']).toBe(9007199254740993n);

    const { dataSet: read } = await form.getData({ rowId: 'x' });
    const employee = read!.tables[0]!;
    expect(employee.rows[0]!.current!['hired_at']).toEqual(new Date('2026-03-14T15:09:26.535Z'));

    const edited = setCell(employee, employee.rows[0]!, 'ref_no', 9007199254740995n);
    const saved = await form.save({ dataSet: { ...read!, tables: [edited] } });

    // What went out is the wire form: quoted long, UTC DateTime without a zone, both versions.
    const sent = (await restorePayload(calls[2]!.params, PayloadFormat.Plain)) as Contracts.SaveRequest;
    expect(sent.dataSet!.tables[0]!.rows[0]).toEqual({
      state: 'Modified',
      current: { sys_id: 'E001', ref_no: '9007199254740995', hired_at: '2026-03-14T15:09:26.535' },
      original: { sys_id: 'E001', ref_no: '9007199254740993', hired_at: '2026-03-14T15:09:26.535' },
    });
    expect(saved.affectedRows).toEqual({ Employee: 1 });
    expect(saved.dataSet!.tables[0]!.rows[0]!.current!['ref_no']).toBe(9007199254740993n);
  });

  it("keeps the user's time zone from login and formats a DateTime in it, not the device's", async () => {
    const { fn } = mockFetch(async (req) =>
      req.method === 'System.Login'
        ? {
            jsonrpc: '2.0',
            id: req.id,
            result: await buildPayload(
              {
                accessToken: '11111111-2222-3333-4444-555555555555',
                timeZone: 'Asia/Tokyo',
                culture: 'en-US',
              },
              PayloadFormat.Encoded,
              WireTypeNames.LoginResponse,
            ),
          }
        : { jsonrpc: '2.0', id: req.id, result: { format: PayloadFormat.Plain, value: {} } },
    );
    const client = clientWith(fn);
    const instant = new Date('2026-03-14T15:09:26.535Z');

    expect(client.timeZone).toBe('UTC');

    await client.system.login('demo', 'secret');
    expect(client.timeZone).toBe('Asia/Tokyo');
    expect(client.formatDateTime(instant, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).toBe(
      '00:09',
    );
    // `\s`: newer ICU data puts a narrow no-break space before the day period.
    expect(client.formatDateTime(instant)).toMatch(/^Mar 15, 2026, 12:09:26\sAM$/);

    await client.system.logout();
    expect(client.timeZone).toBe('UTC');
  });
});
