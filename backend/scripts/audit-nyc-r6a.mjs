// Bounded, resumable read-only audit of Bed-Stuy R6A candidates against official
// PLUTO and DCP GIS. It records public evidence but never certifies development rights.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { PLUTO_URL, SELECT_FIELDS, normalizePlutoRow } from '../zoning/pluto.js';
import { screenPluto, inputFingerprint, REVIEW_REQUIREMENTS } from '../zoning/eligibility.js';
import { RULE_VERSION } from '../zoning/districts.js';

const { values } = parseArgs({ options: {
    run: { type: 'boolean' }, help: { type: 'boolean' },
    limit: { type: 'string', default: '25' }, output: { type: 'string' },
} });
if (!values.run || values.help) {
    console.log('Usage: node scripts/audit-nyc-r6a.mjs --run --limit 25 --output <directory>\nLimit: 20–50; rerun the same directory to resume an unchanged source snapshot.');
    process.exit(0);
}
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 20 || limit > 50 || !values.output) throw new Error('Provide --limit 20–50 and --output');
const output = path.resolve(values.output);
const GIS_ROOT = 'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/ArcGIS/rest/services';
const layers = ['MAPPLUTO', 'nyzd', 'nyco', 'nysp', 'nylh', 'nycmih'];
const layerUrl = name => `${GIS_ROOT}/${name}/FeatureServer/0`;
const started = Date.now();
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const makeUrl = (base, params) => {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return String(url);
};
async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${new URL(url).origin}${new URL(url).pathname}`);
    const body = await response.json();
    if (body?.error || body?.errorCode || body?.exceededTransferLimit) throw new Error(`Incomplete/failed source response: ${new URL(url).pathname}`);
    return body;
}
async function readJson(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(file, data) {
    await writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
}
async function featureQuery(name, params) {
    const url = makeUrl(`${layerUrl(name)}/query`, { f: 'json', ...params });
    const body = await fetchJson(url);
    if (!Array.isArray(body.features)) throw new Error(`Missing features from ${name}`);
    return { url, features: body.features };
}

await mkdir(output, { recursive: true });
log('Reading source versions and a bounded pool of candidates');
const metadataResults = await Promise.all(layers.map(async name => {
    const url = makeUrl(layerUrl(name), { f: 'json' });
    const metadata = await fetchJson(url);
    if (!Number.isFinite(metadata.editingInfo?.lastEditDate)) throw new Error(`Missing source version for ${name}`);
    return [name, { url, lastEditDate: metadata.editingInfo.lastEditDate, dataLastEditDate: metadata.editingInfo.dataLastEditDate ?? null }];
}));
const metadata = Object.fromEntries(metadataResults);
const plutoMetadata = await fetchJson('https://data.cityofnewyork.us/api/views/64uk-42ks.json');
if (!Number.isFinite(plutoMetadata.rowsUpdatedAt)) throw new Error('PLUTO has no source update timestamp');
const queryUrl = makeUrl(PLUTO_URL, {
    '$select': SELECT_FIELDS.join(','),
    '$where': "zonedist1 = 'R6A' AND cd = '303' AND lotfront >= 18 AND lotfront < 40 AND lotdepth >= 95 AND lotdepth <= 110",
    '$order': 'bbl', '$limit': '2000',
});
const rows = await fetchJson(queryUrl);
if (!Array.isArray(rows) || rows.length >= 2000) throw new Error('Candidate query is malformed or reaches its cap; narrow the query');
const assessed = rows.map(raw => ({ raw, pluto: normalizePlutoRow(raw) })).map(row => ({ ...row, screening: screenPluto(row.pluto) }));
const candidates = assessed.filter(row => row.screening.status === 'candidate');
// Round-robin tax blocks to avoid a pilot containing only one contiguous row.
const byBlock = new Map();
for (const row of candidates) {
    const block = row.pluto.bbl.slice(0, 6);
    if (!byBlock.has(block)) byBlock.set(block, []);
    byBlock.get(block).push(row);
}
const selected = [];
while (selected.length < limit && [...byBlock.values()].some(group => group.length)) {
    for (const group of byBlock.values()) if (group.length && selected.length < limit) selected.push(group.shift());
}
if (selected.length < limit) throw new Error(`Only ${selected.length} candidates satisfy the initial screen; requested ${limit}`);
const identity = { ruleVersion: RULE_VERSION, limit, metadata, plutoRowsUpdatedAt: plutoMetadata.rowsUpdatedAt, queryUrl,
    candidates: selected.map(row => ({ bbl: row.pluto.bbl, inputFingerprint: inputFingerprint(row.pluto) })) };
const manifestPath = path.join(output, 'manifest.json');
const previous = await readJson(manifestPath);
if (previous && previous.snapshotHash !== hash(identity)) throw new Error('Sources, inputs or rules changed; choose a new output directory');
const manifest = previous ?? { purpose: 'Public-data screening; no lot is a reviewed legal entitlement.', fetchedAt: new Date().toISOString(), snapshotHash: hash(identity), ...identity };
await save(manifestPath, manifest);
const issueCounts = {};
for (const row of assessed) for (const issue of row.screening.issues) {
    issueCounts[issue.code] ??= { ...issue, count: 0 };
    issueCounts[issue.code].count++;
}
await save(path.join(output, 'screening.json'), { count: assessed.length, candidates: candidates.length,
    excludedOrIncompleteCount: assessed.length - candidates.length, issueCounts: Object.values(issueCounts) });

const records = [];
for (const [index, row] of selected.entries()) {
    const bbl = row.pluto.bbl;
    const target = path.join(output, `${bbl}.json`);
    const saved = await readJson(target);
    if (saved?.snapshotHash === manifest.snapshotHash && !saved.error) {
        records.push(saved);
        log(`${index + 1}/${limit} ${bbl}: using completed checkpoint`);
        continue;
    }
    try {
        const parcel = await featureQuery('MAPPLUTO', {
            where: `BBL = ${bbl}`, outFields: 'BBL,Version,ZoneDist1,LotArea,LotFront,LotDepth,LotType,IrrLotCode',
            returnGeometry: 'true', outSR: '2263',
        });
        if (parcel.features.length !== 1 || !parcel.features[0].geometry?.rings?.length) throw new Error('Ambiguous or absent MapPLUTO geometry');
        const feature = parcel.features[0];
        const geometry = JSON.stringify({ ...feature.geometry, spatialReference: { wkid: 2263 } });
        const spatial = { geometry, geometryType: 'esriGeometryPolygon', inSR: '2263', spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false' };
        const results = await Promise.allSettled(['nyzd', 'nyco', 'nysp', 'nylh', 'nycmih'].map(async name => [name, await featureQuery(name, spatial)]));
        const errors = results.filter(r => r.status === 'rejected');
        if (errors.length) throw new Error(errors.map(r => r.reason.message).join('; '));
        const intersections = Object.fromEntries(results.map(r => r.value));
        const districts = [...new Set(intersections.nyzd.features.map(f => f.attributes.ZONEDIST))];
        const flags = [];
        if (districts.length !== 1 || districts[0] !== 'R6A') flags.push('Current zoning-map intersections are not exclusively R6A.');
        for (const name of ['nyco', 'nysp', 'nylh', 'nycmih']) if (intersections[name].features.length) flags.push(`${name}: mapped constraint intersects the tax-lot polygon.`);
        if (feature.attributes.Version !== row.pluto.version) flags.push('Socrata and MapPLUTO versions differ.');
        if (feature.attributes.ZoneDist1 !== 'R6A') flags.push('MapPLUTO primary district differs from R6A.');
        // GIS tax polygons and intersection queries are screening evidence only:
        // they do not prove the surveyed zoning lot, legal boundary or corner condition.
        const record = { bbl, address: row.pluto.address, snapshotHash: manifest.snapshotHash,
            fetchedAt: new Date().toISOString(), pluto: row.pluto, rawPluto: row.raw,
            inputFingerprint: inputFingerprint(row.pluto), parcel, intersections, flags,
            publicScreen: flags.length ? 'flagged' : 'no-mapped-conflict-found',
            envelopeStatus: 'needs-review', result: null,
            remainingReview: REVIEW_REQUIREMENTS,
            zolaUrl: `https://zola.planning.nyc.gov/l/lot/${bbl[0]}/${Number(bbl.slice(1, 6))}/${Number(bbl.slice(6))}`,
        };
        await save(target, record); records.push(record);
    } catch (error) {
        const record = { bbl, address: row.pluto.address, snapshotHash: manifest.snapshotHash, error: error.message, envelopeStatus: 'needs-review', result: null };
        await save(target, record); records.push(record);
    }
    const elapsed = (Date.now() - started) / 1000;
    log(`${index + 1}/${limit} ${bbl}: ${records.at(-1).error ? 'FAILED' : records.at(-1).publicScreen}; ETA ${Math.round(elapsed / (index + 1) * (limit - index - 1))}s`);
}
const summary = { purpose: 'Candidate audit, not verified development capacity.', ruleVersion: RULE_VERSION,
    snapshotHash: manifest.snapshotHash, generatedAt: new Date().toISOString(),
    screenedPlutoRecords: assessed.length, plutoCandidates: candidates.length,
    audited: records.length, withoutMappedConflicts: records.filter(r => r.publicScreen === 'no-mapped-conflict-found').length,
    flagged: records.filter(r => r.publicScreen === 'flagged').length,
    failed: records.filter(r => r.error).length, reviewedEnvelopes: 0,
    lots: records.map(r => ({ bbl: r.bbl, address: r.address, publicScreen: r.publicScreen ?? 'failed', flags: r.flags ?? [], error: r.error ?? null, zolaUrl: r.zolaUrl ?? null })),
};
await save(path.join(output, 'summary.json'), summary);
log(JSON.stringify({ audited: summary.audited, withoutMappedConflicts: summary.withoutMappedConflicts, flagged: summary.flagged, failed: summary.failed, reviewedEnvelopes: 0 }));
if (summary.failed) process.exitCode = 1;
