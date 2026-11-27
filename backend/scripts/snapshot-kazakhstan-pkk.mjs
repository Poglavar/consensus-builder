#!/usr/bin/env node
// Saves complete copies of Kazakhstan cadastre (EGKN PKK) district parcel views (egkn:u_view), the
// copies parcels/kazakhstan-pkk-snapshot.js answers from when the live view fails. Pages of 1,000
// parcels ordered by gid are kept in <out-dir>/work/district-<id>/ until a district is complete, then
// merged into <out-dir>/u_view-district-<id>.geojson.gz and the pages deleted. Resumable (saved pages
// are skipped), paced (one request at a time with a gap), and one district's failure never stops the
// others; the exit code is 1 when any district failed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';
import { snapshotFileName } from '../parcels/kazakhstan-pkk-snapshot.js';
import { kazakhstanPkkLayerEndpoint } from '../parcels/kazakhstan-pkk-source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = path.join(HERE, '..', 'parcels', 'certificates', 'sectigo-public-server-authentication-ca-dv-r36.pem');
const PAGE = 1000;
const USAGE = `Usage: node scripts/snapshot-kazakhstan-pkk.mjs --out-dir <dir> --district <id> [--district <id> …] [--gap-ms 3000]

Saves each district's complete parcel view as <dir>/${snapshotFileName('<id>')}.
District ids are features of egkn:districts (Alatau 364, Astana Esil 254, Almaty Almaly 244).`;

function parseArgs(argv) {
    const opts = { districts: [], gapMs: 3000, outDir: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out-dir') opts.outDir = argv[++i];
        else if (arg === '--district') opts.districts.push(Number(argv[++i]));
        else if (arg === '--gap-ms') opts.gapMs = Number(argv[++i]);
        else if (arg === '--help' || arg === '-h') return null;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!opts.outDir || !opts.districts.length || !opts.districts.every(Number.isSafeInteger) || !(opts.gapMs >= 0)) return null;
    return opts;
}

const log = (...args) => console.log(`[${new Date().toISOString()}] [pkk-snapshot]`, ...args);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readPage(fetchJson, districtId, startIndex) {
    const params = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typename: 'egkn:u_view',
        outputFormat: 'application/json', count: String(PAGE), startIndex: String(startIndex), sortBy: 'gid',
        viewparams: `district_id:${districtId}` });
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetchJson(`${kazakhstanPkkLayerEndpoint('egkn:u_view')}?${params}`, {
                headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://map.gov4c.kz/egkn/', Accept: 'application/json' },
                signal: AbortSignal.timeout(300000) });
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } catch (error) {
            if (attempt >= 4) throw error;
            log(`district ${districtId} page at ${startIndex} failed (${error.message}); retry ${attempt} in ${30 * attempt} s`);
            await pause(30000 * attempt);
        }
    }
}

async function snapshotDistrict(fetchJson, districtId, { outDir, gapMs }) {
    const work = path.join(outDir, 'work', `district-${districtId}`);
    fs.mkdirSync(work, { recursive: true });
    const pageFile = index => path.join(work, `page-${String(index).padStart(4, '0')}.json`);
    let total = null, fetched = 0, skipped = 0, savedAt = null;
    const started = Date.now();
    for (let index = 0; total === null || index * PAGE < total; index++) {
        if (fs.existsSync(pageFile(index))) {
            const page = JSON.parse(fs.readFileSync(pageFile(index), 'utf8'));
            total ??= page.numberMatched; savedAt ??= page.timeStamp; skipped++;
            continue;
        }
        const text = await readPage(fetchJson, districtId, index * PAGE);
        const page = JSON.parse(text);
        if (!Number.isSafeInteger(page.numberMatched) || !Array.isArray(page.features)) throw new Error('malformed page');
        total ??= page.numberMatched; savedAt ??= page.timeStamp;
        fs.writeFileSync(`${pageFile(index)}.part`, text);
        fs.renameSync(`${pageFile(index)}.part`, pageFile(index));
        fetched++;
        const pages = Math.ceil(total / PAGE);
        const eta = Math.round((Date.now() - started) / fetched * (pages - index - 1) / 1000);
        log(`district ${districtId}: page ${index + 1}/${pages} · ${Math.min((index + 1) * PAGE, total)}/${total} parcels · ETA ${eta} s`);
        await pause(gapMs);
    }
    if (skipped) log(`district ${districtId}: ${skipped} pages were already saved`);
    // Merge, check completeness, write the copy, then drop the pages.
    const byGid = new Map();
    for (let index = 0; index * PAGE < total; index++) {
        for (const feature of JSON.parse(fs.readFileSync(pageFile(index), 'utf8')).features) byGid.set(feature.properties.gid, feature);
    }
    const withGeometry = [...byGid.values()].filter(feature => feature.geometry).length;
    if (byGid.size !== total || withGeometry !== total) {
        throw new Error(`incomplete: ${byGid.size} distinct parcels, ${withGeometry} with geometry, ${total} reported; pages kept for a rerun`);
    }
    const file = path.join(outDir, snapshotFileName(districtId));
    const collection = { type: 'FeatureCollection', districtId, snapshotDate: savedAt, numberMatched: total, features: [...byGid.values()] };
    fs.writeFileSync(`${file}.part`, zlib.gzipSync(JSON.stringify(collection)));
    fs.renameSync(`${file}.part`, file);
    fs.rmSync(work, { recursive: true, force: true });
    log(`district ${districtId}: saved ${total} parcels (${savedAt}) to ${file}`);
    return total;
}

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); opts = null; }
    if (!opts) { console.log(USAGE); process.exit(process.argv.length > 2 && !process.argv.includes('--help') ? 1 : 0); }
    fs.mkdirSync(opts.outDir, { recursive: true });
    const fetchJson = createHttpsJsonFetch(fs.readFileSync(CA, 'utf8'), { maxBytes: 64 * 1024 * 1024 });
    const failed = [];
    for (const districtId of opts.districts) {
        try { await snapshotDistrict(fetchJson, districtId, opts); }
        catch (error) { failed.push(districtId); log(`district ${districtId} FAILED: ${error.message}`); }
    }
    log(`done: ${opts.districts.length - failed.length} of ${opts.districts.length} districts saved${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    process.exit(failed.length ? 1 : 0);
}

main();
