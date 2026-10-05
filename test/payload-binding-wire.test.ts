import { describe, expect, it, vi } from 'vitest';
import { JsonRpcTransport } from '../src/transport/client.js';
import { PayloadDirection, restorePayload, type ApiPayload, type JsonRpcRequest } from '../src/transport/envelope.js';

/**
 * The bytes of the binding, pinned without this package's own definitions.
 *
 * ADR-003 of polhem-dev/polhem-jsonrpc puts `direction byte ‖ method in UTF-8` under the HMAC of an
 * encrypted payload, with 0x01 for a request's parameters and 0x02 for a result. The transport tests
 * name the direction through `PayloadDirection`, and the cross-language vectors in
 * `aes-cbc-hmac.test.ts` hand the encryptor raw bytes, so neither notices if the mapping from "this
 * is a result" to a byte changes. These tests do: the writer's tag is recomputed here with Web
 * Crypto over hard-coded bytes, and the reader opens envelopes the .NET implementation sealed.
 */

const KEY = new Uint8Array(64).map((_, i) => i);
const ENDPOINT = 'https://example.test/api';

const REQUEST_BYTE = 0x01;
const RESPONSE_BYTE = 0x02;

/** A fetch stand-in that records each request and answers with what the scenario returns. */
function mockFetch(reply: (request: JsonRpcRequest) => unknown) {
  const calls: JsonRpcRequest[] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string) as JsonRpcRequest;
    calls.push(request);
    return new Response(JSON.stringify(reply(request)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function encryptedClient(fetchImpl: typeof fetch) {
  const client = new JsonRpcTransport({ endpoint: ENDPOINT, apiKey: 'test-key', fetch: fetchImpl });
  client.setEncryptionKey(KEY);
  return client;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/**
 * Recomputes the tag of an encrypted body over its layout and the binding given here, with the
 * HMAC half of the key, and tells whether it is the tag the body carries.
 */
async function tagMatches(body: Uint8Array<ArrayBuffer>, direction: number, method: string): Promise<boolean> {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const ivLength = view.getInt32(0, true);
  const cipherLength = view.getInt32(4 + ivLength, true);
  const authenticatedLength = 8 + ivLength + cipherLength;
  const tag = body.slice(authenticatedLength);
  expect(tag).toHaveLength(32);

  const methodBytes = new TextEncoder().encode(method);
  const input = new Uint8Array(authenticatedLength + 1 + methodBytes.length);
  input.set(body.subarray(0, authenticatedLength), 0);
  input[authenticatedLength] = direction;
  input.set(methodBytes, authenticatedLength + 1);

  const hmacKey = await crypto.subtle.importKey('raw', KEY.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, input));
  return expected.every((b, i) => b === tag[i]);
}

describe('direction byte and method encoding on the wire', () => {
  describe('writer', () => {
    // The third name is the second one decomposed (U+0308 after U): ADR-003 binds the method with no
    // normalization, so a writer that normalized it would tag other bytes.
    it.each(['Employee.GetList', 'Lager.Übersicht', 'Lager.U\u0308bersicht'])(
      'tags the parameters of %s over 0x01 and the method in UTF-8',
      async (method) => {
        const { fn, calls } = mockFetch((req) => ({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: 'Not answered in this test.' },
        }));

        await expect(encryptedClient(fn).execute(method, { ok: true }, { typeName: 'T, A' })).rejects.toThrow(
          'Not answered in this test.',
        );

        const { params } = calls[0]!;
        expect(params.format).toBe(2);
        const body = base64ToBytes(params.value as string);
        expect(await tagMatches(body, REQUEST_BYTE, method)).toBe(true);
        expect(await tagMatches(body, RESPONSE_BYTE, method)).toBe(false);
      },
    );
  });

  /**
   * Result envelopes sealed by Polhem.JsonRpc.Payload (`PayloadProcessor.SealResponse(method, value,
   * PayloadFormat.Encrypted, "json", key)` with the default gzip compressor, no frame, and the key
   * bytes 0..63), copied here as the server wrote them. The value is
   * `EchoResult("ok", 3, "跨語言")`; the null one is a sealed null result (ADR-003, decision 6).
   */
  const RESULT_VALUE = { status: 'ok', count: 3, note: '跨語言' };

  const DOTNET_RESULT_EMPLOYEE_GETLIST =
    '{"format":2,"value":"EAAAAKuaVu3orkgi+op/jknTemRQAAAAhyUcCDwqihwIKrfPUUZPeWNaUqUBw1tGn+Uz+OjwWwWiKb2Bqtp4LkK5or6nmQvhj6ZlHlmUmmA/lUfPEqxITWrva32TTdTt26pTWSaD8ueuhSGCG4rXs0rtwq34XF4M/HUEE+SM9MBf5A7PSjNIfQ==","type":"ConnectorVector.EchoResult, ConnectorVector","codec":"json"}';
  const DOTNET_RESULT_LAGER_UBERSICHT =
    '{"format":2,"value":"EAAAAHQCLyO/9lwYVG2M3DKzo3FQAAAAcFSPOnIevtgzhKSJNYU65AkH/N9rOPjOo/cg6fIKOef4rid31f5KE/6eBVK72ZsrgHmu8TV/3hpE9U2z9bwjLgrpaZ4lsNC2HOEGqP2eL3HmXlU/82TjwxKCAsikOFgLddwCTXfpB2DVptMewUF/pw==","type":"ConnectorVector.EchoResult, ConnectorVector","codec":"json"}';
  const DOTNET_NULL_RESULT_EMPLOYEE_GETLIST =
    '{"format":2,"value":"EAAAAJJtAr9qyIXxQzN1uaHmT7QQAAAA016EmQbMLNBqYOYnKHXV8nBJf0JxAcTFjbm3NFPX58AEd0DkFuwYYT9SVXMt6ZlS","type":"","codec":"json"}';

  /** Calls `method` against a server that answers with the fixed envelope, whatever was asked. */
  function callAnsweredWith(envelope: string, method: string) {
    const { fn } = mockFetch((req) => ({ jsonrpc: '2.0', id: req.id, result: JSON.parse(envelope) as unknown }));
    return encryptedClient(fn).execute(method, {}, { typeName: 'T, A' });
  }

  const cases = [
    ['Employee.GetList', 'an object', DOTNET_RESULT_EMPLOYEE_GETLIST, RESULT_VALUE],
    ['Lager.Übersicht', 'an object', DOTNET_RESULT_LAGER_UBERSICHT, RESULT_VALUE],
    ['Employee.GetList', 'a sealed null', DOTNET_NULL_RESULT_EMPLOYEE_GETLIST, null],
  ] as const;

  describe('reader, against envelopes sealed by .NET', () => {
    it('carries tags computed over 0x02 and the method in UTF-8', async () => {
      for (const [method, , envelope] of cases) {
        const body = base64ToBytes((JSON.parse(envelope) as ApiPayload).value as string);
        expect(await tagMatches(body, RESPONSE_BYTE, method)).toBe(true);
      }
      const body = base64ToBytes((JSON.parse(DOTNET_RESULT_EMPLOYEE_GETLIST) as ApiPayload).value as string);
      expect(await tagMatches(body, REQUEST_BYTE, 'Employee.GetList')).toBe(false);
    });

    it.each(cases)('reads %s, %s, through the transport', async (method, _kind, envelope, value) => {
      await expect(callAnsweredWith(envelope, method)).resolves.toEqual(value);
    });

    it.each(cases)('refuses %s, %s, as the answer to another method', async (method, _kind, envelope) => {
      const other = method === 'Employee.GetList' ? 'Employee.Delete' : 'Lager.Ubersicht';
      await expect(callAnsweredWith(envelope, other)).rejects.toThrow('HMAC validation failed.');
    });

    it.each(cases)('refuses %s, %s, read in the request direction', async (method, _kind, envelope) => {
      await expect(
        restorePayload(JSON.parse(envelope) as ApiPayload, 2, KEY, { direction: PayloadDirection.Request, method }),
      ).rejects.toThrow('HMAC validation failed.');
    });
  });
});
