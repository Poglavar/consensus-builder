#!/usr/bin/env node
// Build a cadastre general plan's exact backend snapshot and simplified browser overview together.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { bbox, coordReduce, simplify } from '@turf/turf';
import { createHttpsJsonFetch } from '../parcels/https-json-fetch.js';
import { validateGeometry } from '../parcels/source-contract.js';
import { alatauGenplanSource, interpretZone } from '../planning/providers/alatau-genplan.js';
import { astanaGenplanSource, interpretAstanaZone } from '../planning/providers/astana-genplan.js';
import { almatyDetailedPlanSource, interpretAlmatyDetailedZone } from '../planning/providers/almaty-detailed-plan.js';

const [sourceId, input] = process.argv.slice(2);
const sources = new Map([
    [alatauGenplanSource.id, { descriptor: alatauGenplanSource, interpret: interpretZone }],
    [astanaGenplanSource.id, { descriptor: astanaGenplanSource, interpret: interpretAstanaZone }],
    [almatyDetailedPlanSource.id, { descriptor: almatyDetailedPlanSource, interpret: interpretAlmatyDetailedZone }]
]);
const source = sources.get(sourceId);
if (!source || !input) throw new Error('Pass a source ID followed by a complete WFS FeatureCollection file or --fetch.');
const { descriptor, interpret } = source;
if (input === '--fetch' && descriptor.kind === 'reference') throw new Error('Rebuild a dated reference from its captured FeatureCollection.');
const snapshotDir = new URL('../planning/data/', import.meta.url);
const overviewDir = new URL('../../frontend/data/planning/', import.meta.url);
const snapshotFile = new URL(descriptor.snapshotFilename, snapshotDir);
const overviewFile = new URL(`${sourceId}-overview.json`, overviewDir);

async function fetchAllZones() {
    const certificate = readFileSync(new URL('../parcels/certificates/sectigo-public-server-authentication-ca-dv-r36.pem', import.meta.url), 'utf8');
    const fetchPage = createHttpsJsonFetch(certificate, { maxBytes: 32 * 1024 * 1024 });
    const filter = '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0"><fes:PropertyIsEqualTo>'
        + '<fes:ValueReference>admterr_id</fes:ValueReference>'
        + `<fes:Literal>${descriptor.admterrId}</fes:Literal></fes:PropertyIsEqualTo></fes:Filter>`;
    const features = [];
    let numberMatched;
    do {
        const url = new URL(descriptor.service);
        url.search = new URLSearchParams({
            service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: descriptor.layer,
            outputFormat: 'application/json', sortBy: 'object_id_i32', FILTER: filter,
            count: '1000', startIndex: String(features.length)
        });
        const response = await fetchPage(url.href, {
            headers: { Accept: 'application/json', Referer: 'https://map.gov4c.kz/egkn/' },
            signal: AbortSignal.timeout(25000)
        });
        if (!response.ok) throw new Error(`WFS HTTP ${response.status}`);
        const page = await response.json();
        const matched = Number(page.numberMatched ?? page.totalFeatures);
        numberMatched ??= matched;
        if (page.type !== 'FeatureCollection' || !Array.isArray(page.features) || !page.features.length
            || !Number.isSafeInteger(matched) || matched !== numberMatched || matched > 20000
            || features.length + page.features.length > matched) throw new Error('Incomplete WFS response.');
        features.push(...page.features);
        console.log(`Read ${features.length}/${numberMatched} zones`);
    } while (features.length < numberMatched);
    return { type: 'FeatureCollection', numberMatched, features };
}

function validateSource(source) {
    const matched = Number(source.numberMatched ?? source.totalFeatures);
    if (source.type !== 'FeatureCollection' || !Array.isArray(source.features) || !source.features.length
        || matched !== source.features.length) throw new Error('Expected a complete FeatureCollection with its WFS match count.');
    const ids = new Set();
    for (const feature of source.features) {
        const id = feature.properties?.object_id_i32;
        if (feature.type !== 'Feature' || !Number.isSafeInteger(id) || id < 0 || ids.has(id)
            || String(feature.properties.admterr_id) !== descriptor.admterrId || !validateGeometry(feature.geometry)) {
            throw new Error(`Invalid or duplicate zone ${id} for ${descriptor.id}`);
        }
        ids.add(id);
    }
    return source.features.toSorted((a, b) => a.properties.object_id_i32 - b.properties.object_id_i32);
}

function overviewGeometry(feature) {
    // The 2D overview stops at zoom 15. Simplify at roughly 10 m, then round to roughly 1 m.
    const simplified = simplify(feature, { tolerance: 0.0001, highQuality: true });
    const rounded = coords => Array.isArray(coords[0]) ? coords.map(rounded) : coords.map(n => Math.round(n * 1e5) / 1e5);
    const geometry = { type: simplified.geometry.type, coordinates: rounded(simplified.geometry.coordinates) };
    if (!validateGeometry(geometry)) throw new Error(`Invalid overview geometry for ${feature.properties.object_id_i32}`);
    return geometry;
}

function buildOverview(collection) {
    const uses = [], useIndexes = new Map();
    const zones = collection.features.map(feature => {
        const reading = interpret(feature.properties);
        const use = { key: reading.useKey, group: reading.useGroup, label: reading.use, stage: reading.stage, status: reading.status,
            ...(reading.landBasis ? { landBasis: reading.landBasis } : {}) };
        const key = JSON.stringify(use);
        if (!useIndexes.has(key)) {
            useIndexes.set(key, uses.length);
            uses.push(use);
        }
        return [String(feature.properties.object_id_i32), useIndexes.get(key), overviewGeometry(feature)];
    });
    return { sourceId, bbox: bbox(collection), uses, zones };
}

function writeAsset(file, bytes) {
    const temporary = new URL(`.${file.pathname.split('/').at(-1)}.${process.pid}.tmp`, file);
    writeFileSync(temporary, bytes);
    renameSync(temporary, file);
}

const data = input === '--fetch' ? await fetchAllZones() : JSON.parse(readFileSync(input, 'utf8'));
const features = validateSource(data).map(feature => ({
    type: 'Feature', id: feature.properties.object_id_i32, properties: feature.properties, geometry: feature.geometry
}));
const collection = { type: 'FeatureCollection', source: sourceId, numberMatched: features.length, features };
const overview = buildOverview(collection);
const exact = Buffer.from(JSON.stringify(collection));
const simplified = Buffer.from(JSON.stringify(overview));
const packed = gzipSync(exact, { level: 9 });
mkdirSync(snapshotDir, { recursive: true });
mkdirSync(overviewDir, { recursive: true });
writeAsset(snapshotFile, packed);
writeAsset(overviewFile, simplified);
const countPositions = geometry => coordReduce(geometry, count => count + 1, 0);
console.log(JSON.stringify({
    zones: features.length, bbox: overview.bbox,
    positions: countPositions(collection),
    overviewPositions: overview.zones.reduce((total, [, , geometry]) => total + countPositions(geometry), 0),
    exactBytes: exact.length, exactGzipBytes: packed.length,
    overviewBytes: simplified.length, overviewGzipBytes: gzipSync(simplified, { level: 9 }).length
}, null, 2));
