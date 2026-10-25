// Public INTERPI SIGEF parcels: fresh native-ID reads and complete, bounded municipality paging.
import { bbox, bboxPolygon, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const INTERPI_ENDPOINT = 'https://sig.interpi.pi.gov.br/geojson_data/';

export function createInterpiSigefParcelSource(input, { fetchImpl = fetch, now = Date.now } = {}) {
    const d = structuredClone(input);
    if (d.endpoint !== INTERPI_ENDPOINT || !d.id || !d.idPrefix || d.table !== 'SIGEF Privado'
        || d.sourceTable !== 'outros_sigef_privado' || typeof d.municipality !== 'string' || !d.municipality.trim()
        || d.sourceCrs !== 'EPSG:4674' || d.outFields?.join() !== 'id' || d.idField !== 'id'
        || !Number.isSafeInteger(d.pageSize) || d.pageSize < 1 || d.pageSize > 500
        || !Number.isSafeInteger(d.maxMunicipalityFeatures) || d.maxMunicipalityFeatures < 1 || d.maxMunicipalityFeatures > 10000
        || !Number.isSafeInteger(d.maxFeatures) || d.maxFeatures < 1 || d.maxFeatures > 10000) {
        throw new Error('Invalid INTERPI SIGEF descriptor.');
    }
    const fail = message => upstreamError(message, 502, 'interpi-invalid-response');
    let municipalityCache, expires = 0, pending;
    async function page(term, offset, budget) {
        const url = new URL(d.endpoint);
        url.search = new URLSearchParams({ tables: d.table, municipio: d.municipality, term, offset: String(offset), limit: String(d.pageSize) });
        const response = await fetchImpl(url.href, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        const reader = response.body?.getReader();
        if (!reader) throw fail('INTERPI response has no readable body.');
        const chunks = []; let bytes = 0;
        try {
            for (;;) {
                const part = await reader.read(); if (part.done) break;
                bytes += part.value.byteLength; budget.bytes += part.value.byteLength;
                if (bytes > 16 * 1024 ** 2 || budget.bytes > 64 * 1024 ** 2) throw fail('INTERPI actual response byte budget exceeded.');
                chunks.push(part.value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const result = JSON.parse(new TextDecoder().decode(concatBytes(chunks, bytes)));
        if (result.type !== 'FeatureCollection' || !Array.isArray(result.features)
            || result.features.length > d.pageSize || typeof result.more_data !== 'boolean'
            || result.more_data && !result.features.length) throw fail('INTERPI paging envelope is invalid.');
        const features = result.features.map(feature => {
            const id = feature.properties?.id;
            if (!(Number.isSafeInteger(id) && id > 0 || typeof id === 'string' && /^[1-9]\d*$/.test(id))
                || feature.properties?.tabela !== d.sourceTable || !validateGeometry(feature.geometry)
                || feature.geometry.crs?.properties?.name !== 'EPSG:4674') throw fail('INTERPI parcel identity, layer or geometry changed.');
            // Preserve the complete source geometry, including its CRS and Z. The service's
            // unsolicited display label is discarded; only the native ID enters app state.
            return canonicalParcelFeature(d, { geometry: feature.geometry, properties: { id } }, String(id));
        });
        return { features, more: result.more_data };
    }
    async function enumerate(term) {
        const found = new Map(), budget = { bytes: 0 };
        let offset = 0;
        for (;;) {
            const result = await page(term, offset, budget);
            for (const feature of result.features) {
                if (found.has(feature.id)) throw fail('INTERPI repeated a native ID across pages.');
                found.set(feature.id, feature);
            }
            if (found.size > d.maxMunicipalityFeatures) throw fail('INTERPI municipality feature budget exceeded.');
            if (!result.more) return [...found.values()];
            offset += result.features.length;
            if (offset >= d.maxMunicipalityFeatures) throw fail('INTERPI municipality enumeration is incomplete.');
        }
    }
    function collection(features, extra = {}) {
        if (features.length > d.maxFeatures) throw fail('INTERPI query feature budget exceeded.');
        return { type: 'FeatureCollection', sourceId: d.id, complete: true, returnsWGS84: true, features, ...extra };
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
            || !id.startsWith(d.idPrefix) || !/^[1-9]\d*$/.test(id.slice(d.idPrefix.length)))) throw new HttpError(400, 'Invalid INTERPI parcel IDs.');
        const features = [], absentIds = [];
        for (const id of new Set(ids)) {
            // term is a search, not an equality predicate: filter by the exact native ID after
            // exhausting all returned pages, and never substitute a substring/name match.
            const matches = (await enumerate(id.slice(d.idPrefix.length))).filter(feature => feature.id === id);
            if (matches.length) features.push(matches[0]); else absentIds.push(id);
        }
        return collection(features, { absentIds });
    }
    async function municipality() {
        if (municipalityCache && expires > now()) return municipalityCache;
        if (!pending) pending = enumerate('').then(features => {
            municipalityCache = features; expires = now() + 300000; return features;
        }).finally(() => { pending = null; });
        return pending;
    }
    async function intersect(geometry, bounds) {
        const target = turfFeature(geometry);
        const features = (await municipality()).filter(feature => {
            const b = bbox(feature);
            return b[0] <= bounds[2] && b[2] >= bounds[0] && b[1] <= bounds[3] && b[3] >= bounds[1]
                && booleanIntersects(feature, target);
        });
        return collection(features);
    }
    function queryBounds(bounds) {
        validateBounds(bounds, d.maxBboxKm2 ?? 25, d);
        return intersect(bboxPolygon(bounds).geometry, bounds);
    }
    function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid WGS84 polygon geometry.');
        const bounds = bbox(turfFeature(geometry)); validateBounds(bounds, d.maxBboxKm2 ?? 25, d);
        return intersect(geometry, bounds);
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
