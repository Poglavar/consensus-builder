// Server binding over an explicitly selected parcel source, the HR cadastre included: the source
// finds the candidate parcels (and, where it knows them, the surveyed regions) and the browser's
// own function (site-binding.js bindingFromParcels) decides. The source adapter owns completeness;
// this module refuses to turn a partial provider response into binding evidence. A site larger than
// the source answers in one query is read in tiles (readCandidates), for every source alike.
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';
import { wgs84BboxAreaKm2 } from '../utils/helpers.js';
import { AREA_LIMIT_CODE, areaLimitError } from './source-contract.js';
import { quarters, boxPolygon } from '../buildings/split-read.js';

const require = createRequire(import.meta.url);
const { bindingFromParcels, normalizeTolerance } = require('../../frontend/js/proposals/site-binding.js');
const { snapGeometry } = require('../../frontend/js/geometry-tolerances.js');
const { clipWith } = require('../../frontend/js/proposals/parcel-arrangement.js');
const turf = turfModule.default || turfModule;
// More candidate parcels than this is not a proposal (the same cap as /parcels/under).
export const MAX_SOURCE_BINDING_PARCELS = 5000;

// A site whose box is over the selected source's query limits (its descriptor's maxBboxKm2,
// maxBboxWidthM and maxBboxHeightM, as the adapters' validateBounds checks them) is read in tiles
// within them, TILE_CONCURRENCY at a time. A query the adapter still refuses as over its limit (its
// own default limit where the descriptor declares none, or too many features: AREA_LIMIT_CODE)
// is read in quarters, at most MAX_TILE_DEPTH times over. The binding answers within one request,
// and the API's proxy gives a request 60 s (nginx's default): a query is not started once the
// reading has taken SOURCE_BINDING_TIME_BUDGET_MS, nor past MAX_SOURCE_BINDING_QUERIES queries (a
// backstop on the load we put on the source); either refuses the site as larger than the source
// answers in time.
export const TILE_CONCURRENCY = 4;
export const MAX_TILE_DEPTH = 8;
export const MAX_SOURCE_BINDING_QUERIES = 256;
export const SOURCE_BINDING_TIME_BUDGET_MS = 40_000;
// Tiles are planned at 90 % of the limits, clear of the adapters' rounding.
const TILE_FILL = 0.9;
const METRES_PER_DEGREE = 111320;

// The adapter refused the query as larger than it answers at once: a smaller box answers.
export function isOverQueryLimit(error) {
    return error?.code === AREA_LIMIT_CODE;
}

function queryLimitsOf(limits) {
    const limit = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Infinity);
    return { areaKm2: limit(limits?.maxBboxKm2), widthM: limit(limits?.maxBboxWidthM), heightM: limit(limits?.maxBboxHeightM) };
}

// As validateBounds measures a box.
function withinLimits([w, s, e, n], limits) {
    const widthM = (e - w) * METRES_PER_DEGREE * Math.cos((s + n) / 2 * Math.PI / 180);
    return wgs84BboxAreaKm2(w, s, e, n) <= limits.areaKm2 && widthM <= limits.widthM
        && (n - s) * METRES_PER_DEGREE <= limits.heightM;
}

/**
 * The query boxes for a WGS84 box: the box itself when it is within the limits, else a grid of equal
 * tiles each within TILE_FILL of them (widths taken at the latitude nearest the equator, where a
 * degree is widest). A box narrower than a square tile gets tiles as long as the area limit allows.
 * @param limits { maxBboxKm2?, maxBboxWidthM?, maxBboxHeightM? } (a source descriptor)
 */
export function queryTiles(box, limits) {
    const max = queryLimitsOf(limits);
    if (withinLimits(box, max)) return [box];
    const [w, s, e, n] = box;
    const lat = s <= 0 && n >= 0 ? 0 : Math.min(Math.abs(s), Math.abs(n));
    const widthM = (e - w) * METRES_PER_DEGREE * Math.cos(lat * Math.PI / 180);
    const heightM = (n - s) * METRES_PER_DEGREE;
    const areaM2 = max.areaKm2 * 1e6 * TILE_FILL;
    const maxWidthM = max.widthM * TILE_FILL;
    const maxHeightM = max.heightM * TILE_FILL;
    const rows = Math.max(1, Math.ceil(heightM / Math.min(maxHeightM, Math.max(Math.sqrt(areaM2), areaM2 / Math.min(widthM, maxWidthM)))));
    const columns = Math.max(1, Math.ceil(widthM / Math.min(maxWidthM, areaM2 / (heightM / rows))));
    // Neighbouring tiles share their edge exactly, so the tiles cover the box without gaps.
    const edge = (from, to, count, i) => (i === count ? to : from + (to - from) * i / count);
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            tiles.push([edge(w, e, columns, column), edge(s, n, rows, row), edge(w, e, columns, column + 1), edge(s, n, rows, row + 1)]);
        }
    }
    return tiles;
}

function asGeometry(value) {
    const geometry = value?.type === 'Feature' ? value.geometry : value;
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
        throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon.');
    }
    return geometry;
}

function normalizeSite(value) {
    const geometry = asGeometry(value);
    return geometry.type === 'MultiPolygon'
        ? { type: 'MultiPolygon', coordinates: geometry.coordinates }
        : { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
}

function sourceFeature(feature, sourceId) {
    const parcelId = feature?.properties?.parcelId;
    const geometry = feature?.geometry;
    if (typeof parcelId !== 'string' || !parcelId || feature.properties.sourceId !== sourceId
        || !geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
        throw new Error('Parcel source returned a malformed or foreign parcel feature.');
    }
    return { id: parcelId, geometry };
}

function tooManyParcels(count) {
    return Object.assign(new RangeError(`The site meets more than ${MAX_SOURCE_BINDING_PARCELS} parcels.`), {
        code: 'too-many-parcels', status: 413, ...(count > MAX_SOURCE_BINDING_PARCELS ? { count } : {})
    });
}

// A source that stopped at the cap says so (`truncated`); either way the site is refused as too large.
function requireComplete(result, label) {
    const count = Array.isArray(result?.features) ? result.features.length : 0;
    if (result?.truncated === true || count > MAX_SOURCE_BINDING_PARCELS) throw tooManyParcels(count);
    if (!result || result.complete !== true || !Array.isArray(result.features)) {
        throw new Error(`${label} parcel query did not return a complete feature collection.`);
    }
}

// The surveyed regions a source reports with its candidates (HR: cadastral municipalities), or
// null for a source that does not know them.
function sourceRegions(result) {
    if (result.regions === undefined) return null;
    if (!Array.isArray(result.regions) || result.regions.some(region => !region?.geometry
        || !['Polygon', 'MultiPolygon'].includes(region.geometry.type))) {
        throw new Error('Parcel source returned malformed surveyed regions.');
    }
    return result.regions;
}

function nowIso(now) {
    const value = now();
    if (!value || typeof value.toISOString !== 'function') throw new TypeError('now must return a Date.');
    return value.toISOString();
}

const boxText = box => `[${box.map(value => value.toFixed(5)).join(',')}]`;

/**
 * The source's candidate parcels and surveyed regions for a site: one query of the site when its
 * box is within the source's limits (queryTiles), else one query per tile of the part of the site
 * inside it, tiles that do not meet the site skipped. Parcels are merged by id: a parcel crossing
 * tiles is answered by each, and is bound on all the land they answered for it. Regions are kept
 * from every tile. A failed, incomplete or truncated tile refuses the whole site, as a single
 * query would: no binding rests on part of the site.
 * @returns {Promise<{ parcels: {id, geometry}[], regions: object[]|null }>}
 */
async function readCandidates(adapter, site, { limits, sourceId, log, timeBudgetMs, clock }) {
    const siteFeature = turf.feature(site);
    const siteBox = turf.bbox(siteFeature);
    const planned = queryTiles(siteBox, limits);
    const pending = planned.length === 1 ? [{ box: siteBox, depth: 0, geometry: site }]
        : planned.map(box => ({ box, depth: 0, geometry: null }));
    const byId = new Map();
    // undefined until the first answer; then null (the source reports no regions) or every tile's.
    let regions;
    let failure = null;
    let queries = 0, tiles = pending.length, done = 0, skipped = 0, unions = 0;
    const started = clock();
    if (tiles > 1) {
        log(`site box ${boxText(siteBox)} (${wgs84BboxAreaKm2(...siteBox).toFixed(2)} km²) is over the source's query limit: ${tiles} tiles, ${TILE_CONCURRENCY} at a time`);
    }

    const take = result => {
        requireComplete(result, 'Geometry');
        const parcels = result.features.map(feature => sourceFeature(feature, sourceId));
        if (new Set(parcels.map(parcel => parcel.id)).size !== parcels.length) {
            throw new Error('Parcel source returned duplicate parcel IDs.');
        }
        const found = sourceRegions(result);
        if (regions !== undefined && (regions === null) !== (found === null)) {
            throw new Error('Parcel source reported surveyed regions for only some tiles.');
        }
        regions = found === null ? null : [...(regions || []), ...found];
        for (const parcel of parcels) {
            const seen = byId.get(parcel.id);
            if (!seen) byId.set(parcel.id, parcel);
            else if (JSON.stringify(seen.geometry) !== JSON.stringify(parcel.geometry)) {
                // Two tiles answered different outlines of one parcel: its land is all they answered.
                const union = clipWith(turf, 'union', turf.feature(seen.geometry), turf.feature(parcel.geometry),
                    { site: 'source-binding.tiles', parcelId: parcel.id });
                byId.set(parcel.id, { id: parcel.id, geometry: union.geometry });
                unions++;
            }
        }
        if (byId.size > MAX_SOURCE_BINDING_PARCELS) throw tooManyParcels(byId.size);
    };

    const run = async task => {
        const taskStarted = clock();
        let result;
        try {
            result = await adapter.queryGeometry(task.geometry);
        } catch (error) {
            if (!isOverQueryLimit(error) || task.depth >= MAX_TILE_DEPTH) throw error;
            pending.unshift(...quarters(task.box).map(box => ({ box, depth: task.depth + 1, geometry: null })));
            tiles += 3;
            log(`tile ${boxText(task.box)} is over the source's limit (${error.message}): read in quarters, ${tiles} tiles`);
            return;
        }
        take(result);
        done++;
        if (tiles > 1) {
            log(`tile ${done}/${tiles} ${boxText(task.box)}: ${result.features.length} parcels, ${byId.size} so far, ${clock() - taskStarted} ms`);
        }
    };

    await new Promise(resolve => {
        let active = 0;
        const pump = () => {
            while (!failure && active < TILE_CONCURRENCY && pending.length) {
                const task = pending.shift();
                if (!task.geometry) {
                    let piece;
                    try {
                        piece = clipWith(turf, 'intersect', siteFeature, turf.feature(boxPolygon(task.box)), { site: 'source-binding.tile' });
                    } catch (error) { failure = failure || error; break; }
                    if (!piece?.geometry || turf.area(piece) <= 0) { done++; skipped++; continue; }
                    task.geometry = piece.geometry;
                }
                if (clock() - started >= timeBudgetMs) {
                    failure = areaLimitError(`Reading the site's parcels took over ${Math.round(timeBudgetMs / 1000)} s of its parcel source; bind a smaller site.`);
                    break;
                }
                if (queries >= MAX_SOURCE_BINDING_QUERIES) {
                    failure = areaLimitError(`The site needs more than ${MAX_SOURCE_BINDING_QUERIES} queries of its parcel source; bind a smaller site.`);
                    break;
                }
                queries++;
                active++;
                run(task).catch(error => { failure = failure || error; }).finally(() => { active--; pump(); });
            }
            if (!active) resolve();
        };
        pump();
    });
    if (failure) {
        if (tiles > 1) log(`refused after ${queries} queries: ${failure.message}`);
        throw failure;
    }
    if (tiles > 1) {
        log(`read ${tiles} tiles in ${queries} queries (${skipped} off the site) in ${clock() - started} ms: ${byId.size} parcels`
            + (unions ? `, ${unions} answered in different outlines by two tiles and bound on their union` : ''));
    }
    return { parcels: [...byId.values()], regions: regions ?? null };
}

const logLine = sourceId => message => console.log(`[${new Date().toISOString()}] [source-binding] ${sourceId}: ${message}`);

/**
 * The binding of a site over a selected parcel source.
 * @param adapter the source's adapter (queryGeometry)
 * @param options.limits the source's query limits: its descriptor's maxBboxKm2, maxBboxWidthM and
 *   maxBboxHeightM, where it declares them (readCandidates). `log(message)` takes tile progress.
 *   `timeBudgetMs` and `clock` (ms) bound how long the source is read (SOURCE_BINDING_TIME_BUDGET_MS).
 */
export async function computeSourceBinding(adapter, {
    site, toleranceM = 0, sourceId, snapshotId = null, now = () => new Date(), limits = null, log = null,
    timeBudgetMs = SOURCE_BINDING_TIME_BUDGET_MS, clock = Date.now
} = {}) {
    if (!adapter || typeof adapter.queryGeometry !== 'function') throw new TypeError('A parcel source adapter is required.');
    if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId is required.');
    // On the shared grid, as the browser holds every site and parcel.
    const normalizedSite = snapGeometry(normalizeSite(site));
    const tolerance = normalizeTolerance(toleranceM);
    const { parcels, regions } = await readCandidates(adapter, normalizedSite, { limits, sourceId, log: log || logLine(sourceId), timeBudgetMs, clock });

    // A clip the shared clipper cannot do (after its own deterministic retries, as in the browser)
    // throws a typed ClipFailure; nothing is bound on a guess.
    const parcelSource = { sourceId, snapshotId: snapshotId || null };
    const binding = bindingFromParcels(normalizedSite, parcels, {
        turf,
        toleranceM: tolerance,
        regions,
        source: `server:${sourceId}`
    });
    return {
        site: normalizedSite,
        binding: { ...binding, parcelSource, computedAt: nowIso(now) }
    };
}

export async function computeSourceParcelActBinding(adapter, declaredIds, {
    toleranceM = 0, sourceId, snapshotId = null, now = () => new Date()
} = {}) {
    if (!adapter || typeof adapter.queryIds !== 'function') throw new TypeError('A parcel source adapter is required.');
    if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId is required.');
    if (!Array.isArray(declaredIds) || !declaredIds.length || declaredIds.some(id => typeof id !== 'string' || !id)) {
        throw new TypeError('declaredIds must contain parcel IDs.');
    }
    if (declaredIds.length > MAX_SOURCE_BINDING_PARCELS || new Set(declaredIds).size !== declaredIds.length) {
        throw new RangeError(`declaredIds must contain at most ${MAX_SOURCE_BINDING_PARCELS} unique parcel IDs.`);
    }
    const tolerance = normalizeTolerance(toleranceM);
    const result = { features: [], absentIds: [], complete: true };
    for (let offset = 0; offset < declaredIds.length; offset += 80) {
        const batch = await adapter.queryIds(declaredIds.slice(offset, offset + 80));
        requireComplete(batch, 'ID');
        if (!Array.isArray(batch.absentIds)) throw new Error('Parcel ID query did not provide complete absence information.');
        result.features.push(...batch.features);
        result.absentIds.push(...batch.absentIds);
    }
    requireComplete(result, 'ID');
    const declared = new Set(declaredIds);
    const absent = new Set(result.absentIds);
    if (absent.size !== result.absentIds.length || [...absent].some(id => !declared.has(id))) {
        throw new Error('Parcel ID query returned invalid absent IDs.');
    }
    const parcels = result.features.map(feature => sourceFeature(feature, sourceId))
        .map(parcel => ({ ...parcel, geometry: snapGeometry(parcel.geometry) }));
    const found = new Set(parcels.map(parcel => parcel.id));
    if (found.size !== parcels.length || [...found].some(id => !declared.has(id))
        || [...declared].some(id => !found.has(id) && !absent.has(id))
        || [...absent].some(id => found.has(id))) {
        throw new Error('Parcel ID query returned inconsistent feature and absence sets.');
    }

    let site = null;
    let siteM2 = 0;
    if (parcels.length) {
        // The declared parcels' union by the shared clip (a failure throws a typed ClipFailure).
        let union = turf.feature(parcels[0].geometry);
        for (const parcel of parcels.slice(1)) {
            union = clipWith(turf, 'union', union, turf.feature(parcel.geometry), { site: 'source-binding.declaredParcels', parcelId: parcel.id });
        }
        if (!union?.geometry || !['Polygon', 'MultiPolygon'].includes(union.geometry.type)) {
            throw new Error('Declared parcel union produced invalid geometry.');
        }
        const geometry = union.geometry;
        site = geometry.type === 'MultiPolygon' ? geometry : { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
        siteM2 = turf.area(union);
    }
    const entries = parcels.map(parcel => ({ parcelId: parcel.id, overlapM2: Number(turf.area(turf.feature(parcel.geometry)).toFixed(3)), intrusionM: null }))
        .sort((a, b) => a.parcelId.localeCompare(b.parcelId));
    return {
        site,
        extra: [...absent].sort(),
        binding: {
            parcels: entries,
            touched: [],
            toleranceM: tolerance,
            coverage: 'complete',
            unsurveyedM2: 0,
            unknownM2: 0,
            siteM2: Number(siteM2.toFixed(2)),
            source: `server:${sourceId}`,
            parcelSource: { sourceId, snapshotId: snapshotId || null },
            computedAt: nowIso(now),
            subject: 'declared-parcels'
        }
    };
}
