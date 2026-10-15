#!/usr/bin/env node
// Dedicated read-only Novogradnje server, sharing the archive database without enabling crawl jobs.
import express from 'express';
import { createPool } from '../db/connection.cjs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { setupNovogradnjeRoute } from '../routes/novogradnje.js';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const port = Number(process.env.NOVOGRADNJE_PORT || 8490);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid NOVOGRADNJE_PORT.');
const pool = createPool({ max: 5,
    application_name: 'novogradnje-web', statement_timeout: 20000 });
const app = express();
app.disable('x-powered-by');
setupNovogradnjeRoute(app, pool);
app.use((error, _req, res, _next) => { console.error(new Date().toISOString(), error.message); res.status(503).json({ error: 'Katalog trenutačno nije dostupan.' }); });
const server = app.listen(port, '127.0.0.1', () => console.log(new Date().toISOString(), `Novogradnje listening on port ${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
