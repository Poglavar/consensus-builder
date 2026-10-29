// Cheongju's anonymous MapMoa WFS: double-escaped XML filters, native PNU strings and full GML polygons.
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects, feature as turfFeature } from '@turf/turf';
import { CHEONGJU_GML_SCHEMA, parseGmlParcels } from './gml-parcel-reader.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, areaLimitError, validateBounds, validateGeometry } from './source-contract.js';

export const CHEONGJU_ENDPOINT = 'https://map.cheongju.go.kr/getWfs.do';
const PREFIX = 'KR-CHEONGJU-PNU-';
const PNU = /^[0-9]{19}$/;
const badQuery = () => Object.assign(new Error('Invalid MapMoa parcel query.'), { status: 400 });

// JavaScript escape(), rather than encodeURIComponent(), is the publisher's transport contract.
// Every character here is ASCII; reject arbitrary text instead of implementing legacy %u encoding.
export function mapmoaQueryUrl(filter, limit) {
    const inner = `SERVICE=WFS&VERSION=1.1.0&SRSNAME=EPSG:5186&REQUEST=GetFeature&TYPENAME=LSMD_CONT_LDREG&PROPERTYNAME=PNU,G2_SPATIAL&MAXFEATURES=${limit}&FILTER=<ogc:Filter>${filter}</ogc:Filter>`;
    if (/[^\x20-\x7e]/.test(inner)) throw badQuery();
    const escapeAscii = text => text.replace(/[^A-Za-z0-9@*_+./-]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${CHEONGJU_ENDPOINT}?${escapeAscii(escapeAscii(inner))}`;
}

export function createCheongjuMapmoaParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const maxBytes = descriptor.maxResponseBytes ?? 2 * 1024 * 1024;
    const maxFeatures = descriptor.maxFeatures ?? 1000;
    const maxKm2 = descriptor.maxBboxKm2 ?? 0.25;
    if (descriptor.id !== 'kr-cheongju-mapmoa-cadastral-wfs' || descriptor.adapter !== 'cheongju-mapmoa'
        || descriptor.endpoint !== CHEONGJU_ENDPOINT || descriptor.idPrefix !== PREFIX
        || descriptor.featureType !== 'LSMD_CONT_LDREG' || descriptor.version !== '1.1.0'
        || descriptor.sourceCrs !== 'EPSG:5186' || descriptor.idField !== 'PNU' || descriptor.idType !== 'string'
        || descriptor.geometryField !== 'G2_SPATIAL' || descriptor.parcelNumberField !== 'PNU'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'PNU'
        || typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 2 * 1024 * 1024
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 2 || maxFeatures > 2000
        || !Number.isFinite(maxKm2) || maxKm2 <= 0 || maxKm2 > 0.25) throw new Error('Invalid MapMoa source descriptor.');
    const projection = proj4('EPSG:4326', 'EPSG:5186');
    const result = features => ({ type: 'FeatureCollection', features, sourceId: descriptor.id,
        returnsWGS84: true, complete: true, areaComplete: false, authoritativeAbsence: false });

    async function read(filter, limit, options) {
        const timeout = AbortSignal.timeout(30000);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await fetchImpl(mapmoaQueryUrl(filter, limit), { credentials: 'omit', redirect: 'error', cache: 'no-store',
            signal, headers: { Accept: 'text/xml' } });
        if (!response.ok) { await response.body?.cancel(); throw providerHttpError(response); }
        if (Number(response.headers.get('content-length')) > maxBytes) {
            await response.body?.cancel(); throw upstreamError('MapMoa response exceeds the byte limit.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('MapMoa response has no readable body.');
        const chunks = [];
        let bytes = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > maxBytes) throw upstreamError('MapMoa response exceeds the byte limit.');
                chunks.push(chunk.value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const parsed = await parseGmlParcels(concatBytes(chunks, bytes), { schema: CHEONGJU_GML_SCHEMA,
            maxBytes, maxFeatures: limit, signal });
        // WFS1.1 numberOfFeatures counts returned rows, not all matches. A capped read is never complete.
        if (parsed.featureCount >= limit || parsed.duplicateNativeCount) throw areaLimitError('MapMoa reached a transfer cap or returned duplicate PNU rows; request a smaller area.');
        return parsed.features.map(feature => {
            if (!PNU.test(feature.id)) throw upstreamError('MapMoa returned an invalid PNU.');
            return canonicalParcelFeature(descriptor, feature, feature.id);
        });
    }

    async function queryIds(ids, options = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(PREFIX) || !PNU.test(id.slice(PREFIX.length)))) throw badQuery();
        const features = [], unresolvedIds = [];
        const budget = AbortSignal.timeout(120000);
        const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
        for (const id of ids) {
            const filter = `<ogc:PropertyIsEqualTo><ogc:PropertyName>PNU</ogc:PropertyName><ogc:Literal>${id.slice(PREFIX.length)}</ogc:Literal></ogc:PropertyIsEqualTo>`;
            const rows = await read(filter, 2, { signal });
            if (rows.some(row => row.id !== id)) throw upstreamError('MapMoa ignored the exact PNU filter.');
            if (!rows.length) unresolvedIds.push(id);
            features.push(...rows);
        }
        return { ...result(features), complete: !unresolvedIds.length, absentIds: [], unresolvedIds };
    }

    async function queryBounds(bounds, options = {}) {
        validateBounds(bounds, maxKm2);
        const [w, s, e, n] = bounds;
        // Densify only the query perimeter; returned source rings are never simplified, clipped or repaired.
        const corners = [[w,s],[e,s],[e,n],[w,n],[w,s]], ring = [];
        for (let side = 0; side < 4; side++) for (let step = 0; step < 16; step++) {
            const t = step / 16, a = corners[side], b = corners[side + 1];
            ring.push(projection.forward([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
        }
        ring.push(ring[0]);
        const polygon = `<gml:Polygon srsName="EPSG:5186"><gml:exterior><gml:LinearRing><gml:posList>${ring.flat().join(' ')}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`;
        const rows = await read(`<ogc:Intersects><ogc:PropertyName>G2_SPATIAL</ogc:PropertyName>${polygon}</ogc:Intersects>`, maxFeatures, options);
        const footprint = bboxPolygon(bounds);
        // Detect a broad ignored filter; retain each complete source polygon even when it extends outside the query.
        if (rows.some(row => !booleanIntersects(bboxPolygon(bbox(row)), footprint))) throw upstreamError('MapMoa ignored the bounded spatial filter.');
        return result(rows.filter(row => booleanIntersects(row, footprint)));
    }

    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw badQuery();
        const footprint = turfFeature(geometry);
        const read = await queryBounds(bbox(footprint), options);
        return { ...read, features: read.features.filter(row => booleanIntersects(row, footprint)) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
