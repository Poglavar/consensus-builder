// Kazakhstan cadastre (EGKN PKK) saved copies: when the live parcel view fails, its WFS reads are
// answered from a saved copy of the district, in the same GeoJSON page shape and marked with
// `x-parcel-snapshot`. Copies are written by scripts/snapshot-kazakhstan-pkk.mjs as
// `<KZ_PKK_SNAPSHOT_DIR>/u_view-district-<id>.geojson.gz`. Node only; the browser bundle reads
// through the relay, which uses this too.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);
const LIVE_BUDGET_MS = 8000;
const log = (...args) => console.log(`[${new Date().toISOString()}] [kazakhstan-pkk-snapshot]`, ...args);

export const snapshotFileName = districtId => `u_view-district-${districtId}.geojson.gz`;

function featureBox(geometry) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = value => {
        if (typeof value[0] === 'number') {
            if (value[0] < minX) minX = value[0]; if (value[0] > maxX) maxX = value[0];
            if (value[1] < minY) minY = value[1]; if (value[1] > maxY) maxY = value[1];
        } else for (const item of value) walk(item);
    };
    if (geometry?.coordinates) walk(geometry.coordinates);
    return [minX, minY, maxX, maxY];
}

const unescapeXml = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&');

// The u_view GetFeature reads the adapter makes: district, bbox or a kad_nomer filter, paging by gid.
// Anything else is not answered from a copy.
export function parseSnapshotQuery(href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    const params = new Map([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
    if (!/\/geoserver\/egkn\/u_view\/wfs$/.test(url.pathname) || params.get('request') !== 'GetFeature'
        || params.get('typename') !== 'egkn:u_view') return null;
    const district = /^district_id:([0-9]{1,6})$/.exec(params.get('viewparams') || '');
    if (!district) return null;
    const bbox = params.has('bbox') ? params.get('bbox').split(',').slice(0, 4).map(Number) : null;
    if (bbox && (bbox.length !== 4 || !bbox.every(Number.isFinite))) return null;
    const filter = params.get('filter');
    const codes = filter ? [...filter.matchAll(/<fes:Literal>([^<]*)<\/fes:Literal>/g)].map(match => unescapeXml(match[1])) : null;
    if (filter && !codes.length) return null;
    const fields = params.get('propertyname')?.split(',').filter(name => name && name !== 'geom') ?? null;
    return { districtId: Number(district[1]), bbox, codes, fields,
        count: Math.max(0, Number(params.get('count') ?? 1000) || 0), startIndex: Math.max(0, Number(params.get('startindex') ?? 0) || 0) };
}

/** Reads saved districts from `directory`; each file is loaded once, on first need. */
export function createPkkSnapshotStore({ directory = process.env.KZ_PKK_SNAPSHOT_DIR } = {}) {
    const loaded = new Map();
    function district(districtId) {
        if (!directory) return Promise.resolve(null);
        if (!loaded.has(districtId)) {
            loaded.set(districtId, (async () => {
                const file = path.join(directory, snapshotFileName(districtId));
                let bytes;
                try { bytes = await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
                const collection = JSON.parse(await gunzip(bytes));
                const features = collection.features.map(feature => ({ feature, box: featureBox(feature.geometry) }))
                    .sort((a, b) => a.feature.properties.gid - b.feature.properties.gid);
                log(`loaded district ${districtId}: ${features.length} parcels saved ${collection.snapshotDate}`);
                return { savedAt: collection.snapshotDate, features };
            })().catch(error => { loaded.delete(districtId); throw error; }));
        }
        return loaded.get(districtId);
    }

    // → { savedAt, page } for a read a copy can answer, else null.
    async function answer(href) {
        const query = parseSnapshotQuery(href);
        if (!query) return null;
        const saved = await district(query.districtId);
        if (!saved) return null;
        const codes = query.codes ? new Set(query.codes) : null;
        const [x0, y0, x1, y1] = query.bbox || [];
        const matched = saved.features.filter(({ feature, box }) => (!codes || codes.has(String(feature.properties.kad_nomer)))
            && (!query.bbox || (box[0] <= x1 && box[2] >= x0 && box[1] <= y1 && box[3] >= y0)));
        const features = matched.slice(query.startIndex, query.startIndex + query.count).map(({ feature }) => ({
            type: 'Feature', id: feature.id, geometry: feature.geometry, geometry_name: 'geom',
            properties: query.fields ? Object.fromEntries(query.fields.map(name => [name, feature.properties[name] ?? null])) : feature.properties
        }));
        return { savedAt: saved.savedAt, page: { type: 'FeatureCollection', features, totalFeatures: matched.length,
            numberMatched: matched.length, numberReturned: features.length, timeStamp: saved.savedAt,
            // As the live view: its native CRS on any answer with parcels, none on an empty one.
            crs: matched.length ? { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::404000' } } : null } };
    }
    return { answer };
}

let sharedStore = null;
const defaultStore = () => (sharedStore ||= createPkkSnapshotStore());

/**
 * Wraps the cadastre transport: the live answer when it succeeds within its budget, else the saved
 * copy's answer for the same read, else the live failure unchanged.
 * fetchImpl(url: string, init) → Response
 */
export function withPkkSnapshotFallback(fetchImpl, { store = defaultStore(), liveBudgetMs = LIVE_BUDGET_MS } = {}) {
    return async (url, init = {}) => {
        const href = String(url);
        let live = null, failure = null;
        // The budget covers the live answer's arrival only; a successful body keeps the caller's signal.
        const controller = new AbortController();
        const forward = () => controller.abort(init.signal.reason);
        init.signal?.addEventListener('abort', forward, { once: true });
        const budget = setTimeout(() => controller.abort(new DOMException('live cadastre answer late', 'TimeoutError')), liveBudgetMs);
        try {
            live = await fetchImpl(url, { ...init, signal: controller.signal });
            if (live.status === 200) return live;
        } catch (error) { failure = error; }
        finally { clearTimeout(budget); }
        if (init.signal?.aborted) { if (failure) throw failure; return live; }
        const saved = await store.answer(href).catch(error => { log('saved copy unreadable:', error.message); return null; });
        if (!saved) { if (failure) throw failure; return live; }
        live?.body?.cancel?.().catch(() => {});
        log(`live cadastre ${failure ? failure.name || 'error' : `HTTP ${live.status}`}; answered from the copy saved ${saved.savedAt}`);
        return new Response(JSON.stringify(saved.page), { status: 200,
            headers: { 'content-type': 'application/json', 'x-parcel-snapshot': saved.savedAt } });
    };
}
