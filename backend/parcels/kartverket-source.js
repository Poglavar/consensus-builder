// Reads Kartverket ground Teig polygons unchanged. References bind the provider's
// lokalid to its cadastral tuple, allowing fresh exact reads without a local index.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, point as turfPoint } from '@turf/turf';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

export const KARTVERKET_ENDPOINT = 'https://api.kartverket.no/eiendom/v1/punkt/omrader';
export const KARTVERKET_EXACT_ENDPOINT = 'https://api.kartverket.no/eiendom/v1/geokoding';
const SOURCE_ID = 'no-kartverket-eiendom-api-omrader';
const PREFIX = 'NO-KARTVERKET-LOKALID:';
const TUPLE_FIELDS = ['kommunenummer', 'gardsnummer', 'bruksnummer', 'festenummer', 'seksjonsnummer'];
const FIELDS = ['lokalid', ...TUPLE_FIELDS, 'objekttype'];
const FILTER = ['type', 'features.type', 'features.geometry', ...FIELDS.map(key => `features.properties.${key}`)].join(',');
const MAX_BYTES = 16 * 1024 * 1024;
const invalid = message => upstreamError(message || 'Kartverket returned an invalid cadastral response.');
const inputError = message => Object.assign(new Error(message), { status: 400, code: 'invalid-parcel-query' });
const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

export function kartverketNativeReference(properties) {
    if (!Number.isSafeInteger(properties?.lokalid) || properties.lokalid < 1
        || !/^\d{4}$/.test(properties.kommunenummer)
        || TUPLE_FIELDS.slice(1).some(key => !Number.isSafeInteger(properties[key]) || properties[key] < 0)) throw invalid();
    return `${properties.lokalid}@${TUPLE_FIELDS.map(key => properties[key]).join('.')}`;
}

export function createKartverketParcelSource(descriptor, { fetchImpl = globalThis.fetch, timeoutMs = 30000,
    maxResponseBytes = MAX_BYTES } = {}) {
    if (descriptor?.id !== SOURCE_ID || descriptor.adapter !== 'kartverket-eiendom'
        || descriptor.endpoint !== KARTVERKET_ENDPOINT || descriptor.idPrefix !== PREFIX || descriptor.idField !== 'lokalid'
        || !Array.isArray(descriptor.outFields) || descriptor.outFields.length !== FIELDS.length
        || FIELDS.some(key => !descriptor.outFields.includes(key)) || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Invalid Kartverket parcel descriptor.');

    function budget() { return { bytes: 0, requests: 0, signal: AbortSignal.timeout(120000) }; }
    async function request(endpoint, params, limits) {
        if (++limits.requests > 80) throw invalid('Kartverket query exceeds the bounded request budget; request a smaller area.');
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ ...params, utkoordsys: '4326', filtrer: FILTER }).toString();
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), limits.signal]);
        try {
            const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
                headers: { Accept: 'application/json' }, signal });
            if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
            const reader = response.body?.getReader();
            if (!reader) throw invalid();
            const chunks = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    limits.bytes += value.byteLength;
                    if (size > maxResponseBytes || limits.bytes > 64 * 1024 * 1024) {
                        await reader.cancel(); throw invalid('Kartverket response exceeds the byte budget.');
                    }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
            const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)));
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features) || payload.features.length > 500) throw invalid();
            const byLocalId = new Map();
            const features = [];
            for (const feature of payload.features) {
                const props = feature?.properties;
                if (!props || typeof props.objekttype !== 'string') throw invalid();
                if (props.objekttype.toLowerCase() !== 'teig') {
                    if (props.objekttype.toLowerCase() !== 'anleggsprojeksjonsflate') throw invalid();
                    continue;
                }
                const reference = kartverketNativeReference(props);
                if (feature.type !== 'Feature' || !validateGeometry(feature.geometry)) throw invalid();
                const canonical = canonicalParcelFeature(descriptor, { type: 'Feature', geometry: feature.geometry,
                    properties: Object.fromEntries(FIELDS.map(key => [key, props[key]])) }, reference);
                const previous = byLocalId.get(props.lokalid);
                if (previous && (previous.id !== canonical.id || JSON.stringify(previous.geometry) !== JSON.stringify(canonical.geometry))) {
                    throw invalid('Kartverket returned conflicting cadastral identity or geometry.');
                }
                if (!previous) features.push(canonical);
                byLocalId.set(props.lokalid, canonical);
            }
            return { features, rawCount: payload.features.length };
        } catch (error) {
            if (signal.aborted) throw upstreamError('Kartverket request timed out.', 504);
            if (error.status) throw error;
            throw invalid();
        }
    }
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features, complete: true,
        sourceId: SOURCE_ID, returnsWGS84: true, ...extra });

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw inputError('Provide between 1 and 80 Kartverket references.');
        const unique = [...new Set(ids)];
        const parsed = unique.map(id => {
            const match = typeof id === 'string' && id.startsWith(PREFIX)
                && /^([1-9][0-9]{0,15})@(\d{4})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.exec(id.slice(PREFIX.length));
            if (!match || !Number.isSafeInteger(Number(match[1]))) throw inputError('Invalid Kartverket reference; native lokalid and cadastral tuple are required.');
            return { id, localId: Number(match[1]), tuple: Object.fromEntries(TUPLE_FIELDS.map((key, i) => [key, match[i + 2]])) };
        });
        const features = [], absentIds = [], limits = budget();
        for (const requested of parsed) {
            const read = await request(KARTVERKET_EXACT_ENDPOINT, { ...requested.tuple, omrade: 'true' }, limits);
            // A tuple can have several Teig polygons; only its requested native lokalid belongs to this read.
            // A full response could be truncated, so it never establishes exact-read absence/completeness.
            if (read.rawCount >= 500) throw invalid('Kartverket exact response reached the provider limit.');
            if (read.features.some(f => TUPLE_FIELDS.some(key => String(f.properties.sourceProperties[key]) !== requested.tuple[key]))) throw invalid();
            const matching = read.features.find(f => f.properties.sourceProperties.lokalid === requested.localId);
            if (matching && matching.id !== requested.id) throw invalid();
            if (matching) features.push(matching); else absentIds.push(requested.id);
        }
        return result(features, { absentIds });
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 || 4);
        const limits = budget(), parcels = new Map(), localIds = new Map();
        const footprint = bboxPolygon(bounds);
        async function cell(box, depth) {
            const center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
            // Conservative circumscribed radius; source coordinates and returned polygons are never shifted.
            const dx = (box[2] - box[0]) * 111320 * Math.max(Math.cos(box[1] * Math.PI / 180), Math.cos(box[3] * Math.PI / 180)) / 2;
            const dy = (box[3] - box[1]) * 111700 / 2;
            const radius = Math.max(1, Math.ceil(Math.hypot(dx, dy)) + 2);
            if (radius > 3000) throw inputError('Kartverket radius exceeds 3000 metres; request a smaller area.');
            const read = await request(KARTVERKET_ENDPOINT, { ost: String(center[0]), nord: String(center[1]),
                koordsys: '4326', radius: String(radius), maksTreff: '500' }, limits);
            if (read.rawCount === 500) {
                if (depth >= 5) throw invalid('Kartverket area remains capped after bounded subdivision.');
                for (const child of [[box[0], box[1], center[0], center[1]], [center[0], box[1], box[2], center[1]],
                    [box[0], center[1], center[0], box[3]], [center[0], center[1], box[2], box[3]]]) await cell(child, depth + 1);
                return;
            }
            for (const feature of read.features) {
                const localId = feature.properties.sourceProperties.lokalid;
                const priorId = localIds.get(localId), prior = parcels.get(feature.id);
                if ((priorId && priorId !== feature.id) || (prior && JSON.stringify(prior.geometry) !== JSON.stringify(feature.geometry))) {
                    throw invalid('Kartverket changed an identity or geometry during the area read.');
                }
                if (booleanIntersects(feature, footprint)) {
                    parcels.set(feature.id, feature); localIds.set(localId, feature.id);
                }
                if (parcels.size > (descriptor.maxFeatures || 10000)) throw invalid('Kartverket query exceeds the parcel limit.');
            }
        }
        await cell(bounds, 0);
        return result([...parcels.values()]);
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw inputError('Provide a WGS84 parcel polygon.');
        const read = await queryBounds(geometryBbox(geometry));
        return { ...read, features: read.features.filter(f => booleanIntersects(f, geometry)) };
    }
    async function queryPoint(point) {
        if (!validPoint(point)) throw inputError('Expected WGS84 [longitude, latitude].');
        const read = await request(KARTVERKET_ENDPOINT, { ost: String(point[0]), nord: String(point[1]),
            koordsys: '4326', radius: '1', maksTreff: '500' }, budget());
        if (read.rawCount === 500) throw invalid('Kartverket point response reached the provider limit.');
        return result(read.features.filter(f => booleanPointInPolygon(turfPoint(point), f)));
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry, queryPoint });
}
