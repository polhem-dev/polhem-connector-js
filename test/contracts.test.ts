import { describe, expect, it } from 'vitest';
// Imported through the package entry point on purpose: this is what a consumer sees, so a contract
// that fails to reach the entry point becomes a compile error here rather than a silent gap.
import type { Contracts } from '../src/index.js';

/**
 * Compile-time checks on the synced contract.
 *
 * These assert almost nothing at runtime — their value is that they stop compiling if the contract
 * loses a property or changes its shape. `npm run contracts:check` catches drift from the source;
 * this catches the half that matters to callers, namely whether the shapes they use still exist.
 */
describe('API contract', () => {
  it('describes the login request with the properties the server reads', () => {
    const request: Contracts.LoginRequest = {
      userId: 'demo',
      password: 'secret',
      clientPublicKey: '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n',
    };

    expect(request.userId).toBe('demo');
  });

  it('types the login response with the session pieces the handshake needs', () => {
    const response: Contracts.LoginResponse = {
      accessToken: '11111111-2222-3333-4444-555555555555',
      apiEncryptionKey: 'base64…',
      expiredAt: '2026-09-03T00:00:00.0000000Z',
    };

    // Both are strings on the wire: a Guid and a DateTime have no JSON type of their own.
    expect(typeof response.accessToken).toBe('string');
    expect(typeof response.expiredAt).toBe('string');
  });

  it('types an object-typed member as the discriminated envelope', () => {
    const value: Contracts.WireValueEnvelope = [12, '12.50'];
    expect(value?.[0]).toBe(12);
  });

  it('keeps enum-valued members as string literals, not numbers', () => {
    const ping: Contracts.PingResponse = { status: 'ok', serverTime: '2026-09-03T00:00:00Z', apiKeyStatus: 'Valid' };
    expect(ping.apiKeyStatus).toBe('Valid');
  });
});
