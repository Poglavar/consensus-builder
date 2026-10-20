#!/usr/bin/env node
// Verify live parcel reads, rendering and selection in the actual city app.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) options[process.argv[index].replace(/^--/, '')] = process.argv[index + 1];
for (const key of ['root', 'city', 'source', 'bounds', 'ids', 'output']) if (!options[key]) throw new Error(`Missing --${key}`);
const root = path.resolve(options.root), output = path.resolve(options.output);
const bounds = options.bounds.split(',').map(Number), ids = options.ids.split(',');
if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value)) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]
    || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -90 || bounds[3] > 90 || ids.some(id => !id || /[,\r\n]/.test(id))) throw new Error('Invalid parcel probe');
const require = createRequire(path.join(root, 'backend/package.json'));
const express = require('express');
const { chromium } = createRequire(path.join(root, 'e2e/package.json'))('@playwright/test');
const { createParcelProviderRelayRouter } = await import(pathToFileURL(path.join(root, 'backend/routes/parcel-provider-relay.js')));
const app = express();
app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api/parcel-provider-relay', express.json({ limit: '1mb' }), createParcelProviderRelayRouter());
for (const file of ['carto-config.js', 'rpc-config.js']) app.get(`/${file}`, async (_req, res, next) => {
    try {
        const response = await fetch(`https://urbangametheory.xyz/${file}`, { signal: AbortSignal.timeout(20000) });
        res.status(response.status).type('application/javascript').send(await response.text());
    } catch (error) { next(error); }
});
app.get('/api/*', async (req, res, next) => {
    try {
        const response = await fetch(`https://api.urbangametheory.xyz${req.originalUrl.slice(4)}`, { signal: AbortSignal.timeout(20000) });
        res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(Buffer.from(await response.arrayBuffer()));
    } catch (error) { next(error); }
});
app.all('/api/*', (_req, res) => res.status(405).json({ error: 'App verification permits only reads and the parcel relay.' }));
app.use(express.static(path.join(root, 'frontend')));
app.use((error, _req, res, _next) => res.status(502).json({ error: error.message }));
let server, browser, page;
const errors = [];
const report = { passed: false, city: options.city, source: options.source };
const deadline = setTimeout(() => { browser?.close().catch(() => {}); }, 150000);
try {
    server = await new Promise((resolve, reject) => {
        const instance = http.createServer(app).listen(0, 'localhost', () => resolve(instance));
        instance.once('error', reject);
    });
    const origin = `http://localhost:${server.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    const parameters = new URLSearchParams({ city: options.city, backend: `${origin}/api`, reduceMotion: '1',
        lat: String((bounds[1] + bounds[3]) / 2), lon: String((bounds[0] + bounds[2]) / 2), zoom: '19' });
    await page.goto(`${origin}/?${parameters}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof map !== 'undefined' && typeof map.getZoom === 'function'
        && window.BrowserParcelSources && window.CityConfigManager && window.ParcelPresenter, null, { timeout: 45000 });
    Object.assign(report, await page.evaluate(async ({ city, source, bounds, ids }) => {
        const config = CityConfigManager.getCurrentCityConfig();
        if (CityConfigManager.getCurrentCityId() !== city || config.parcels?.sourceId !== source) throw new Error('City/source binding mismatch');
        map.setView([(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2], 19, { animate: false });
        const read = await BrowserParcelSources.queryBounds(source, bounds, { city });
        if (read.complete !== true || !read.features?.some(feature => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type))) throw new Error('Live browser bounds read has no complete parcel polygons');
        const first = await BrowserParcelSources.queryIds(source, ids, { city });
        const second = await BrowserParcelSources.queryIds(source, ids, { city });
        const exact = result => result.features.map(feature => ({ id: String(feature.id), geometry: feature.geometry })).sort((a, b) => a.id.localeCompare(b.id));
        const a = exact(first), b = exact(second);
        if (first.complete !== true || second.complete !== true || JSON.stringify(a.map(feature => feature.id)) !== JSON.stringify([...ids].sort())
            || JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Exact parcel reads are incomplete or unstable');
        return { boundsCount: read.features.length, exactIdsStable: true };
    }, { city: options.city, source: options.source, bounds, ids }));
    await page.waitForFunction(requested => requested.some(id => !!window.ParcelPresenter?.getLayer?.(id)), ids, { timeout: 60000 });
    const selectedId = await page.evaluate(requested => {
        const id = requested.find(value => !!ParcelPresenter.getLayer(value));
        const layer = ParcelPresenter.getLayer(id);
        if (!layer.feature?.geometry || !map.hasLayer(layer)) throw new Error('Parcel is not rendered on the app map');
        layer.fire('click', { target: layer, latlng: layer.getBounds().getCenter() });
        return id;
    }, ids);
    await page.waitForFunction(id => String(window.selectedParcelId) === id, selectedId, { timeout: 10000 });
    Object.assign(report, { rendered: true, selected: true, selectedParcelId: selectedId });
    if (errors.length) throw new Error(`Uncaught app errors: ${errors.join('; ')}`);
    report.passed = true;
} catch (error) {
    report.error = error.message;
    process.exitCode = 1;
} finally {
    clearTimeout(deadline);
    report.errors = errors;
    await fs.mkdir(path.dirname(output), { recursive: true });
    if (page && !page.isClosed()) await page.screenshot({ path: `${output}.png` }).catch(() => {});
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
console.log(JSON.stringify({ passed: report.passed, city: report.city, source: report.source, count: report.boundsCount, error: report.error }));
