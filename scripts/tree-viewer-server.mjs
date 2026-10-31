// Serve the standalone viewer and proxy only bounded public Zrinjevac tree queries.
// Run: node scripts/tree-viewer-server.mjs --port 8097
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseBbox, readTrees } from '../frontend/js/tree-viewer-data.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (!process.argv.includes('--port') || !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.log('Usage: node scripts/tree-viewer-server.mjs --port <1024–65535>');
  process.exit(process.argv.includes('--help') ? 0 : 1);
}
const root = new URL('../frontend/', import.meta.url);
const assets = new Map([
  ['/trees.html', 'text/html'], ['/css/tree-viewer.css', 'text/css'], ['/css/primitives.css', 'text/css'],
  ['/js/tree-viewer.mjs', 'text/javascript'], ['/js/tree-viewer-data.mjs', 'text/javascript'],
  ['/js/ui/busy-control.js', 'text/javascript'], ['/vendor/leaflet-1.9.4/leaflet.js', 'text/javascript'],
  ['/vendor/leaflet-1.9.4/leaflet.css', 'text/css']
]);
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  try {
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, JSON.stringify({ error: 'Read-only viewer.' }));
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/tree-api/trees') {
      let bbox;
      try { bbox = parseBbox(url.searchParams.get('bbox')); }
      catch (error) { return send(400, JSON.stringify({ error: error.message })); }
      const upstream = new URL('https://gis.zrinjevac.hr/stabla_geom.php');
      upstream.searchParams.set('bbox', bbox.join(','));
      upstream.searchParams.set('srid', '4326');
      const response = await fetch(upstream, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`Zrinjevac returned HTTP ${response.status}.`);
      const data = await response.json();
      readTrees(data);
      return send(200, JSON.stringify(data));
    }
    const path = url.pathname === '/' ? '/trees.html' : url.pathname;
    if (!assets.has(path)) return send(404, JSON.stringify({ error: 'Not found.' }));
    send(200, await readFile(fileURLToPath(new URL(path.slice(1), root))), assets.get(path));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${error.message}`);
    send(502, JSON.stringify({ error: 'Could not load the Zrinjevac tree service. Please retry.' }));
  }
});
server.listen(port, 'localhost', () => console.log(`Tree viewer: http://localhost:${port}/trees.html?backend=http%3A%2F%2Flocalhost%3A${port}%2Ftree-api&city=zagreb&at=45.8007523,15.9873677&zoom=18`));
