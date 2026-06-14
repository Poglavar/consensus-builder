// Minimal dev server for the Canton slice: serves the static frontend AND mounts
// the /canton routes on the same origin (no DB, no full app). Lets you open the
// Canton UI locally without Docker. Not for production.
//
//   set -a; . ../../blockchain/daml/spike/.env; set +a
//   node backend/canton/dev-serve.js            # picks a free port (prints the URL)
//   PORT=4123 node backend/canton/dev-serve.js  # or pin one
//
// Port 3000 is the project's API in dev, so by default we DON'T use it — PORT=0
// lets the OS pick any free port, which we print on startup.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupCantonRoute } from '../routes/canton.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, '../../frontend');
const port = Number(process.env.PORT || 0); // 0 = OS-assigned free port

const app = express();
app.use(express.json()); // the full app adds this globally; dev-serve needs it for POST
setupCantonRoute(app);
app.use(express.static(frontendDir));

const server = app.listen(port, () => {
  const p = server.address().port;
  console.log(`Canton dev server ready:`);
  console.log(`  Canton console : http://localhost:${p}/canton.html`);
  console.log(`  Full app (P0)  : http://localhost:${p}/index.html`);
  console.log(`  (serving ${frontendDir})`);
});
