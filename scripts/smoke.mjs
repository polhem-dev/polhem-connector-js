/**
 * Smoke test against a running backend.
 *
 * Not part of `npm test` — it needs a server, and the unit tests are deliberately offline. Run it
 * after starting the framework's quick-start host:
 *
 *   dotnet run --project samples/QuickStart.Server   # in the polhem checkout
 *   npm run smoke
 *
 * The sample signs in `demo` / `demo` without stored credentials. Point the script at another host
 * with `POLHEM_ENDPOINT`, `POLHEM_API_KEY`, `POLHEM_USER`, `POLHEM_PASSWORD` and `POLHEM_PROG_ID`.
 */
import {
  AuthenticationRequiredError,
  JsonRpcTransport,
  PayloadFormat,
  PolhemClient,
  WireTypeNames,
} from '../dist/index.js';

const ENDPOINT = process.env.POLHEM_ENDPOINT ?? 'http://localhost:5050/api';
const API_KEY = process.env.POLHEM_API_KEY ?? 'quickstart-demo';
const USER = process.env.POLHEM_USER ?? 'demo';
const PASSWORD = process.env.POLHEM_PASSWORD ?? 'demo';
const PROG_ID = process.env.POLHEM_PROG_ID ?? 'Staff';

function checkPing(label, result) {
  if (result?.status !== 'ok') {
    throw new Error(`${label}: expected status "ok", got ${JSON.stringify(result)}`);
  }
  console.log(`✓ ${label} — server ${result.version}, traceId ${result.traceId}`);
}

// ---- Anonymous calls: no Authorization header is sent before sign-in. ----

const transport = new JsonRpcTransport({ endpoint: ENDPOINT, apiKey: API_KEY });

checkPing(
  'Plain',
  await transport.execute('System.Ping', { clientName: 'polhem-connector', traceId: 'smoke-plain' }),
);

// The body is JSON produced here, gzipped, and decoded by the server's `json` codec — then answered
// in the same codec.
checkPing(
  'Encoded + codec:json',
  await transport.execute(
    'System.Ping',
    { clientName: 'polhem-connector', traceId: 'smoke-encoded' },
    { format: PayloadFormat.Encoded, typeName: WireTypeNames.PingRequest },
  ),
);

// ---- The typed connector: sign-in, an encrypted call, sign-out. ----

const client = new PolhemClient({ endpoint: ENDPOINT, apiKey: API_KEY });
checkPing('SystemConnector.ping', await client.system.ping());

// An authenticated method before sign-in must come back as the "sign in again" error.
try {
  await client.system.getFormSchema(PROG_ID);
  throw new Error('getFormSchema before sign-in: expected AuthenticationRequiredError, got a result');
} catch (error) {
  if (!(error instanceof AuthenticationRequiredError)) throw error;
  console.log(`✓ Before sign-in — AuthenticationRequiredError (${error.code}): ${error.message}`);
}

const login = await client.system.login(USER, PASSWORD);
if (!client.transport.hasEncryptionKey) {
  throw new Error('login: the response carried no session key, so nothing after it can encrypt');
}
console.log(`✓ login — user ${login.userId ?? USER}, session key installed, expires ${login.expiredAt}`);

// Encrypted by default now: RSA-unwrapped session key, AES-CBC-HMAC both ways.
const schema = await client.system.getFormSchema(PROG_ID);
if (typeof schema.xml !== 'string' || !schema.xml.includes('<FormSchema')) {
  throw new Error(`getFormSchema: expected a FormSchema XML string, got ${JSON.stringify(schema).slice(0, 200)}`);
}
console.log(`✓ Encrypted getFormSchema('${PROG_ID}') — ${schema.xml.length} characters of XML`);

await client.system.logout();

// The server has dropped the session, so the old token must be refused the same way.
const stale = new JsonRpcTransport({ endpoint: ENDPOINT, apiKey: API_KEY });
stale.accessToken = login.accessToken;
try {
  await stale.execute('System.GetFormSchema', { progId: PROG_ID }, { format: PayloadFormat.Encoded, typeName: WireTypeNames.GetFormSchemaRequest });
  throw new Error('call after logout: expected AuthenticationRequiredError, got a result');
} catch (error) {
  if (!(error instanceof AuthenticationRequiredError)) throw error;
  console.log('✓ logout — the old token is refused with AuthenticationRequiredError');
}

console.log('\nAll smoke checks passed.');
