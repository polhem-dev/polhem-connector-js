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
| DataTable / DataSet (decoding, editing, saving) | ✅ verified against the framework's wire fixtures |
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

// Form data belongs to a company, so enter one before calling a form.
await client.system.enterCompany('DEMO');

const employees = await client.form('Employee').getList({ selectFields: 'sys_id,sys_name' });

await client.system.logout();
```

A filter is a tree of `FilterGroup` and `FilterCondition` nodes, told apart by `kind`. Values inside a
condition are `object`-typed on the server, so mark the ones JavaScript cannot tell apart — an
unmarked decimal would arrive as a string:

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

Marked values travel in the discriminated envelope of the JSON body codec, so they need an Encoded or
Encrypted call, which is what every call is after `login`. A Plain call refuses them: the server binds
a Plain value by its JSON kind alone, so a Guid or a date stays a string there, a number becomes an
integer or a decimal, and there is no way to say otherwise.

Every message type is exported under `Contracts` (`Contracts.GetListRequest`, …), generated from the
framework. An optional member may be absent on the wire, and absent means the .NET default (`0`,
`false`, the first enum member, an empty Guid).

### Tables and data sets

`getList` and `getLookup` return a `table`; `getData`, `getNewData` and `save` return a `dataSet`. Both
arrive decoded. The shape is the server's (`columns`, `primaryKeys`, `rows`, and each row's `state`,
`current` and `original`), and every cell already holds the value its column's type calls for:

| Column type | Cell |
|-------------|------|
| `Decimal`, `Currency` | `string`, digit for digit. A JS number would lose the precision |
| `Long` | `bigint` |
| `Short`, `Integer`, `AutoIncrement` | `number` |
| `Boolean` | `boolean` |
| `DateTime` | `Date`, read as UTC |
| `Date` | `'YYYY-MM-DD'`. A calendar day is not an instant, and as a `Date` it would move by a day in some zones |
| `Guid`, `Time`, `String`, `Text` | `string` |
| `Binary` | `Uint8Array` |

A cell's `null` is the server's `DBNull`; the functions that set a cell also accept `DB_NULL` for it.
Every row carries every column, so a cell is never `undefined`.

The data is plain and read-only. Change it with `setCell`, `addRow` and `deleteRow`, which return a new
table and keep each row's `state` and `original` the way `save` needs them:

```ts
import { addRow, deleteRow, hasChanges, setCell } from '@polhem/connector';

const orders = client.form('Order');
const { dataSet } = await orders.getData({ rowId });
let [master, detail] = dataSet!.tables;

master = setCell(master!, master!.rows[0]!, 'amount', '100.50'); // Unchanged → Modified
detail = addRow(detail!, { item_no: 'A-01', qty: 2 },           // Added, linked to the master
  { master: master.rows[0]!, timeZone: client.timeZone });
detail = deleteRow(detail, detail.rows[0]!);                    // Deleted

const changed = { ...dataSet!, tables: [master, detail] };
if (hasChanges(changed)) await orders.save({ dataSet: changed });
```

| Row state | `setCell` | `deleteRow` |
|-----------|-----------|-------------|
| `Unchanged` | becomes `Modified`; `original` keeps the values it was read with | becomes `Deleted`, keeping only `original` |
| `Modified` | stays `Modified`; `original` does not change | becomes `Deleted`, keeping the values it was read with, not the edited ones |
| `Added` | stays `Added` | is removed: the server has never seen it |
| `Deleted` | throws | throws |

`addRow` seeds a new row the way the framework does. It gives `sys_rowid` a new Guid, which the server
needs, since it keys every row by `sys_rowid` through a unique index. With `master`, it sets
`sys_master_rowid` to that row's `sys_rowid`; the server refuses a detail row whose master is not in
the same save. A column left out of `values` takes the table's default value, or, when the table has
none (a table read by `getData` has none), the empty value of its type: `''`, `0`, `'0'`, `0n`, `false`
or the empty Guid, today in `timeZone` for a `Date` (UTC when it is left out) and now for a `DateTime`.
An `AutoIncrement` column stays `null` for the database to number.

A row is named by the row object, not by its index. Each change returns new row objects, so take the
row from the table the last change returned: a row from before it is no longer in the table, and
passing it throws instead of changing the wrong row. In React that matters when one event updates
the same table twice, since the second `setT(prev => setCell(prev, row, …))` receives a `prev` that
no longer holds `row`. The functions also throw on an unknown column, on a value that does not fit
its column (a `Decimal` takes a string, a `Long` a bigint), and on a change to the `sys_rowid` of a
row the server already has, which it would refuse.

Show a `DateTime` in the signed-in user's time zone, which `login` keeps, not in the device's.
`toLocaleString()` and `getHours()` use the device's zone, so an account set to Tokyo used from a
laptop in Taipei would see Taipei time:

```ts
client.formatDateTime(hiredAt);                         // the user's zone and culture
client.formatDateTime(hiredAt, { dateStyle: 'short' }); // Intl options, the zone fixed
client.timeZone;                                        // 'Asia/Tokyo', for components that take a zone
```

Treat `DateTime` cells as read-only: the server sets them itself when it saves and does not take the
values a client sends.

#### The name `DataTable` in a UI project

PrimeReact (`import { DataTable } from 'primereact/datatable'`) and PrimeVue
(`import DataTable from 'primevue/datatable'`) both name their table component `DataTable`. In a file
that uses one of them, import this package's type under another name:

```ts
import type { DataTable as PolhemDataTable } from '@polhem/connector';
```

The wire shapes stay under `Contracts` (`Contracts.DataTable`, `Contracts.DataSet`), and no connector
method takes or returns them. Code that handles a wire shape itself can use `decodeDataTable`,
`encodeDataTable`, `decodeDataSet` and `encodeDataSet`; `decodeWireValue` decodes a DataTable inside
an `object`-typed member to the same decoded form.

#### Coming from .NET's `System.Data`

The names match the .NET client's, the API does not: here a table is data, and changes go through
functions.

| `System.Data` | `@polhem/connector` |
|---------------|---------------------|
| `table.Rows[0]["amount"] = 100.5m;` | `t = setCell(t, t.rows[0]!, 'amount', '100.5');` |
| `table.Rows.Add(row)` | `t = addRow(t, { … })` |
| `row.Delete()` | `t = deleteRow(t, row)` |
| `row.RowState` | `row.state` |
| `row["amount", DataRowVersion.Original]` | `row.original?.['amount']` |
| `dataSet.HasChanges()` | `hasChanges(dataSet)` |
| `DBNull.Value` | `null` |
| `AcceptChanges()` | none; after a save, read the form again with `getData` |

### Sessions and errors

Before `login` the client sends no `Authorization` header, which the server treats as an anonymous
call; the method's own access declaration decides whether that is enough. After `login` every call
carries `Bearer <access token>`, and `logout` clears the token and the session key.

A server error is thrown as a `JsonRpcError` carrying the JSON-RPC `code` (the values are in
`JsonRpcErrorCode`). When the server has no usable session for a call that needs one (the client
never signed in, or the token expired or was revoked) the error is an `AuthenticationRequiredError`
(code `-32001`). Retrying will not help; sign in again:

```ts
import { AuthenticationRequiredError } from '@polhem/connector';

try {
  await client.form('Employee').getList();
} catch (error) {
  if (error instanceof AuthenticationRequiredError) {
    await client.system.login(userId, password); // replaces the token and the session key
  } else {
    throw error;
  }
}
```

A rejection at the server's HTTP gate (a missing or invalid API key, a malformed `Authorization`
header) is also a `JsonRpcError`, with `httpStatus` set to the status it came with. It is not an
`AuthenticationRequiredError`: signing in again would be refused the same way.

### Encrypted payloads are bound to their call

The HMAC of an encrypted payload also covers which way it travels and the JSON-RPC method of the call
([ADR-003](https://github.com/polhem-dev/polhem-jsonrpc/blob/main/maintainers/adr/adr-003-bind-method-into-payload-hmac.md)
in polhem-jsonrpc), so a captured payload cannot be replayed as another method, nor a result sent back
as the parameters of a call. This needs a server on Polhem.JsonRpc 1.1.0 or later, which is Polhem 1.3.0 or later; an older server
cannot read this client's encrypted calls, nor this client an older server's encrypted results. There
is no fallback to the unbound form, since a client that accepted both could be downgraded.

`PolhemClient` and `JsonRpcTransport` bind every call themselves. Code that uses the lower-level
exports passes the binding explicitly, and an encrypted payload without one is refused:

```ts
import { PayloadDirection, PayloadFormat, buildPayload, restorePayload } from '@polhem/connector';

const params = await buildPayload(request, PayloadFormat.Encrypted, typeName, sessionKey, {
  direction: PayloadDirection.Request,
  method: 'Employee.GetList',
});
// A result is bound to the method of the request it answers.
const result = await restorePayload(response.result, PayloadFormat.Encrypted, sessionKey, {
  direction: PayloadDirection.Response,
  method: 'Employee.GetList',
});
```

`encrypt` and `decrypt` take the binding as their third argument, `associatedData`: the direction byte
(`1` for a request, `2` for a result) followed by the method in UTF-8.

A result must also be in the format its request was sent in (decision 6 of the same ADR). An encrypted
call refuses a plain or encoded result, before decoding anything, since anybody on the way could have
written one; `restorePayload` therefore takes the format it expects as its second argument. A null
result comes back in the request's format too, naming no type and with an empty body, and reads as
`null` only once an encrypted one has passed its HMAC.

A body that starts with the gzip header is decompressed with a limit, `MAX_DECOMPRESSED_LENGTH` (the
default of `GzipPayloadCompressor` in Polhem.JsonRpc.Payload), and refused as soon as its output passes it. Any
other body is read as it is, uncompressed, as the framework reads one; this package still compresses
everything it writes.

### Not supported yet: replay-protection frames

A deployment can require an anti-replay frame inside every Encoded and Encrypted payload
(`PayloadOptions.RequireFrame` of Polhem.JsonRpc.Payload, set with `AddPolhemPayload` in the framework, off by
default). This client does not write or read that frame yet, so against such a deployment its Encoded and Encrypted
calls, `login` included, are rejected with `-32005` (`JsonRpcErrorCode.ReplayRejected`) until frames are supported.
Plain calls are refused too when they reach a method declared with `ApiReplayProtection.UniqueSequence` from a
signed-in session (`-32602`). Leave the switch off for deployments this client talks to.

## Examples

[`examples/`](examples/README.md) has a Node program and a browser page that sign in to the framework's
QuickStart.Server, list a form, and create, change and delete a record with master and detail rows.

## Development

```sh
npm install
npm test          # vitest, offline
npm run typecheck # tsc --noEmit
npm run build     # tsup (JS) + tsc (declarations)
npm run test:wire # fetches the framework's wire fixtures, then verifies the codec against them
npm run contracts:check  # the synced API contract still matches the framework
```

How changes reach `main`, and what to do when the framework's contract moves, is in
[CONTRIBUTING.md](CONTRIBUTING.md).

`npm test` never touches the network: wire compatibility is checked against fixed vectors produced
by the .NET implementation. `npm run test:wire` is the broader check — it downloads the framework's
published wire fixtures and round-trips every value sample, along with the top-level `datatable` and
`dataset` samples, comparing the re-encoded JSON text with the original. Those fixtures are **not
committed here**; a copy would be a second authority for the wire format, and it would drift.

### Testing against a real backend

This repository contains no server. To exercise the connector end to end, start the framework's
quick-start host from the [polhem](https://github.com/polhem-dev/polhem) repository:

```sh
# terminal 1 — in the polhem checkout
dotnet run --project samples/QuickStart.Server

# terminal 2 — here
npm run smoke
```

`npm run smoke` first calls `System.Ping` as a Plain payload, encoded through the JSON codec, and
through the typed `client.system.ping()`. It then checks that an authenticated call before sign-in
fails with `AuthenticationRequiredError`, signs in as the sample's `demo` / `demo` user (the RSA
handshake), reads a form schema over an **encrypted** call, checks that a progId with no schema is
answered with a `UserMessage` error naming it, signs out, and checks that the old token is refused. Environment variables for another host are listed at the top of `scripts/smoke.mjs`.

Note that the unit tests do **not** need a server: wire compatibility is verified against fixed
vectors produced by the .NET implementation, so `npm test` runs offline.

## License

MIT
