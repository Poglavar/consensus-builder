// Niigata's public tax-parcel viewer: bounded rectangle queries and fresh native-item reads.
import { bboxPolygon, booleanIntersects, bbox as geometryBbox, feature as turfFeature } from '@turf/turf';
import { canonicalParcelFeature, validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';
import { concatBytes } from './byte-utils.js';

const ORIGIN = 'https://niigata.e-map.geogeo.jp';
export const EMAP_ENDPOINT = `${ORIGIN}/locsearch/attsbylatlng.json`;
const PREFIX = 'JP-NIIGATA-EMAP-9000000010-';
const LAYER = '9000000010';
const MAX_BYTES = 16 * 1024 ** 2;

function invalid(message) { return upstreamError(message, 502, 'geogeo-emap-invalid-response'); }

// The viewer's search URL (not mode=attribute) embeds strict JSON. Never evaluate page scripts.
export function parseEmapInitData(text) {
    const match = /\bvar initData\s*=\s*(\{[^\r\n]+\})\s*[,;]/.exec(text);
    if (!match) throw invalid('E-map did not return its viewer JSON.');
    let data;
    try { data = JSON.parse(match[1]); } catch { throw invalid('E-map viewer JSON is malformed.'); }
    if (data.init_mode !== 'attribute' || String(data.init_mid) !== '20' || !Array.isArray(data.init_attr)) {
        throw invalid('E-map exact read has the wrong theme or operation.');
    }
    return data;
}

export function isEmapParcelUrl(descriptor, url) {
    if (descriptor.adapter !== 'geogeo-emap' || descriptor.endpoint !== EMAP_ENDPOINT
        || url.origin !== ORIGIN || url.username || url.password || url.hash) return false;
    const params = url.searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1) || params.get('mid') !== '20') return false;
    if (url.pathname === '/maps') return params.get('mode') === 'search' && params.get('lid') === '0'
        && params.get('layerid') === LAYER && /^[1-9][0-9]{0,14}$/.test(params.get('linkkey') || '')
        && [...params.keys()].every(key => ['mode', 'lid', 'mid', 'layerid', 'linkkey'].includes(key));
    const spatial = url.pathname === '/locsearch/attsbybox.json'
        ? ['latll', 'lngll', 'latul', 'lngul', 'latlr', 'lnglr', 'latur', 'lngur']
        : url.pathname === '/locsearch/attsbylatlng.json' ? ['lat', 'lng'] : null;
    return !!spatial && params.get('layerids') === LAYER && params.get('zoomlevel') === '17'
        && spatial.every(key => params.has(key) && params.get(key).trim() !== ''
            && Number.isFinite(Number(params.get(key))) && Math.abs(Number(params.get(key))) <= (key.startsWith('lat') ? 90 : 180))
        && [...params.keys()].every(key => ['mid', 'layerids', 'zoomlevel', 'mode', 'sort', ...spatial].includes(key));
}

export function createGeogeoEmapSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (descriptor.endpoint !== EMAP_ENDPOINT || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'itemid'
        || descriptor.outFields?.join() !== 'itemid' || descriptor.layerId !== LAYER || descriptor.themeId !== '20') {
        throw new Error('Invalid Niigata e-map descriptor.');
    }
    function canonical(row) {
        const native = String(row?.itemid ?? '');
        if (!/^[1-9][0-9]{0,14}$/.test(native) || String(row.layerid) !== LAYER || typeof row.geojson !== 'string') {
            throw invalid('E-map returned an invalid native parcel identity.');
        }
        let geometry;
        try { geometry = JSON.parse(row.geojson); } catch { throw invalid('E-map parcel geometry is malformed JSON.'); }
        if (!validateGeometry(geometry)) throw invalid('E-map parcel is not a usable geographic polygon.');
        return canonicalParcelFeature(descriptor, { geometry, properties: {} }, native);
    }
    async function request(url, budget, signal) {
        if (!isEmapParcelUrl(descriptor, url)) throw new Error('E-map request is outside the fixed parcel contract.');
        const timeout = AbortSignal.timeout(45000);
        const response = await fetchImpl(url.href, { headers: { Accept: url.pathname === '/maps' ? 'text/html' : 'application/json' },
            redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        const reader = response.body?.getReader();
        if (!reader) throw invalid('E-map response has no readable body.');
        const chunks = []; let bytes = 0;
        try {
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                bytes += part.value.byteLength; budget.bytes += part.value.byteLength;
                if (bytes > MAX_BYTES || budget.bytes > 64 * 1024 ** 2) throw invalid('E-map streamed byte budget exceeded.');
                chunks.push(part.value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return new TextDecoder().decode(concatBytes(chunks, bytes));
    }
    const result = (features, absentIds = [], scope = 'exact-native-itemid') => ({ type: 'FeatureCollection',
        sourceId: descriptor.id, features, absentIds, complete: true, returnsWGS84: true, scope });
    async function queryIds(ids, { signal } = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !/^[1-9][0-9]{0,14}$/.test(id.slice(PREFIX.length)))) {
            throw new Error('Invalid e-map parcel IDs.');
        }
        const features = [], absent = [], budget = { bytes: 0 };
        for (const id of ids) {
            const url = new URL('/maps', ORIGIN);
            url.search = new URLSearchParams({ mode: 'search', lid: '0', mid: '20', layerid: LAYER, linkkey: id.slice(PREFIX.length) });
            const data = parseEmapInitData(await request(url, budget, signal));
            if (data.init_attr.length > 1) throw invalid('E-map exact read returned multiple records.');
            if (!data.init_attr.length) absent.push(id);
            else {
                const f = canonical(data.init_attr[0]);
                if (f.id !== id) throw invalid('E-map exact read returned a different parcel.');
                features.push(f);
            }
        }
        return result(features, absent);
    }
    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 2);
        const [w, s, e, n] = bounds;
        const nx = Math.ceil((e - w) / 0.001), ny = Math.ceil((n - s) / 0.001);
        if (nx * ny > 256) throw invalid('E-map viewport needs smaller query cells.');
        const budget = { bytes: 0 }, byId = new Map(), query = bboxPolygon(bounds);
        for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
            const left = w + (e - w) * x / nx, right = w + (e - w) * (x + 1) / nx;
            const bottom = s + (n - s) * y / ny, top = s + (n - s) * (y + 1) / ny;
            const url = new URL('/locsearch/attsbybox.json', ORIGIN);
            url.search = new URLSearchParams({ mid: '20', layerids: LAYER, zoomlevel: '17',
                latll: String(top), lngll: String(left), latul: String(top), lngul: String(right),
                latlr: String(bottom), lnglr: String(right), latur: String(bottom), lngur: String(left) });
            let rows;
            try { rows = JSON.parse(await request(url, budget, signal)); } catch (error) {
                if (error instanceof SyntaxError) throw invalid('E-map rectangle response is malformed JSON.');
                throw error;
            }
            if (!Array.isArray(rows) || rows.length >= 2000) throw invalid('E-map rectangle response reached the conservative row guard.');
            for (const row of rows) {
                const f = canonical(row), old = byId.get(f.id);
                if (old && JSON.stringify(old.geometry) !== JSON.stringify(f.geometry)) throw invalid('E-map returned conflicting native parcel geometry.');
                if (booleanIntersects(query, f)) byId.set(f.id, f);
            }
            if (byId.size > (descriptor.maxFeatures ?? 3000)) throw invalid('E-map viewport exceeded the parcel limit.');
        }
        // This means the bounded API responses were consumed, not city cadastral completeness.
        return result([...byId.values()], [], 'bounded-viewer-rectangle-responses');
    }
    return { queryIds, queryBounds, async queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw invalid('Expected a geographic parcel query polygon.');
        const query = turfFeature(geometry), read = await queryBounds(geometryBbox(query), options);
        return { ...read, features: read.features.filter(f => booleanIntersects(query, f)) };
    } };
}
