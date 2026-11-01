// Resolve e-gazar's daily district layers without making the publication date a parcel identity.
import { bbox as geometryBbox, booleanIntersects } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';
import { concatBytes } from './byte-utils.js';

export function resolveEgazarLayers(xml, districts) {
    const latest = new Map();
    const blocks = xml.match(/<(?:\w+:)?FeatureType\b[^>]*>[\s\S]*?<\/(?:\w+:)?FeatureType>/g) || [];
    for (const block of blocks) {
        const name = /<(?:\w+:)?Name>([^<]+)<\/(?:\w+:)?Name>/.exec(block)?.[1]?.trim();
        const match = /^geoware:geo_view_parcel_soum_egazar_(\d{5})_(\d{4}-\d{2}-\d{2})$/.exec(name || '');
        if (!match || !districts.includes(match[1])) continue;
        const [, district, date] = match;
        const parsed = new Date(`${date}T00:00:00Z`);
        if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) continue;
        if (!latest.has(district) || latest.get(district) < name) latest.set(district, name);
    }
    if (districts.some(district => !latest.has(district))) throw upstreamError('E-gazar did not publish every configured district layer.');
    return latest;
}

export function createEgazarParcelSource(descriptor, { fetchImpl }, createWfsSource) {
    const districts = descriptor.egazarDistrictCodes;
    if (descriptor.endpoint !== 'https://geoserver.egazar.gov.mn/geoserver/geoware/ows'
        || descriptor.version !== '2.0.0' || descriptor.idPrefix !== 'MN-EGAZAR-'
        || descriptor.idField !== 'parcel_id' || descriptor.geometryField !== 'geometry'
        || descriptor.idType !== 'string' || descriptor.idPattern !== '^[0-9]{10}$'
        || !Array.isArray(descriptor.outFields) || descriptor.outFields.length !== 1 || descriptor.outFields[0] !== 'parcel_id'
        || descriptor.requestProperties !== true || !Array.isArray(districts) || !districts.length
        || districts.length > 9 || new Set(districts).size !== districts.length
        || districts.some(code => !/^01\d{3}$/.test(code))) throw new Error('Invalid e-gazar district descriptor.');
    let cached, pending, expires = 0;
    async function children() {
        if (cached && Date.now() < expires) return cached;
        if (!pending) pending = (async () => {
            const url = new URL(descriptor.endpoint);
            url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetCapabilities' });
            const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(descriptor.timeoutMs ?? 45000),
                redirect: 'error', cache: 'no-store', headers: { Accept: 'application/xml, text/xml' } });
            if (!response.ok) throw providerHttpError(response);
            const reader = response.body?.getReader();
            if (!reader) throw upstreamError('E-gazar omitted its capabilities body.');
            const chunks = []; let bytes = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > 16 * 1024 * 1024) throw upstreamError('E-gazar capabilities exceeded the byte limit.');
                    chunks.push(value);
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            const layers = resolveEgazarLayers(new TextDecoder().decode(concatBytes(chunks)), districts);
            cached = new Map([...layers].map(([district, featureType]) => [district, createWfsSource({ ...descriptor,
                layerProfile: undefined, featureType, idPrefix: `${descriptor.idPrefix}${district}-` }, { fetchImpl })]));
            expires = Date.now() + 5 * 60 * 1000;
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    }
    function collection(features, extra = {}) {
        if (features.length > (descriptor.maxFeatures ?? 3000)) throw upstreamError('E-gazar query exceeds the combined parcel limit.');
        return { type: 'FeatureCollection', features, complete: true, sourceId: descriptor.id, returnsWGS84: true, ...extra };
    }
    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 2, descriptor);
        const features = [];
        for (const child of (await children()).values()) {
            const result = await child.queryBounds(bounds);
            if (result.complete !== true) throw upstreamError('E-gazar district query is incomplete.');
            features.push(...result.features);
        }
        return collection(features);
    }
    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const groups = new Map();
        for (const id of new Set(ids)) {
            const match = typeof id === 'string' && /^MN-EGAZAR-(\d{5})-\d{10}$/.exec(id);
            if (!match || !districts.includes(match[1])) throw new HttpError(400, 'Invalid e-gazar district parcel ID.');
            if (!groups.has(match[1])) groups.set(match[1], []);
            groups.get(match[1]).push(id);
        }
        const resolved = await children(), features = [], absentIds = [];
        for (const [district, batch] of groups) {
            const result = await resolved.get(district).queryIds(batch);
            if (result.complete !== true) throw upstreamError('E-gazar exact-ID query is incomplete.');
            features.push(...result.features); absentIds.push(...result.absentIds);
        }
        return collection(features, { absentIds });
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const result = await queryBounds(geometryBbox(geometry));
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, geometry)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
