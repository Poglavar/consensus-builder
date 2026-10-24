// Serve the real frontend with no caching and test-only button identities for headed coverage.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { frontendRoot, instrumentControls, sourceInventory } from '../helpers/control-source.mjs';
import { mutateControlResponse } from '../helpers/control-mutations.mjs';

const port = Number(process.argv[2] || 63941);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.geojson': 'application/geo+json' };
const cache = new Map();
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store, must-revalidate');
  response.setHeader('X-UI-Control-Coverage', '1');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405); response.end(); return;
  }
  const url = new URL(request.url, `http://localhost:${port}`);
  if (url.pathname === '/__ui-controls') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(sourceInventory())); return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || /^\/(?:proposals|designs|plans|agreements|proposal|parcel|bets|monitors)(?:\/|$)/.test(pathname)) pathname = '/index.html';
  const file = path.resolve(frontendRoot, `.${pathname}`);
  if (!file.startsWith(frontendRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); response.end('Not found'); return;
  }
  const ext = path.extname(file);
  response.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
  if (request.method === 'HEAD') { response.end(); return; }
  if (ext === '.html' || ((ext === '.js' || ext === '.mjs') && file.startsWith(path.join(frontendRoot, 'js') + path.sep))) {
    try {
      const modified = fs.statSync(file).mtimeMs;
      let compiled = cache.get(file);
      if (!compiled || compiled.modified !== modified) {
        compiled = { modified, ...instrumentControls(fs.readFileSync(file, 'utf8'), path.relative(frontendRoot, file)) };
        cache.set(file, compiled);
      }
      response.end(mutateControlResponse(compiled.code, path.relative(frontendRoot, file), process.env.UI_CONTROL_MUTATION));
    } catch (error) {
      console.error(`Cannot instrument ${path.relative(frontendRoot, file)}:`, error);
      response.writeHead(500); response.end(String(error));
    }
    return;
  }
  fs.createReadStream(file).pipe(response);
});
server.listen(port, '127.0.0.1', () => console.log(`Headed UI coverage server: http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
