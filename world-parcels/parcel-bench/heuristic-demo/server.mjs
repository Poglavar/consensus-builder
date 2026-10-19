// Serve only demo assets and the prepared, credential-free data bundle on a loopback preview port.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.md': 'text/plain' };
export function createDemoServer({ dataDir = resolve(here, '../output/heuristic-demo-v1') } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/shared/viewer.mjs') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(req.method === 'HEAD' ? undefined : await readFile(resolve(here, '../annotation-app/public/viewer.mjs'))); return;
      }
      const data = path.startsWith('/data/'), root = data ? dataDir : resolve(here, 'public');
      path = data ? path.slice(6) : path === '/' ? 'index.html' : path.slice(1);
      if (path.split('/').some(p => p.startsWith('.') || p === 'cache')) { res.writeHead(404); res.end(); return; }
      const file = resolve(root, path);
      if (!file.startsWith(resolve(root) + sep) || !(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', `${types[extname(file)] || 'application/octet-stream'}${['.html', '.mjs', '.js', '.css', '.json'].includes(extname(file)) ? '; charset=utf-8' : ''}`);
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 400); res.end('Demo asset unavailable'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DEMO_PORT || 8793);
  createDemoServer().listen(port, '127.0.0.1', () => console.log(`Autokatastar demo: http://localhost:${port}`));
}
