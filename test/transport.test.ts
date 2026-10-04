import { describe, expect, it, vi } from 'vitest';
import { JsonRpcTransport } from '../src/transport/client.js';
import {
  AuthenticationRequiredError,
  JsonRpcError,
  JsonRpcErrorCode,
  PayloadDirection,
  PayloadFormat,
  buildPayload,
  restorePayload,
  type ApiPayload,
  type JsonRpcRequest,
  type PayloadBinding,
  type PayloadFormatValue,
} from '../src/transport/envelope.js';
import { encrypt } from '../src/crypto/aes-cbc-hmac.js';
import { concat, fromBase64, toBase64, utf8 } from '../src/crypto/bytes.js';
import { MAX_DECOMPRESSED_LENGTH, gzip } from '../src/crypto/gzip.js';
import { encodeBody } from '../src/codec/json-body.js';
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
      const received = await restorePayload(req.params, PayloadFormat.Encrypted, sessionKey, {
        direction: PayloadDirection.Request,
        method: req.method,
      });
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: await buildPayload(
          { echoed: received },
          PayloadFormat.Encrypted,
          'Some.Response, Some.Asm',
          sessionKey,
          { direction: PayloadDirection.Response, method: req.method },
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

  it('sends no Authorization header before sign-in, and the Bearer token after it', async () => {
    const { fn, calls } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: { format: PayloadFormat.Plain, value: null },
    }));

    const client = transport(fn);
    await client.execute('System.Ping', {});

    // Without a session the call is anonymous, which the server reads from the missing header.
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(API_KEY);
    expect(headers).not.toHaveProperty('Authorization');

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

    await expect(restorePayload(payload, PayloadFormat.Encoded)).rejects.toThrow(/messagepack/);
  });

  it('refuses to encode without the pieces the server requires', async () => {
    await expect(buildPayload({}, PayloadFormat.Encoded)).rejects.toThrow(/name its type/);
    await expect(buildPayload({}, PayloadFormat.Encrypted, 'T, A')).rejects.toThrow(/key is required/);
    await expect(buildPayload({}, PayloadFormat.Encrypted, 'T, A', sessionKey)).rejects.toThrow(
      /bound to its direction and method/,
    );
  });

  it('refuses to encrypt or decrypt with a malformed binding', async () => {
    const bad = [
      { direction: 0, method: 'Employee.GetList' },
      { direction: 3, method: 'Employee.GetList' },
      { direction: PayloadDirection.Request, method: '' },
    ] as unknown as PayloadBinding[];
    const valid = await buildPayload({}, PayloadFormat.Encrypted, 'T, A', sessionKey, {
      direction: PayloadDirection.Request,
      method: 'Employee.GetList',
    });
    for (const binding of bad) {
      await expect(buildPayload({}, PayloadFormat.Encrypted, 'T, A', sessionKey, binding)).rejects.toThrow();
      await expect(restorePayload(valid, PayloadFormat.Encrypted, sessionKey, binding)).rejects.toThrow();
    }
    await expect(restorePayload(valid, PayloadFormat.Encrypted, sessionKey)).rejects.toThrow(/bound to its direction and method/);
  });

  describe('format of a result', () => {
    const METHOD = 'Employee.GetList';
    const response = { direction: PayloadDirection.Response, method: METHOD } as const;

    /** Sends one call in `format` and answers it with whatever `result` builds. */
    async function answer(format: PayloadFormatValue, result: () => unknown) {
      const { fn } = mockFetch(async (req) => ({ jsonrpc: '2.0', id: req.id, result: await result() }));
      const client = transport(fn);
      client.setEncryptionKey(sessionKey);
      return client.execute(METHOD, {}, { format, typeName: 'T, A' });
    }

    /** An encrypted payload whose body is `body` exactly, before encryption. */
    async function sealed(body: Uint8Array<ArrayBuffer>, type: unknown, key = sessionKey, method = METHOD) {
      const ad = concat(Uint8Array.of(PayloadDirection.Response), utf8(method));
      return { format: PayloadFormat.Encrypted, codec: 'json', type, value: toBase64(await encrypt(body, key, ad)) };
    }

    const NO_BYTES = new Uint8Array(0);

    it.each([
      ['a plain result', { format: PayloadFormat.Plain, value: { ok: true } }],
      ['a plain null', { format: PayloadFormat.Plain, value: null }],
      ['a result with no format, which reads as plain', { value: { ok: true } }],
    ])('refuses %s to an encrypted call', async (_name, result) => {
      await expect(answer(PayloadFormat.Encrypted, () => result)).rejects.toThrow(/but format 2 was expected/);
    });

    it('refuses an encoded result to an encrypted call', async () => {
      await expect(
        answer(PayloadFormat.Encrypted, () => buildPayload({ ok: true }, PayloadFormat.Encoded, 'T, A')),
      ).rejects.toThrow(/format 1, but format 2 was expected/);
    });

    it('refuses an encrypted result to an encoded call', async () => {
      await expect(
        answer(PayloadFormat.Encoded, () =>
          buildPayload({ ok: true }, PayloadFormat.Encrypted, 'T, A', sessionKey, response),
        ),
      ).rejects.toThrow(/format 2, but format 1 was expected/);
    });

    it('refuses a plain null to an encoded call', async () => {
      await expect(
        answer(PayloadFormat.Encoded, () => ({ format: PayloadFormat.Plain, value: null })),
      ).rejects.toThrow(/format 0, but format 1 was expected/);
    });

    it('reads a plain result with no format as plain, as the .NET reader does', async () => {
      await expect(answer(PayloadFormat.Plain, () => ({ value: { ok: true } }))).resolves.toEqual({ ok: true });
      await expect(answer(PayloadFormat.Plain, () => ({ format: 0, value: null }))).resolves.toBeNull();
    });

    it.each([['the string "2"', '2'], ['3', 3], ['1.5', 1.5], ['null', null], ['true', true]])(
      'refuses a format of %s',
      async (_name, format) => {
        await expect(
          answer(PayloadFormat.Encrypted, async () => ({ ...(await sealed(NO_BYTES, '')), format })),
        ).rejects.toThrow(/unknown format/);
      },
    );

    it('refuses a null format on a plain call rather than reading it as plain', async () => {
      await expect(answer(PayloadFormat.Plain, () => ({ format: null, value: 1 }))).rejects.toThrow(
        /unknown format/,
      );
    });

    it('refuses an expected format that is not one, without echoing it', async () => {
      // A caller still on the old signature passes the session key where the format now goes.
      const result = await buildPayload({}, PayloadFormat.Encrypted, 'T, A', sessionKey, response);
      const error = await restorePayload(
        result,
        sessionKey as unknown as PayloadFormatValue,
        sessionKey,
        response,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('The expected payload format must be 0, 1 or 2.');
    });

    it.each([['an array', []], ['a string', 'AAAA'], ['a number', 2]])(
      'refuses a result that is %s',
      async (_name, result) => {
        await expect(answer(PayloadFormat.Encrypted, () => result)).rejects.toThrow(/not a JSON object/);
      },
    );

    it('refuses a codec that is not a string, even on a null result', async () => {
      const result = { format: PayloadFormat.Encoded, type: '', codec: 123, value: '' };
      await expect(answer(PayloadFormat.Encoded, () => result)).rejects.toThrow(/codec must be a string/);
    });

    it('refuses a type that is not a string', async () => {
      await expect(answer(PayloadFormat.Encrypted, () => sealed(NO_BYTES, 42))).rejects.toThrow(
        /type must be a string/,
      );
    });

    it.each([['absent', undefined], ['null', null], ['empty', '']])(
      'reads an encrypted null result, with the type %s and a body of zero bytes',
      async (_name, type) => {
        await expect(answer(PayloadFormat.Encrypted, () => sealed(NO_BYTES, type))).resolves.toBeNull();
      },
    );

    it('reads an encrypted null result whose body is gzip of nothing', async () => {
      const empty = await gzip(NO_BYTES);
      await expect(answer(PayloadFormat.Encrypted, () => sealed(empty, ''))).resolves.toBeNull();
    });

    it('reads an encoded null result, with a body of zero bytes or gzip of nothing', async () => {
      const encoded = (body: Uint8Array<ArrayBuffer>) => ({
        format: PayloadFormat.Encoded,
        codec: 'json',
        type: '',
        value: toBase64(body),
      });
      await expect(answer(PayloadFormat.Encoded, () => encoded(NO_BYTES))).resolves.toBeNull();
      const empty = await gzip(NO_BYTES);
      await expect(answer(PayloadFormat.Encoded, () => encoded(empty))).resolves.toBeNull();
    });

    it('reads an encoded null result whatever its codec, as .NET does', async () => {
      const result = { format: PayloadFormat.Encoded, type: '', codec: 'messagepack', value: '' };
      await expect(answer(PayloadFormat.Encoded, () => result)).resolves.toBeNull();
    });

    it('refuses a body that decompresses past the limit, with or without a type', async () => {
      const bomb = toBase64(await gzip(new Uint8Array(MAX_DECOMPRESSED_LENGTH + 1)));
      for (const type of ['T, A', '']) {
        const result = { format: PayloadFormat.Encoded, codec: 'json', type, value: bomb };
        await expect(answer(PayloadFormat.Encoded, () => result)).rejects.toThrow(/decompresses to more than/);
      }
    });

    describe('uncompressed body', () => {
      /** An encoded result whose body is `body` exactly, with no compression. */
      const encoded = (body: Uint8Array<ArrayBuffer>, type = 'T, A') => ({
        format: PayloadFormat.Encoded,
        codec: 'json',
        type,
        value: toBase64(body),
      });

      it('reads an uncompressed encoded result, as the framework reads one', async () => {
        // The body of `PayloadProcessorTests.OpenRequest_UncompressedEncodedBody_Opens` in polhem-jsonrpc.
        const body = utf8('{"clientName":"a","traceId":"b"}');
        await expect(answer(PayloadFormat.Encoded, () => encoded(body))).resolves.toEqual({
          clientName: 'a',
          traceId: 'b',
        });
      });

      it('reads an uncompressed encrypted result', async () => {
        const body = utf8(encodeBody({ ok: true, amount: wire.decimal('12.50') }));
        await expect(answer(PayloadFormat.Encrypted, () => sealed(body, 'T, A'))).resolves.toEqual({
          ok: true,
          amount: [12, '12.50'],
        });
      });

      it('refuses a result with no type whose uncompressed body is not empty', async () => {
        await expect(answer(PayloadFormat.Encoded, () => encoded(utf8('null'), ''))).rejects.toThrow(
          /must have an empty body/,
        );
        await expect(answer(PayloadFormat.Encrypted, () => sealed(utf8('null'), ''))).rejects.toThrow(
          /must have an empty body/,
        );
      });

      it('reads a body that only partly matches the gzip header as uncompressed', async () => {
        // Both go to the codec as they are and fail there as JSON, rather than in gunzip.
        for (const body of [Uint8Array.of(0x1f), Uint8Array.of(0x1f, 0x00, 0x7b, 0x7d)]) {
          await expect(answer(PayloadFormat.Encoded, () => encoded(body))).rejects.toThrow(SyntaxError);
        }
      });

      it('refuses a body that starts with the gzip header but is not valid gzip', async () => {
        const valid = await gzip(utf8(encodeBody({ ok: true })));
        const truncated = valid.slice(0, valid.length - 4);
        const garbage = Uint8Array.of(0x1f, 0x8b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
        for (const body of [truncated, garbage]) {
          await expect(answer(PayloadFormat.Encoded, () => encoded(body))).rejects.toThrow();
          await expect(answer(PayloadFormat.Encrypted, () => sealed(body, 'T, A'))).rejects.toThrow();
          await expect(answer(PayloadFormat.Encoded, () => encoded(body, ''))).rejects.toThrow();
        }
      });
    });

    it('refuses an encrypted null result that does not pass its HMAC', async () => {
      const otherKey = new Uint8Array(64).map((_, i) => 64 - i);
      const random = crypto.getRandomValues(new Uint8Array(96));
      for (const result of [
        { format: PayloadFormat.Encrypted, codec: 'json', type: '', value: toBase64(random) },
        await sealed(NO_BYTES, '', otherKey),
        await sealed(NO_BYTES, '', sessionKey, 'Employee.GetData'),
      ]) {
        await expect(answer(PayloadFormat.Encrypted, () => result)).rejects.toThrow(
          /HMAC validation failed|Invalid/,
        );
      }
    });

    it('refuses a real encrypted result with its type taken away', async () => {
      const result = await buildPayload({ ok: true }, PayloadFormat.Encrypted, 'T, A', sessionKey, response);
      delete result.type;
      await expect(answer(PayloadFormat.Encrypted, () => result)).rejects.toThrow(/must have an empty body/);
    });

    it('refuses an encoded result with no type whose body is not empty', async () => {
      const result = await buildPayload({ ok: true }, PayloadFormat.Encoded, 'T, A');
      result.type = '';
      await expect(answer(PayloadFormat.Encoded, () => result)).rejects.toThrow(/must have an empty body/);
    });
  });

  describe('binding of an encrypted result', () => {
    /** A server that seals its result with the binding the scenario chooses. */
    function serverBinding(binding: (req: JsonRpcRequest) => PayloadBinding) {
      return mockFetch(async (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: await buildPayload({ ok: true }, PayloadFormat.Encrypted, 'T, A', sessionKey, binding(req)),
      }));
    }

    async function call(fetchImpl: typeof fetch) {
      const client = transport(fetchImpl);
      client.setEncryptionKey(sessionKey);
      return client.execute('Employee.GetList', {}, { typeName: 'T, A' });
    }

    it('reads a result bound to the response direction and the method of the call', async () => {
      const { fn } = serverBinding((req) => ({ direction: PayloadDirection.Response, method: req.method }));
      await expect(call(fn)).resolves.toEqual({ ok: true });
    });

    it('refuses a result bound to another method', async () => {
      const { fn } = serverBinding(() => ({ direction: PayloadDirection.Response, method: 'Employee.GetData' }));
      await expect(call(fn)).rejects.toThrow('HMAC validation failed.');
    });

    it('refuses a payload bound to the request direction, such as the call echoed back', async () => {
      const { fn } = serverBinding((req) => ({ direction: PayloadDirection.Request, method: req.method }));
      await expect(call(fn)).rejects.toThrow('HMAC validation failed.');
    });

    it('refuses a result tagged without a binding, and does not retry without one', async () => {
      const { fn, calls } = mockFetch(async (req) => {
        const unbound = await encrypt(await gzip(utf8(encodeBody({ ok: true }))), sessionKey, new Uint8Array(0));
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { format: PayloadFormat.Encrypted, codec: 'json', type: 'T, A', value: toBase64(unbound) },
        };
      });
      await expect(call(fn)).rejects.toThrow('HMAC validation failed.');
      expect(calls).toHaveLength(1);
    });

    it('binds the request parameters to the request direction and the method', async () => {
      const { fn, calls } = serverBinding((req) => ({ direction: PayloadDirection.Response, method: req.method }));
      await call(fn);
      const { params } = calls[0]!.request;

      await expect(
        restorePayload(params, PayloadFormat.Encrypted, sessionKey, { direction: PayloadDirection.Request, method: 'Employee.GetList' }),
      ).resolves.toEqual({});
      await expect(
        restorePayload(params, PayloadFormat.Encrypted, sessionKey, { direction: PayloadDirection.Request, method: 'Employee.Delete' }),
      ).rejects.toThrow('HMAC validation failed.');
      await expect(
        restorePayload(params, PayloadFormat.Encrypted, sessionKey, { direction: PayloadDirection.Response, method: 'Employee.GetList' }),
      ).rejects.toThrow('HMAC validation failed.');
    });
  });

  it('raises AuthenticationRequiredError for -32001, so a caller can tell it to sign in again', async () => {
    const { fn } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: JsonRpcErrorCode.Unauthorized, message: 'The session is invalid or has expired.' },
    }));

    const error = await transport(fn).execute('System.GetFormSchema', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthenticationRequiredError);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).toMatchObject({ code: -32001, httpStatus: undefined });
  });

  it('keeps other error codes as a plain JsonRpcError', async () => {
    const { fn } = mockFetch((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: JsonRpcErrorCode.PermissionDenied, message: 'Permission denied.' },
    }));

    const error = await transport(fn).execute('Employee.GetList', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).not.toBeInstanceOf(AuthenticationRequiredError);
  });

  it('reads the JSON-RPC error out of a rejection at the HTTP gate', async () => {
    const fn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Missing or invalid API key.' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const error = await transport(fn).execute('System.Login', {}).catch((e: unknown) => e);

    // An API key rejection is not a sign-in problem: signing in again would be refused the same way.
    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).not.toBeInstanceOf(AuthenticationRequiredError);
    expect(error).toMatchObject({ code: -32600, httpStatus: 401, message: 'Missing or invalid API key.' });
  });

  it('reports an HTTP failure without a JSON-RPC body with the status and body', async () => {
    const fn = vi.fn(async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;

    await expect(transport(fn).execute('System.Ping', {})).rejects.toThrow(/HTTP 502/);
  });

  it('refuses a marked wire value in a Plain payload', async () => {
    await expect(
      buildPayload(
        { filter: { kind: 'Condition', fieldName: 'amount', value: wire.decimal('1.5') } },
        PayloadFormat.Plain,
      ),
    ).rejects.toThrow(/Plain payload cannot carry a marked wire value/);
  });
});
