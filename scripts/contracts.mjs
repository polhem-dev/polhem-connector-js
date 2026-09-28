/**
 * Syncs the generated API contract from the framework repository.
 *
 * Unlike the wire fixtures, the contract **is** committed here: it is an input to the build, not
 * just to the tests, and a package that cannot compile offline is a worse trade than a checked-in
 * derivative. What keeps it honest is `--check`, which CI runs on every build — a drifted contract
 * fails there rather than silently describing an API the server no longer has.
 *
 *   node scripts/contracts.mjs           # update the committed copy
 *   node scripts/contracts.mjs --check   # fail if it differs from the source
 *
 * The framework ref comes from `framework-ref.mjs`; `POLHEM_CONTRACTS_REF` overrides it for a
 * one-off run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_REF } from './framework-ref.mjs';

const REPO = 'polhem-dev/polhem';
const REF = process.env.POLHEM_CONTRACTS_REF ?? FRAMEWORK_REF;

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'contracts');

/** Source path in the framework repository → local file. */
const FILES = [
  { source: 'wire-contracts/messages.d.ts', target: join(outDir, 'messages.ts') },
  { source: 'wire-contracts/type-names.ts', target: join(outDir, 'type-names.ts') },
];

const header = (source) => `// Synced from ${REPO}/${source} — do not edit by hand.
// Update with \`npm run contracts:update\`; CI fails if this file drifts from the source.

`;

/**
 * Headers for the GitHub contents API.
 *
 * WARNING: authenticate in CI. Unauthenticated requests are limited to 60 per hour **per IP**, and
 * a matrix build blows through that — each job fetches every fixture separately, from the same
 * runner IP. The symptom is a 403 on an arbitrary file in whichever job runs second, which reads
 * like a flaky download rather than a rate limit. `GITHUB_TOKEN` is injected by the workflow.
 */
function githubHeaders() {
  const headers = { accept: 'application/vnd.github.raw', 'cache-control': 'no-cache' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchContract(SOURCE) {
  // WARNING: not raw.githubusercontent.com. That is served through a CDN which can hand back a
  // stale copy for a while after a push — long enough for `--check` to compare against the
  // previous contract and report a match that is not true. The contents API returns the blob for
  // the ref directly.
  const url = `https://api.github.com/repos/${REPO}/contents/${SOURCE}?ref=${REF}`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`Fetching ${SOURCE}@${REF} failed: ${response.status} ${response.statusText}`);
  }
  return header(SOURCE) + (await response.text());
}

const checking = process.argv.includes('--check');
let drifted = 0;

for (const { source, target } of FILES) {
  const expected = await fetchContract(source);

  if (!checking) {
    await writeFile(target, expected);
    console.log(`Updated ${target} from ${REPO}@${REF}.`);
    continue;
  }

  const actual = await readFile(target, 'utf8').catch(() => null);
  if (actual !== expected) {
    console.error(`${source} differs from ${REPO}@${REF}.`);
    drifted++;
  }
}

if (checking) {
  if (drifted > 0) {
    console.error(
      '\nThe API contract moved. Run `npm run contracts:update`, read the diff — a renamed or ' +
        'removed property, or a moved namespace, is a breaking change for this package — then ' +
        'commit it.',
    );
    process.exit(1);
  }
  console.log(`Contracts match ${REPO}@${REF}.`);
}
