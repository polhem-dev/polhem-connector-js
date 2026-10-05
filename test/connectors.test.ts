import { describe, expect, it, vi } from 'vitest';
import { PolhemClient } from '../src/connectors/client.js';
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
});
