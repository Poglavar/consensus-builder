// Minimal dev server for the Canton slice: serves the static frontend AND mounts
// the /canton read endpoints on the same origin (no DB, no full app). Lets you
// open http://localhost:3000/canton.html locally. Not for production.
//
//   set -a; . ../../blockchain/daml/spike/.env; set +a
//   node backend/canton/dev-serve.js

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupCantonRoute } from '../routes/canton.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, '../../frontend');
const port = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json()); // the full app adds this globally; dev-serve needs it for POST
setupCantonRoute(app);
app.use(express.static(frontendDir));

app.listen(port, () => {
  console.log(`Canton dev server: http://localhost:${port}/canton.html  (serving ${frontendDir})`);
});
