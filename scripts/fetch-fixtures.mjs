/**
 * Downloads the wire fixtures published by the framework repository.
 *
 * The fixtures are deliberately NOT committed here. A copy would drift from the source with
 * nothing to catch it — which is the exact failure the fixtures exist to prevent. Fetching them
 * keeps one authority for the wire format.
 *
 * Pinned to `main` for now; this moves to a release tag once the framework cuts one, so a given
 * version of this package states which wire it was verified against.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'polhem-dev/polhem';
const REF = process.env.POLHEM_FIXTURES_REF ?? 'main';
const SOURCE = 'wire-fixtures/bodies';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

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

async function main() {
  const listUrl = `https://api.github.com/repos/${REPO}/contents/${SOURCE}?ref=${REF}`;
  const response = await fetch(listUrl, {
    headers: { ...githubHeaders(), accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`Listing ${SOURCE}@${REF} failed: ${response.status} ${response.statusText}`);
  }

  const entries = await response.json();
  const files = entries.filter((e) => e.type === 'file' && e.name.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No fixtures found at ${SOURCE}@${REF} — has the path moved?`);
  }

  await mkdir(outDir, { recursive: true });
  await Promise.all(
    files.map(async (file) => {
      // Via the contents API rather than `download_url`: that points at the raw CDN, which can
      // serve a stale copy for a while after a push.
      const body = await fetch(`${file.url}`, { headers: githubHeaders() });
      if (!body.ok) throw new Error(`Downloading ${file.name} failed: ${body.status}`);
      await writeFile(join(outDir, file.name), await body.text());
    }),
  );

  await writeFile(
    join(outDir, 'SOURCE.json'),
    `${JSON.stringify({ repo: REPO, ref: REF, path: SOURCE, count: files.length }, null, 2)}\n`,
  );
  console.log(`Fetched ${files.length} fixtures from ${REPO}@${REF}`);
}

await main();
