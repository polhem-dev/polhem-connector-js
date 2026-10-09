// @ts-check
/**
 * Serves the browser example, and the package build it imports, on http://localhost:5173.
 *
 *   npm run build
 *   node examples/browser/serve.mjs
 *
 * Only `examples/` and `dist/` are served. The page runs on another origin than the API server
 * (port 5050), so it also shows that cross-origin calls work: QuickStart.Server allows them.
 * Set `PORT` to use another port.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVED = ['examples', 'dist'];
const PORT = Number(process.env.PORT ?? 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  let path;
  try {
    path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  if (path === '/') {
    response.writeHead(302, { location: '/examples/browser/' }).end();
    return;
  }

  const file = normalize(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
  const top = file.slice(ROOT.length).split(sep)[0] ?? '';
  // `normalize` resolves `..`, so a path that left the served folders no longer starts with one of them.
  if (!file.startsWith(ROOT) || !SERVED.includes(top)) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }
  const type = TYPES[/** @type {keyof typeof TYPES} */ (extname(file))] ?? 'application/octet-stream';
  response.writeHead(200, { 'content-type': type });
  createReadStream(file).pipe(response);
}).listen(PORT, () => {
  console.log(`Browser example: http://localhost:${PORT}/examples/browser/`);
});
