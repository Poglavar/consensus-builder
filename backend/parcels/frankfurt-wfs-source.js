// Bounded Frankfurt cadastral WFS reader. Only the native FSK/OBJECTID and geometry leave this module.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import proj4 from 'proj4';
import { SaxesParser } from 'saxes';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const ENDPOINT = 'https://geowebdienste.frankfurt.de/SGK_Flurstuecke';
const FEATURE_TYPE = 'Amt62_Flurstuecke:Flurstueck';
const WFS_NS = 'http://www.opengis.net/wfs/2.0';
const FES_NS = 'http://www.opengis.net/fes/2.0';
const NATIVE_CRS = 'EPSG:25832';
const NATIVE_CRS_URN = 'urn:ogc:def:crs:EPSG::25832';
const PROPERTY_NAME = 'SHAPE,FSK,OBJECTID';
const SAFE_PROPERTIES = new Set(['GmlID', 'FSK', 'OBJECTID']);
const MAX_OPERATION_MS = 60000;
const MAX_OPERATION_REQUESTS = 3200;
const WGS84_PROJ = '+proj=longlat +datum=WGS84 +no_defs +type=crs';
const NATIVE_PROJ = '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs +type=crs';

// Local definitions avoid mutating proj4's global registry when this adapter is imported.
const fromWgs84 = proj4(WGS84_PROJ, NATIVE_PROJ);
const toWgs84 = proj4(NATIVE_PROJ, WGS84_PROJ);

function fail(message, status = 502) {
    throw upstreamError(message, status);
}

function xmlAttribute(tag, name) {
    return Object.values(tag.attributes).find(attribute => attribute.local === name && !attribute.uri)?.value;
}

function parseHitCount(xml) {
    const parser = new SaxesParser({ xmlns: true });
    let rootSeen = false, rootClosed = false, depth = 0, matched, returned;
    const bad = () => fail('Frankfurt WFS returned an invalid hit count.');
    parser.on('doctype', bad);
    parser.on('error', bad);
    parser.on('opentag', tag => {
        depth++;
        if (depth !== 1 || tag.uri !== WFS_NS || tag.local !== 'FeatureCollection' || rootSeen) return bad();
        rootSeen = true;
        const matchedText = xmlAttribute(tag, 'numberMatched');
        const returnedText = xmlAttribute(tag, 'numberReturned');
        if (!/^(?:0|[1-9][0-9]*)$/.test(matchedText || '') || !/^(?:0|[1-9][0-9]*)$/.test(returnedText || '')) return bad();
        matched = Number(matchedText);
        returned = Number(returnedText);
        if (!Number.isSafeInteger(matched) || !Number.isSafeInteger(returned) || returned !== 0) return bad();
    });
    parser.on('text', value => { if (value.trim()) bad(); });
    parser.on('cdata', bad);
    parser.on('closetag', tag => {
        if (depth !== 1 || tag.uri !== WFS_NS || tag.local !== 'FeatureCollection') return bad();
        depth--;
        rootClosed = true;
    });
    try { parser.write(xml).close(); }
    catch (error) { if (error.status) throw error; return fail('Frankfurt WFS returned malformed hit-count XML.'); }
    if (!rootSeen || !rootClosed || depth !== 0) return fail('Frankfurt WFS returned incomplete hit-count XML.');
    return matched;
}

function isNativeCrs(value) {
    return ['EPSG:25832', 'urn:ogc:def:crs:EPSG::25832', 'http://www.opengis.net/def/crs/EPSG/0/25832'].includes(value);
}

function nativeBounds(wgs84Bounds) {
    const [west, south, east, north] = wgs84Bounds;
    const points = [];
    // Densify all four sides so the projected envelope also encloses curved edges.
    for (let step = 0; step <= 16; step++) {
        const t = step / 16;
        points.push([west + (east - west) * t, south], [west + (east - west) * t, north]);
        points.push([west, south + (north - south) * t], [east, south + (north - south) * t]);
    }
    const projected = points.map(point => fromWgs84.forward(point));
    if (projected.some(point => !Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite))) {
        fail('Frankfurt WFS query bounds could not be projected.');
    }
    return [
        Math.min(...projected.map(point => point[0])), Math.min(...projected.map(point => point[1])),
        Math.max(...projected.map(point => point[0])), Math.max(...projected.map(point => point[1]))
    ];
}

function transformGeometry(geometry, crs) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) {
        fail('Frankfurt WFS returned a missing or unsupported parcel geometry.');
    }
    const projectPoint = point => {
        if (!Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
            fail('Frankfurt WFS returned invalid parcel coordinates.');
        }
        const projected = isNativeCrs(crs) ? toWgs84.forward(point) : point;
        if (!Array.isArray(projected) || projected.length < 2 || !projected.slice(0, 2).every(Number.isFinite)) {
            fail('Frankfurt WFS returned invalid projected parcel coordinates.');
        }
        return projected.slice(0, 2);
    };
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!polygons.length || polygons.some(polygon => !Array.isArray(polygon) || !polygon.length)) {
        fail('Frankfurt WFS returned an empty parcel geometry.');
    }
    const coordinates = polygons.map(polygon => polygon.map(ring => {
        if (!Array.isArray(ring)) fail('Frankfurt WFS returned invalid parcel rings.');
        return ring.map(projectPoint);
    }));
    const result = { type: geometry.type, coordinates: geometry.type === 'Polygon' ? coordinates[0] : coordinates };
    if (!validateGeometry(result)) fail('Frankfurt WFS returned invalid parcel polygon geometry.');
    return result;
}

function validNativeId(value) {
    // FSK values are fixed-width cadastral keys: digits with optional trailing underscore placeholders.
    return typeof value === 'string' && value.length >= 14 && value.length <= 20 && /^\d{14}[\d_]{0,6}$/.test(value);
}

function validateDescriptor(descriptor) {
    return descriptor && typeof descriptor.id === 'string' && descriptor.id.length > 0
        && descriptor.endpoint === ENDPOINT && descriptor.featureType === FEATURE_TYPE
        && descriptor.idField === 'FSK' && descriptor.idPrefix === 'DE-FFM-'
        && descriptor.idType === 'string' && descriptor.parcelNumberField === 'FSK'
        && Array.isArray(descriptor.outFields) && descriptor.outFields.length === 2
        && descriptor.outFields[0] === 'FSK' && descriptor.outFields[1] === 'OBJECTID'
        && (descriptor.maxBboxKm2 === undefined || (Number.isFinite(descriptor.maxBboxKm2) && descriptor.maxBboxKm2 > 0 && descriptor.maxBboxKm2 <= 1))
        && (descriptor.maxFeatures === undefined || (Number.isSafeInteger(descriptor.maxFeatures) && descriptor.maxFeatures > 0 && descriptor.maxFeatures <= 3000))
        && (descriptor.pageSize === undefined || (Number.isSafeInteger(descriptor.pageSize) && descriptor.pageSize > 0 && descriptor.pageSize <= 1000))
        && (descriptor.idBatchSize === undefined || (Number.isSafeInteger(descriptor.idBatchSize) && descriptor.idBatchSize > 0 && descriptor.idBatchSize <= 80))
        && (descriptor.maxResponseBytes === undefined || (Number.isSafeInteger(descriptor.maxResponseBytes) && descriptor.maxResponseBytes > 0 && descriptor.maxResponseBytes <= 8 * 1024 * 1024))
        && (descriptor.maxTotalResponseBytes === undefined || (Number.isSafeInteger(descriptor.maxTotalResponseBytes) && descriptor.maxTotalResponseBytes > 0 && descriptor.maxTotalResponseBytes <= 32 * 1024 * 1024))
        && (descriptor.timeoutMs === undefined || (Number.isSafeInteger(descriptor.timeoutMs) && descriptor.timeoutMs >= 100 && descriptor.timeoutMs <= 30000));
}

function fesFilterForIds(ids) {
    const equalities = ids.map(id => `<fes:PropertyIsEqualTo><fes:ValueReference>FSK</fes:ValueReference><fes:Literal>${id}</fes:Literal></fes:PropertyIsEqualTo>`);
    return `<fes:Filter xmlns:fes="${FES_NS}">${equalities.length === 1 ? equalities[0] : `<fes:Or>${equalities.join('')}</fes:Or>`}</fes:Filter>`;
}

export function createFrankfurtWfsParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (!validateDescriptor(descriptor) || typeof fetchImpl !== 'function') throw new Error('Invalid Frankfurt WFS parcel source descriptor.');
    const pageSize = descriptor.pageSize ?? 100;
    const maxFeatures = descriptor.maxFeatures ?? 3000;
    const maxResponseBytes = descriptor.maxResponseBytes ?? 8 * 1024 * 1024;
    const maxTotalResponseBytes = descriptor.maxTotalResponseBytes ?? 32 * 1024 * 1024;
    const timeoutMs = descriptor.timeoutMs ?? 15000;
    const idBatchSize = descriptor.idBatchSize ?? 40;

    function makeParams({ bbox, filter, resultType, outputFormat, count, startIndex }) {
        return new URLSearchParams({
            service: 'WFS', version: '2.0.0', request: 'GetFeature',
            typenames: FEATURE_TYPE, srsName: NATIVE_CRS_URN,
            outputFormat, propertyName: PROPERTY_NAME,
            ...(bbox ? { bbox: `${bbox.join(',')},${NATIVE_CRS_URN}` } : {}),
            ...(filter ? { filter } : {}),
            ...(resultType ? { resultType } : {}),
            ...(count !== undefined ? { count: String(count) } : {}),
            ...(startIndex !== undefined ? { startIndex: String(startIndex) } : {})
        });
    }

    async function readResponse(response, budget) {
        const declared = response.headers?.get?.('content-length');
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes
            || budget.bytes + Number(declared) > maxTotalResponseBytes)) {
            fail('Frankfurt WFS response exceeds the configured byte limit.');
        }
        let reader;
        const chunks = [];
        let size = 0;
        try {
            if (response.body?.getReader) {
                reader = response.body.getReader();
                for (;;) {
                    const item = await reader.read();
                    if (item.done) break;
                    if (Date.now() >= budget.deadline) fail('Frankfurt WFS operation timed out.');
                    size += item.value.byteLength;
                    if (size > maxResponseBytes || budget.bytes + size > maxTotalResponseBytes) {
                        try { await reader.cancel(); } catch { /* Stream may already be closed. */ }
                        fail('Frankfurt WFS response exceeds the configured byte limit.');
                    }
                    chunks.push(Buffer.from(item.value));
                }
            } else {
                const bytes = Buffer.from(await response.arrayBuffer());
                if (Date.now() >= budget.deadline) fail('Frankfurt WFS operation timed out.');
                size = bytes.byteLength;
                if (size > maxResponseBytes || budget.bytes + size > maxTotalResponseBytes) fail('Frankfurt WFS response exceeds the configured byte limit.');
                chunks.push(bytes);
            }
            if (declared && !response.headers.get('content-encoding') && Number(declared) !== size) {
                fail('Frankfurt WFS response body is incomplete.');
            }
            budget.bytes += size;
            return Buffer.concat(chunks, size).toString('utf8');
        } finally { reader?.releaseLock(); }
    }

    async function request(params, budget) {
        const remainingMs = budget.deadline - Date.now();
        if (remainingMs <= 0) throw upstreamError('Frankfurt WFS operation timed out.', 504);
        budget.requests++;
        if (budget.requests > MAX_OPERATION_REQUESTS) fail('Frankfurt WFS operation exceeds the request limit.');
        const signal = AbortSignal.timeout(Math.min(timeoutMs, remainingMs));
        try {
            const response = await fetchImpl(`${ENDPOINT}?${params}`, {
                signal, redirect: 'error', headers: { Accept: 'application/geo+json, application/json, application/xml, text/xml' }
            });
            if (Date.now() >= budget.deadline || signal.aborted) throw new DOMException('Frankfurt WFS operation timed out.', 'TimeoutError');
            if (!response.ok) throw providerHttpError(response);
            const body = await readResponse(response, budget);
            if (Date.now() >= budget.deadline || signal.aborted) throw new DOMException('Frankfurt WFS operation timed out.', 'TimeoutError');
            return { body, contentType: response.headers?.get?.('content-type') || '' };
        } catch (error) {
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) throw upstreamError('Frankfurt WFS timed out.', 504);
            throw upstreamError('Frankfurt WFS is unavailable.');
        }
    }

    async function queryHits(spec, budget) {
        const params = makeParams({ ...spec, resultType: 'hits', outputFormat: 'GML32' });
        const { body, contentType } = await request(params, budget);
        if (contentType && !/(?:xml|gml)/i.test(contentType)) fail('Frankfurt WFS returned a non-XML hit-count response.');
        return parseHitCount(body);
    }

    function readFeatureCollection(payload, expectedCount, totalMatched, seenGmlIds, seenObjectIds, seenFsks, previousObjectId, exactIdSet) {
        if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
            fail('Frankfurt WFS returned an invalid GeoJSON FeatureCollection.');
        }
        const crsName = payload.crs?.type === 'name' ? payload.crs.properties?.name : null;
        if (!isNativeCrs(crsName)) fail('Frankfurt WFS omitted or changed its projected response CRS.');
        if (expectedCount !== undefined && payload.features.length !== expectedCount) fail('Frankfurt WFS returned an incomplete page.');
        if (payload.numberReturned !== undefined && payload.numberReturned !== payload.features.length) fail('Frankfurt WFS returned inconsistent page counts.');
        if (payload.numberMatched !== undefined && payload.numberMatched !== totalMatched) fail('Frankfurt WFS returned an inconsistent match count.');
        const result = [];
        let lastObjectId = previousObjectId;
        for (const feature of payload.features) {
            const props = feature?.properties;
            if (!props || Object.keys(props).some(key => !SAFE_PROPERTIES.has(key))) fail('Frankfurt WFS returned an unexpected parcel property.');
            const fsk = props.FSK;
            const objectId = props.OBJECTID;
            const gmlId = props.GmlID;
            if (!validNativeId(fsk) || !Number.isSafeInteger(objectId) || objectId < 0 || objectId > 2147483647
                || typeof gmlId !== 'string' || !/^Flurstueck\.(?:0|[1-9][0-9]*)$/.test(gmlId)
                || Number(gmlId.slice('Flurstueck.'.length)) !== objectId
                || (exactIdSet && !exactIdSet.has(fsk))) {
                fail('Frankfurt WFS returned a missing or wrong parcel identity.');
            }
            if (seenGmlIds.has(gmlId) || seenObjectIds.has(objectId) || seenFsks.has(fsk)
                || (lastObjectId !== null && objectId <= lastObjectId)) {
                fail('Frankfurt WFS repeated or reordered its paged parcel features.');
            }
            seenGmlIds.add(gmlId);
            seenObjectIds.add(objectId);
            seenFsks.add(fsk);
            lastObjectId = objectId;
            const geometry = transformGeometry(feature.geometry, crsName);
            const canonical = canonicalParcelFeature(descriptor, { ...feature, geometry }, fsk);
            result.push(canonical);
        }
        return { features: result, lastObjectId };
    }

    async function collect(spec, budget, exactIdSet = null) {
        const matched = await queryHits(spec, budget);
        if (matched > maxFeatures) throw new HttpError(400, 'Parcel provider query exceeds the feature limit; use a smaller area.');
        const all = [];
        const seenGmlIds = new Set();
        const seenObjectIds = new Set();
        const seenFsks = new Set();
        let lastObjectId = null;
        for (let offset = 0; offset < matched; offset += pageSize) {
            const expected = Math.min(pageSize, matched - offset);
            const params = makeParams({ ...spec, outputFormat: 'GEOJSON', count: pageSize, startIndex: offset });
            const { body, contentType } = await request(params, budget);
            if (contentType && !/(?:json|geo\+json)/i.test(contentType)) fail('Frankfurt WFS returned a non-GeoJSON parcel page.');
            let payload;
            try { payload = JSON.parse(body); }
            catch { fail('Frankfurt WFS returned malformed GeoJSON.'); }
            const page = readFeatureCollection(payload, expected, matched, seenGmlIds, seenObjectIds, seenFsks, lastObjectId, exactIdSet);
            lastObjectId = page.lastObjectId;
            all.push(...page.features);
            if (all.length > maxFeatures) fail('Frankfurt WFS exceeds the feature limit; use a smaller area.');
        }
        const after = await queryHits(spec, budget);
        if (after !== matched || all.length !== matched) fail('Frankfurt WFS match count changed or pages were incomplete.');
        return all;
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 1, descriptor);
        const native = nativeBounds(bounds);
        const budget = { bytes: 0, deadline: Date.now() + MAX_OPERATION_MS, requests: 0 };
        const features = await collect({ bbox: native }, budget);
        const [west, south, east, north] = bounds;
        const viewport = geoFeature({ type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });
        return { type: 'FeatureCollection', features: features.filter(parcel => booleanIntersects(parcel, viewport)), complete: true,
            sourceId: descriptor.id, returnsWGS84: true };
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const nativeIds = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(descriptor.idPrefix) || !validNativeId(value.slice(descriptor.idPrefix.length))) {
                throw new HttpError(400, 'Invalid Frankfurt parcel ID.');
            }
            return value.slice(descriptor.idPrefix.length);
        });
        const budget = { bytes: 0, deadline: Date.now() + MAX_OPERATION_MS, requests: 0 }, features = [], seenFsk = new Set();
        for (let offset = 0; offset < nativeIds.length; offset += idBatchSize) {
            const batch = nativeIds.slice(offset, offset + idBatchSize);
            const exact = await collect({ filter: fesFilterForIds(batch) }, budget, new Set(batch));
            for (const feature of exact) {
                const fsk = feature.properties.sourceParcelId;
                if (seenFsk.has(fsk)) fail('Frankfurt WFS returned a duplicate native parcel key.');
                seenFsk.add(fsk);
                features.push(feature);
            }
        }
        const present = new Set(features.map(feature => feature.properties.parcelId));
        return { type: 'FeatureCollection', features, complete: true, sourceId: descriptor.id, returnsWGS84: true,
            absentIds: unique.filter(id => !present.has(id)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
