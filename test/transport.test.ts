import { describe, expect, it, vi } from 'vitest';
import { JsonRpcTransport } from '../src/transport/client.js';
import {
  JsonRpcError,
  PayloadFormat,
  buildPayload,
  restorePayload,
  type ApiPayload,
  type JsonRpcRequest,
} from '../src/transport/envelope.js';
import { fromBase64 } from '../src/crypto/bytes.js';
import { wire } from '../src/codec/wire-value.js';

const ENDPOINT = 'https://example.test/api';
const API_KEY = 'test-key';

const sessionKey = new Uint8Array(64).map((_, i) => i);

/** A fetch stand-in that records the request and answers with a payload the caller supplies. */
function mockFetch(reply: (request: JsonRpcRequest) => unknown) {
  const calls: { request: JsonRpcRequest; init: RequestInit }[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string) as JsonRpcRequest;
    calls.push({ request, init: init! });
    return new Response(JSON.stringify(await reply(request)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function transport(fetchImpl: typeof fetch) {
  return new JsonRpcTransport({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: fetchImpl });
}

describe('JSON-RPC transport', () => {
  it('sends a Plain payload with no codec or type, matching what the server expects', async () => {
    const { fn, calls } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: { format: PayloadFormat.Plain, value: { status: 'ok' } },
    }));

    const result = await transport(fn).execute<{ status: string }>('System.Ping', {
      clientName: 'test',
    });

    expect(result.status).toBe('ok');
    const { params } = calls[0]!.request;
    expect(params.format).toBe(0);
    expect(params.codec).toBeUndefined();
    expect(params.type).toBeUndefined();
    expect(params.value).toEqual({ clientName: 'test' });
  });

  it('names the json codec and the type on an encoded payload', async () => {
    const { fn, calls } = mockFetch(async (req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: await buildPayload({ ok: true }, PayloadFormat.Encoded, 'Some.Response, Some.Asm'),
    }));

    await transport(fn).execute('Employee.GetList', { selectFields: 'sys_id' }, {
      format: PayloadFormat.Encoded,
      typeName: 'Polhem.Api.Core.Messages.Form.GetListRequest, Polhem.Api.Core',
    });

    const { params } = calls[0]!.request;
    expect(params.format).toBe(1);
    expect(params.codec).toBe('json');
    expect(params.type).toBe('Polhem.Api.Core.Messages.Form.GetListRequest, Polhem.Api.Core');
    expect(typeof params.value).toBe('string');
    // Base64 of gzip: the header bytes are recognisable, which confirms the order of the pipeline.
    expect(fromBase64(params.value as string).subarray(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
  });

  it('encrypts once a session key is installed, and reads the answer back', async () => {
    const { fn, calls } = mockFetch(async (req) => {
      // Stand in for the server: decode the request with the same key, then answer in kind.
      const received = await restorePayload(req.params, sessionKey);
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: await buildPayload(
          { echoed: received },
          PayloadFormat.Encrypted,
          'Some.Response, Some.Asm',
          sessionKey,
        ),
      };
    });

    const client = transport(fn);
    client.setEncryptionKey(sessionKey);

    const result = await client.execute<{ echoed: { amount: unknown } }>(
      'Employee.GetList',
      { amount: wire.decimal('12.50') },
      { typeName: 'Some.Request, Some.Asm' },
    );

    // The marked value survived the round trip as its envelope, not as a plain string.
    expect(result.echoed.amount).toEqual([12, '12.50']);
    expect(calls[0]!.request.params.format).toBe(2);
    expect(calls[0]!.request.params.codec).toBe('json');
  });

  it('sends the API key and a Bearer header, using an empty GUID before login', async () => {
    const { fn, calls } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: { format: PayloadFormat.Plain, value: null },
    }));

    const client = transport(fn);
    await client.execute('System.Ping', {});

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(API_KEY);
    expect(headers['Authorization']).toBe('Bearer 00000000-0000-0000-0000-000000000000');

    client.accessToken = '11111111-2222-3333-4444-555555555555';
    await client.execute('System.Logout', {});
    const second = calls[1]!.init.headers as Record<string, string>;
    expect(second['Authorization']).toBe('Bearer 11111111-2222-3333-4444-555555555555');
  });

  it('surfaces a JSON-RPC error as an exception carrying its code', async () => {
    const { fn } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32005, message: 'The request timestamp is outside the accepted window.' },
    }));

    await expect(transport(fn).execute('System.Ping', {})).rejects.toThrow(JsonRpcError);
    await expect(transport(fn).execute('System.Ping', {})).rejects.toMatchObject({ code: -32005 });
  });

  it('refuses a response encoded with a codec it cannot read', async () => {
    const payload: ApiPayload = {
      format: PayloadFormat.Encoded,
      codec: 'messagepack',
      type: 'Some.Type, Some.Asm',
      value: 'AAAA',
    };

    await expect(restorePayload(payload)).rejects.toThrow(/messagepack/);
  });

  it('refuses to encode without the pieces the server requires', async () => {
    await expect(buildPayload({}, PayloadFormat.Encoded)).rejects.toThrow(/name its type/);
    await expect(buildPayload({}, PayloadFormat.Encrypted, 'T, A')).rejects.toThrow(/key is required/);
  });

  it('reports an HTTP failure with the status and body', async () => {
    const fn = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;

    await expect(transport(fn).execute('System.Ping', {})).rejects.toThrow(/HTTP 401/);
  });
});
