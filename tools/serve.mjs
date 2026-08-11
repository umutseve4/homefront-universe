// Minimal static file server so the bundle can be opened in a browser without
// installing anything. Node's built-in http module only; no dependencies.
//
//   node tools/serve.mjs            -> http://127.0.0.1:8080/dist/homefront.html
//   node tools/serve.mjs 3000       -> same on port 3000
//
// This exists because `file://` origins block some browser features and make
// debugging confusing. It is a development convenience, not a production server.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// Resolve a URL path to a file inside ROOT, or null if it escapes ROOT.
export function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(ROOT, `.${clean.startsWith('/') ? '' : '/'}${clean}`);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

export function contentType(file) {
  return TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
}

const port = Number(process.argv[2] || 8080);

const server = createServer(async (req, res) => {
  const target = req.url === '/' ? '/dist/homefront.html' : req.url;
  const file = safePath(target);
  if (!file) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': contentType(file),
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// Only listen when run directly, so the helpers above stay unit-testable.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`serving ${ROOT}`);
    console.log(`open http://127.0.0.1:${port}/dist/homefront.html`);
  });
}
