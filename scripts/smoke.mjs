/**
 * Smoke test against a running backend.
 *
 * Not part of `npm test` — it needs a server, and the unit tests are deliberately offline. Run it
 * after starting the framework's quick-start host:
 *
 *   cd <polhem>/samples/QuickStart.Server && dotnet run
 *   npm run smoke
 *
 * `System.Ping` is used because it is anonymous and its request type is a framework type, so it
 * passes the server's type allow-list without any deployment configuration.
 */
import { PolhemClient, JsonRpcTransport, PayloadFormat } from '../dist/index.js';

const ENDPOINT = process.env.POLHEM_ENDPOINT ?? 'http://localhost:5050/api';
const API_KEY = process.env.POLHEM_API_KEY ?? 'quickstart-demo';
const PING_TYPE = 'Polhem.Api.Core.Messages.System.PingRequest, Polhem.Api.Core';

const transport = new JsonRpcTransport({ endpoint: ENDPOINT, apiKey: API_KEY });

function check(label, result) {
  if (result?.status !== 'ok') {
    throw new Error(`${label}: expected status "ok", got ${JSON.stringify(result)}`);
  }
  console.log(`✓ ${label} — server ${result.version}, traceId ${result.traceId}`);
}

check(
  'Plain',
  await transport.execute('System.Ping', { clientName: 'polhem-connector', traceId: 'smoke-plain' }),
);

// The one that matters: the body is JSON produced here, gzipped, and decoded by the server's
// `json` codec — then answered in the same codec.
check(
  'Encoded + codec:json',
  await transport.execute(
    'System.Ping',
    { clientName: 'polhem-connector', traceId: 'smoke-encoded' },
    { format: PayloadFormat.Encoded, typeName: PING_TYPE },
  ),
);

// The typed connector over the same transport: this is the API a caller actually uses.
const client = new PolhemClient({ endpoint: ENDPOINT, apiKey: API_KEY });
check('SystemConnector.ping', await client.system.ping());

console.log('\nAll smoke checks passed.');
