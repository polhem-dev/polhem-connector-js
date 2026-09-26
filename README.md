# @polhem/connector

[繁體中文](https://github.com/polhem-dev/polhem-connector-js/blob/main/README.zh-TW.md)

[![CI](https://github.com/polhem-dev/polhem-connector-js/actions/workflows/ci.yml/badge.svg)](https://github.com/polhem-dev/polhem-connector-js/actions/workflows/ci.yml)

JavaScript/TypeScript connector for the [Polhem](https://github.com/polhem-dev/polhem) JSON-RPC
API, including the **encrypted** payload pipeline.

## Status

**Usable, pre-1.0.** Every layer is implemented and verified against the .NET server — the
cryptographic pipeline against payloads it produced, the codec against its published wire fixtures,
and the whole stack end to end against a running host. The API surface may still change before 1.0.

| Layer | State |
|-------|-------|
| AES-CBC-HMAC, gzip, byte helpers | ✅ implemented, cross-verified against .NET output |
| RSA handshake | ✅ implemented, cross-verified in both directions |
| JSON body codec (wire value envelopes) | ✅ verified against the framework's wire fixtures |
| JSON-RPC transport (envelope, pipeline, HTTP) | ✅ |
| Typed connectors (`login`, `getList`, …) | ✅ |
| API contract types, generated from the framework | ✅ synced, CI-checked |

## Why this exists

The framework's default body codec is MessagePack, assembled from hand-written per-type formatters.
Mirroring those in another language would create a second authority for the same contract with
nothing to catch the two drifting apart. The server therefore accepts a **JSON body codec**, which a
browser client can produce with nothing but platform APIs — and this package is that client.

Everything cryptographic here is Web Crypto: AES-256-CBC, HMAC-SHA256, RSA-OAEP with SHA-256, plus
the platform's own gzip streams. No cryptographic algorithm is reimplemented.

> If your deployment is happy treating HTTPS as the trust boundary, you may not need this package at
> all — the server also accepts plain JSON over HTTPS, which needs no client library. See
> [ADR-014](https://github.com/polhem-dev/polhem/blob/main/docs/adr/adr-014-jsonrpc-plain-public-default.md)
> in the framework repository.

## Requirements

Any runtime with Web Crypto and `CompressionStream`: current browsers, or Node 18+.

## Install

**This package is not published to npm yet.** Build it from source instead:

```sh
git clone https://github.com/polhem-dev/polhem-connector-js.git
cd polhem-connector-js
npm ci
npm run build
npm pack   # prints the tarball name, polhem-connector-<version>.tgz
```

Then install that tarball into your own project:

```sh
npm install /path/to/polhem-connector-js/polhem-connector-<version>.tgz
```

Installing from the Git URL does not currently work: build output is not committed and there is no
`prepare` script, so the installed package would have no `dist`.

The tarball carries the package name `@polhem/connector`, so the imports below resolve to it.

## Usage

```ts
import { PolhemClient } from '@polhem/connector';

const client = new PolhemClient({ endpoint: 'https://host/api', apiKey: '…' });

// Signs in, completes the RSA handshake, and installs the session key.
// Every call after this encrypts without being asked.
await client.system.login('demo', 'secret');

const employees = await client.form('Employee').getList({ selectFields: 'sys_id,sys_name' });

await client.system.logout();
```

Values inside a filter are `object`-typed on the server, so mark the ones JavaScript cannot tell
apart — an unmarked decimal would arrive as a string:

```ts
import { wire } from '@polhem/connector';

await client.form('Employee').getList({
  filter: {
    kind: 'Group',
    operator: 'And',
    nodes: [{ kind: 'Condition', fieldName: 'amount', operator: 'GreaterThan', value: wire.decimal('100') }],
  },
});
```

## Development

```sh
npm install
npm test          # vitest, offline
npm run typecheck # tsc --noEmit
npm run build     # tsup (JS) + tsc (declarations)
npm run test:wire # fetches the framework's wire fixtures, then verifies the codec against them
```

`npm test` never touches the network: wire compatibility is checked against fixed vectors produced
by the .NET implementation. `npm run test:wire` is the broader check — it downloads the framework's
published wire fixtures and round-trips every one of them. Those fixtures are **not committed
here**; a copy would be a second authority for the wire format, and it would drift.

### Testing against a real backend

This repository contains no server. To exercise the connector end to end, start the framework's
quick-start host from the [polhem](https://github.com/polhem-dev/polhem) repository:

```sh
# terminal 1 — in the polhem checkout
cd samples/QuickStart.Server && dotnet run

# terminal 2 — here
npm run smoke
```

`npm run smoke` calls `System.Ping` twice: once as a Plain payload, once encoded through the JSON
codec. The second is the one that matters — the body is produced here, gzipped, decoded by the
server's `json` codec, and answered in the same codec.

Note that the unit tests do **not** need a server: wire compatibility is verified against fixed
vectors produced by the .NET implementation, so `npm test` runs offline.

## License

MIT
