#!/usr/bin/env node
// Archives complete copies of the Kazakh sources the app reads live, as backups that are not served:
// the national cadastre's (EGKN PKK) district views (parcels `u_view`, free state plots
// `freelands_view`, land applications `reqland_view`) and city ArcGIS parcel layers from the source
// catalog (personal fields left out). Each item's pages are kept in <out-dir>/work/ until it is
// complete, then merged into one .geojson.gz and the pages deleted. Resumable (saved pages and saved
// items are skipped), paced (one request at a time with a gap), and one item's failure never stops the
// others; the exit code is 1 when any item failed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';
import { kazakhstanPkkLayerEndpoint } from '../parcels/kazakhstan-pkk-source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = path.join(HERE, '..', 'parcels', 'certificates', 'sectigo-public-server-authentication-ca-dv-r36.pem');
const CATALOG = path.join(HERE, '..', '..', 'frontend', 'data', 'source-catalog.json');
const PKK_PAGE = 1000;
const PKK_LAYERS = ['u_view', 'freelands_view', 'reqland_view'];
// Fields naming or identifying people (owners, sellers, customers, buyers, IIN/BIN) and free-text
// notes and comments are never archived.
const PERSONAL_FIELD = /^(subject|iin_bin|iin|bin|.*_iin|seller_.*|customer\d*|pokupatel\d*|primech|comment_.*|note_.*|fio|owner.*|applicant.*)$/i;
const withoutPersonalFields = page => ({ ...page, features: page.features.map(feature => ({ ...feature,
    properties: Object.fromEntries(Object.entries(feature.properties || {}).filter(([name]) => !PERSONAL_FIELD.test(name))) })) });
const USAGE = `Usage: node scripts/archive-kazakhstan-sources.mjs --out-dir <dir> [--district <id> …] [--layer u_view]
       [--arcgis <catalog source id> …] [--gap-ms 3000] [--refresh]

  --district <id>   a cadastre district (features of egkn:districts: Alatau 364, Astana Esil 254, …)
  --layer <name>    the cadastre view for every --district: ${PKK_LAYERS.join(', ')} (default u_view)
  --arcgis <id>     an ArcGIS parcel layer from frontend/data/source-catalog.json (e.g. kz-almaty-mapalmaty-gzk)
  --refresh         save items whose copy exists again (default: skip them)

Writes <dir>/<layer>-district-<id>.geojson.gz and <dir>/<source id>.geojson.gz.`;

function parseArgs(argv) {
    const opts = { districts: [], arcgis: [], layer: 'u_view', gapMs: 3000, outDir: null, refresh: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out-dir') opts.outDir = argv[++i];
        else if (arg === '--district') opts.districts.push(Number(argv[++i]));
        else if (arg === '--layer') opts.layer = argv[++i];
        else if (arg === '--arcgis') opts.arcgis.push(argv[++i]);
        else if (arg === '--gap-ms') opts.gapMs = Number(argv[++i]);
        else if (arg === '--refresh') opts.refresh = true;
        else if (arg === '--help' || arg === '-h') return null;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!opts.outDir || !(opts.districts.length || opts.arcgis.length) || !opts.districts.every(Number.isSafeInteger)
        || !PKK_LAYERS.includes(opts.layer) || !(opts.gapMs >= 0)) return null;
    return opts;
}

const log = (...args) => console.log(`[${new Date().toISOString()}] [kz-archive]`, ...args);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readText(fetchJson, url, headers, label) {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetchJson(url, { headers, signal: AbortSignal.timeout(300000) });
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } catch (error) {
            if (attempt >= 4) throw error;
            log(`${label} failed (${error.message}); retry ${attempt} in ${30 * attempt} s`);
            await pause(30000 * attempt);
        }
    }
}

// A cadastre district view, paged by gid. Its capture time is the provider's own timeStamp.
function pkkItem(layer, districtId) {
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://map.gov4c.kz/egkn/', Accept: 'application/json' };
    return {
        name: `${layer} district ${districtId}`,
        file: `${layer}-district-${districtId}.geojson.gz`,
        // u_view's pages keep the folder name the first archive run used, so a restarted run resumes.
        work: layer === 'u_view' ? `district-${districtId}` : `${layer}-district-${districtId}`,
        pageSize: PKK_PAGE,
        idOf: feature => feature.properties.gid,
        async page(fetchJson, index) {
            const params = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typename: `egkn:${layer}`,
                outputFormat: 'application/json', count: String(PKK_PAGE), startIndex: String(index * PKK_PAGE), sortBy: 'gid',
                viewparams: `district_id:${districtId}` });
            const page = JSON.parse(await readText(fetchJson, `${kazakhstanPkkLayerEndpoint(`egkn:${layer}`)}?${params}`, headers, `${layer} ${districtId} page ${index}`));
            if (!Number.isSafeInteger(page.numberMatched) || !Array.isArray(page.features)) throw new Error('malformed page');
            return { text: JSON.stringify(withoutPersonalFields(page)), total: page.numberMatched, savedAt: page.timeStamp };
        },
        meta: { districtId, layer: `egkn:${layer}` }
    };
}

// A catalogued ArcGIS layer, paged by objectid in WGS84, without personal fields, kept as the Esri JSON
// features it serves (not every server offers GeoJSON). It reports no capture time, so the archive
// records when it was fetched (fetchedAt), named as such.
async function arcgisItem(fetchJson, sourceId) {
    const descriptor = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).sources.find(source => source.id === sourceId);
    if (descriptor?.adapter !== 'arcgis') throw new Error(`${sourceId} is not an ArcGIS source in the catalog`);
    const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
    const layer = JSON.parse(await readText(fetchJson, `${descriptor.endpoint}?f=json`, headers, `${sourceId} metadata`));
    const oid = layer.objectIdField || 'objectid';
    const fields = (layer.fields || []).map(field => field.name).filter(name => !PERSONAL_FIELD.test(name));
    const pageSize = Math.min(1000, layer.maxRecordCount || 1000);
    const fetchedAt = new Date().toISOString();
    let total = null;
    return {
        name: sourceId, file: `${sourceId}.geojson.gz`, work: sourceId, pageSize,
        idOf: feature => feature.attributes?.[oid],
        async page(_fetchJson, index) {
            total ??= JSON.parse(await readText(fetchJson, `${descriptor.endpoint}/query?where=1%3D1&returnCountOnly=true&f=json`, headers, `${sourceId} count`)).count;
            const params = new URLSearchParams({ where: '1=1', outFields: fields.join(','), orderByFields: oid, resultOffset: String(index * pageSize),
                resultRecordCount: String(pageSize), outSR: '4326', returnGeometry: 'true', f: 'json' });
            const text = await readText(fetchJson, `${descriptor.endpoint}/query?${params}`, headers, `${sourceId} page ${index}`);
            if (!Array.isArray(JSON.parse(text).features)) throw new Error('malformed page');
            return { text, total, savedAt: fetchedAt };
        },
        meta: { format: 'esri-json', sourceId, endpoint: descriptor.endpoint, fields, fetchedAt }
    };
}

async function archive(fetchJson, item, { outDir, gapMs }) {
    const work = path.join(outDir, 'work', item.work);
    fs.mkdirSync(work, { recursive: true });
    const pageFile = index => path.join(work, `page-${String(index).padStart(4, '0')}.json`);
    let total = null, savedAt = null, fetched = 0, skipped = 0;
    const started = Date.now();
    for (let index = 0; total === null || index * item.pageSize < total; index++) {
        if (fs.existsSync(pageFile(index))) {
            const page = JSON.parse(fs.readFileSync(pageFile(index), 'utf8'));
            total ??= page.numberMatched ?? null; savedAt ??= page.timeStamp ?? null; skipped++;
            if (total !== null) continue;
        }
        const page = await item.page(fetchJson, index);
        total ??= page.total; savedAt ??= page.savedAt;
        if (!fs.existsSync(pageFile(index))) {
            fs.writeFileSync(`${pageFile(index)}.part`, page.text);
            fs.renameSync(`${pageFile(index)}.part`, pageFile(index));
            fetched++;
        }
        const pages = Math.ceil(total / item.pageSize);
        const eta = fetched ? Math.round((Date.now() - started) / fetched * (pages - index - 1) / 1000) : 0;
        log(`${item.name}: page ${index + 1}/${pages} · ${Math.min((index + 1) * item.pageSize, total)}/${total} · ETA ${eta} s`);
        await pause(gapMs);
    }
    if (skipped) log(`${item.name}: ${skipped} pages were already saved`);
    // Merge, check completeness, write the copy, then drop the pages.
    const byId = new Map();
    for (let index = 0; index * item.pageSize < total; index++) {
        for (const feature of JSON.parse(fs.readFileSync(pageFile(index), 'utf8')).features) byId.set(item.idOf(feature), feature);
    }
    const withGeometry = [...byId.values()].filter(feature => feature.geometry).length;
    if (byId.size !== total) throw new Error(`incomplete: ${byId.size} distinct features, ${total} reported; pages kept for a rerun`);
    const file = path.join(outDir, item.file);
    const collection = { ...(item.meta.format ? {} : { type: 'FeatureCollection' }), ...item.meta, snapshotDate: savedAt, numberMatched: total, withGeometry, features: [...byId.values()] };
    fs.writeFileSync(`${file}.part`, zlib.gzipSync(JSON.stringify(collection)));
    fs.renameSync(`${file}.part`, file);
    fs.rmSync(work, { recursive: true, force: true });
    log(`${item.name}: saved ${total} features (${withGeometry} with geometry, ${savedAt}) to ${file}`);
}

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); opts = null; }
    if (!opts) { console.log(USAGE); process.exit(process.argv.length > 2 && !process.argv.includes('--help') ? 1 : 0); }
    fs.mkdirSync(opts.outDir, { recursive: true });
    const fetchJson = createHttpsJsonFetch(fs.readFileSync(CA, 'utf8'), { maxBytes: 64 * 1024 * 1024 });
    const jobs = [...opts.districts.map(id => async () => pkkItem(opts.layer, id)), ...opts.arcgis.map(id => () => arcgisItem(fetchJson, id))];
    const failed = [];
    let saved = 0;
    for (const [index, job] of jobs.entries()) {
        const label = index < opts.districts.length ? `${opts.layer} district ${opts.districts[index]}` : opts.arcgis[index - opts.districts.length];
        try {
            const item = await job();
            if (!opts.refresh && fs.existsSync(path.join(opts.outDir, item.file))) { log(`${item.name}: copy already saved, skipped (--refresh to save it again)`); continue; }
            await archive(fetchJson, item, opts);
            saved++;
        } catch (error) { failed.push(label); log(`${label} FAILED: ${error.message}`); }
    }
    log(`done: ${saved} saved, ${jobs.length - saved - failed.length} already saved, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
    process.exit(failed.length ? 1 : 0);
}

main();
