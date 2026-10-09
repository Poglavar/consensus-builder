// Strict bounded WFS2 reader for explicitly verified municipal cadastral profiles.
import { bbox as geometryBbox, booleanIntersects, bboxPolygon, feature as geoFeature } from '@turf/turf';
import proj4 from 'proj4';
import { HttpError } from '../utils/helpers.js';
import { MAPSERVER_GML_SCHEMA, SAXONY_GML_SCHEMA, POZNAN_GML_SCHEMA, NORWAY_TEIG_GML_SCHEMA, FINLAND_CP_GML_SCHEMA, parseGmlParcels } from './gml-parcel-reader.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const FES_NS = 'http://www.opengis.net/fes/2.0';
const PROFILES = Object.freeze({
    'lodz-gml-wfs': Object.freeze({
        endpoint: 'https://igeodeta.log.lodz.pl/cgi-bin/lodz-egib',
        typeName: 'ms:dzialki', idField: 'ID_DZIALKI', geometryField: 'msGeometry',
        featureNamespace: MAPSERVER_GML_SCHEMA.featureNamespace, idPrefix: 'PL-LODZ-',
        responseCrs: 'EPSG:3857', responseCrsUrn: 'urn:ogc:def:crs:EPSG::3857',
        propertyName: 'ms:ID_DZIALKI,ms:msGeometry', sortBy: 'ms:ID_DZIALKI', namespaces: undefined,
        schema: MAPSERVER_GML_SCHEMA
    }),
    'dresden-saxony-gml-wfs': Object.freeze({
        endpoint: 'https://geodienste.sachsen.de/aaa/public_alkis/vereinf/wfs',
        typeName: 'ave:Flurstueck', idField: 'flstkennz', geometryField: 'geometrie',
        featureNamespace: SAXONY_GML_SCHEMA.featureNamespace, idPrefix: 'DE-SN-',
        responseCrs: 'EPSG:25833', responseCrsUrn: 'urn:ogc:def:crs:EPSG::25833',
        propertyName: 'ave:flstkennz,ave:geometrie', sortBy: 'ave:flstkennz A',
        namespaces: `xmlns(ave,${SAXONY_GML_SCHEMA.featureNamespace})`, schema: SAXONY_GML_SCHEMA
    }),
    'poznan-gml-wfs': Object.freeze({
        endpoint: 'https://portal.geopoz.poznan.pl/wmsegib',
        typeName: 'ms:dzialki', idField: 'ID_DZIALKI', geometryField: 'MSGEOMETRY',
        featureNamespace: POZNAN_GML_SCHEMA.featureNamespace, idPrefix: 'PL-POZNAN-',
        responseCrs: 'EPSG:2177', responseCrsUrn: 'urn:ogc:def:crs:EPSG::2177',
        propertyName: 'ms:ID_DZIALKI,ms:MSGEOMETRY', sortBy: undefined, namespaces: undefined,
        schema: POZNAN_GML_SCHEMA
    }),
    // Kartverket's public Teig endpoint supports the observed WFS 2.0 RESOURCEID
    // semantics and narrowly documented numberReturned=0 data-page quirk; the
    // profile remains pending runtime qualification. Do not switch to an
    // attribute filter: it returned empty results for a known teigId.
    'no-teig-gml-wfs': Object.freeze({
        endpoint: 'https://wfs.geonorge.no/skwms1/wfs.matrikkelen-eiendomskart-teig',
        typeName: 'app:Teig', idField: 'teigId', geometryField: 'område',
        featureNamespace: NORWAY_TEIG_GML_SCHEMA.featureNamespace, idPrefix: 'NO-TEIG-',
        responseCrs: 'EPSG:25833', responseCrsUrn: 'urn:ogc:def:crs:EPSG::25833',
        propertyName: 'app:identTeig/app:teigId,app:område', sortBy: undefined, namespaces: undefined,
        resourceIdPrefix: NORWAY_TEIG_GML_SCHEMA.gmlIdPrefix, schema: NORWAY_TEIG_GML_SCHEMA
    }),
    'fi-inspire-cp-wfs': Object.freeze({
        endpoint: 'https://inspire-wfs.maanmittauslaitos.fi/inspire-wfs/cp/wfs',
        typeName: 'cp:CadastralParcel', idField: 'localId', geometryField: 'geometry',
        featureNamespace: FINLAND_CP_GML_SCHEMA.featureNamespace, idPrefix: FINLAND_CP_GML_SCHEMA.canonicalIdPrefix,
        responseCrs: 'EPSG:3067', responseCrsUrn: 'urn:ogc:def:crs:EPSG::3067',
        propertyName: undefined, sortBy: undefined, namespaces: undefined,
        resourceIdPrefix: FINLAND_CP_GML_SCHEMA.gmlIdPrefix, bboxKvp: true, schema: FINLAND_CP_GML_SCHEMA
    })
});
const MAX_OPERATION_MS = 60000;
const MAX_OPERATION_REQUESTS = 128;
const MAX_ID_BATCH_SIZE = 8;
const WGS84 = 'EPSG:4326';

function fail(message, status = 502) { throw upstreamError(message, status); }
function safeNativeId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value); }
function newOperationBudget() { return { deadline: Date.now() + MAX_OPERATION_MS, requests: 0, bytes: 0 }; }

function validateDescriptor(descriptor) {
    const profile = descriptor && PROFILES[descriptor.id];
    return profile && descriptor.adapter === 'gml-wfs'
        && descriptor.endpoint === profile.endpoint && descriptor.featureType === profile.typeName
        && descriptor.idField === profile.idField && descriptor.geometryField === profile.geometryField
        && descriptor.idPrefix === profile.idPrefix && descriptor.idType === 'string'
        && descriptor.parcelNumberField === profile.idField
        && Array.isArray(descriptor.outFields) && descriptor.outFields.length === 1 && descriptor.outFields[0] === profile.idField
        && descriptor.responseCrs === profile.responseCrs
        && (descriptor.maxBboxKm2 === undefined || (Number.isFinite(descriptor.maxBboxKm2) && descriptor.maxBboxKm2 > 0 && descriptor.maxBboxKm2 <= 25))
        && (descriptor.maxFeatures === undefined || (Number.isSafeInteger(descriptor.maxFeatures) && descriptor.maxFeatures > 0 && descriptor.maxFeatures <= 5000))
        && (descriptor.pageSize === undefined || (Number.isSafeInteger(descriptor.pageSize) && descriptor.pageSize > 0 && descriptor.pageSize <= 100))
        && (descriptor.maxResponseBytes === undefined || (Number.isSafeInteger(descriptor.maxResponseBytes) && descriptor.maxResponseBytes > 0 && descriptor.maxResponseBytes <= 2 * 1024 * 1024))
        && (descriptor.maxTotalResponseBytes === undefined || (Number.isSafeInteger(descriptor.maxTotalResponseBytes) && descriptor.maxTotalResponseBytes > 0 && descriptor.maxTotalResponseBytes <= 16 * 1024 * 1024))
        && (descriptor.timeoutMs === undefined || (Number.isSafeInteger(descriptor.timeoutMs) && descriptor.timeoutMs >= 100 && descriptor.timeoutMs <= 30000))
        && Math.ceil((descriptor.maxFeatures ?? 1500) / (descriptor.pageSize ?? 50)) + 2 <= MAX_OPERATION_REQUESTS;
}

function projectedBounds(wgs84Bounds, profile) {
    const [west, south, east, north] = wgs84Bounds;
    if (profile.responseCrs === 'EPSG:3857' && (south < -85.0511287798066 || north > 85.0511287798066)) fail('Parcel WFS query bounds exceed EPSG:3857 coverage.');
    const points = [];
    for (let step = 0; step <= 16; step++) {
        const t = step / 16;
        points.push([west + (east - west) * t, south], [west + (east - west) * t, north]);
        points.push([west, south + (north - south) * t], [east, south + (north - south) * t]);
    }
    const project = proj4(WGS84, profile.responseCrs);
    const projected = points.map(point => project.forward(point));
    if (projected.some(point => !Array.isArray(point) || !point.slice(0, 2).every(Number.isFinite))) {
        fail('Parcel WFS query bounds could not be projected.');
    }
    return [
        Math.min(...projected.map(point => point[0])), Math.min(...projected.map(point => point[1])),
        Math.max(...projected.map(point => point[0])), Math.max(...projected.map(point => point[1]))
    ];
}

function exactIdFilter(ids, profile) {
    const comparisons = ids.map(id => `<fes:PropertyIsEqualTo><fes:ValueReference>${profile.typeName.split(':')[0]}:${profile.idField}</fes:ValueReference><fes:Literal>${id}</fes:Literal></fes:PropertyIsEqualTo>`);
    const prefix = profile.typeName.split(':')[0];
    return `<fes:Filter xmlns:fes="${FES_NS}" xmlns:${prefix}="${profile.featureNamespace}">${comparisons.length === 1 ? comparisons[0] : `<fes:Or>${comparisons.join('')}</fes:Or>`}</fes:Filter>`;
}

function intersectsFilter([west, south, east, north], profile) {
    const ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
        .flatMap(([x, y]) => profile.schema.axisOrder === 'northing-easting' ? [y, x] : [x, y]).join(' ');
    const prefix = profile.typeName.split(':')[0];
    const gmlPrefix = 'gml';
    return `<fes:Filter xmlns:fes="${FES_NS}" xmlns:${prefix}="${profile.featureNamespace}" xmlns:${gmlPrefix}="${profile.schema.gmlNamespace}"><fes:Intersects><fes:ValueReference>${prefix}:${profile.geometryField}</fes:ValueReference><gml:Polygon srsName="${profile.responseCrsUrn}"><gml:exterior><gml:LinearRing><gml:posList srsDimension="2">${ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></fes:Intersects></fes:Filter>`;
}

export function createGmlWfsParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    if (!validateDescriptor(descriptor) || typeof fetchImpl !== 'function') throw new Error('Invalid GML WFS parcel source descriptor.');
    const pageSize = descriptor.pageSize ?? 50;
    const maxFeatures = descriptor.maxFeatures ?? 1500;
    const maxResponseBytes = descriptor.maxResponseBytes ?? 1024 * 1024;
    const maxTotalResponseBytes = descriptor.maxTotalResponseBytes ?? 8 * 1024 * 1024;
    const timeoutMs = descriptor.timeoutMs ?? 12000;
    const profile = PROFILES[descriptor.id];

    function makeParams({ filter, resourceIds, bbox, resultType, count, startIndex }) {
        return new URLSearchParams({
            service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: profile.typeName,
            srsName: profile.responseCrsUrn, outputFormat: 'application/gml+xml; version=3.2',
            ...(profile.propertyName ? { propertyName: profile.propertyName } : {}),
            ...(profile.namespaces ? { namespaces: profile.namespaces } : {}),
            ...(resourceIds?.length ? { RESOURCEID: resourceIds.join(',') } : {}),
            ...(bbox ? { bbox } : {}),
            ...(filter ? { filter } : {}), ...(resultType ? { resultType } : {}),
            ...(count !== undefined ? { count: String(count) } : {}),
            ...(startIndex !== undefined ? { startIndex: String(startIndex) } : {}),
            ...(profile.sortBy ? { sortBy: profile.sortBy } : {})
        });
    }

    async function readBody(response, budget) {
        const declared = response.headers?.get?.('content-length');
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes
            || budget.bytes + Number(declared) > maxTotalResponseBytes)) fail('Parcel WFS response exceeds the configured byte limit.');
        const chunks = [];
        let reader, size = 0;
        try {
            if (response.body?.getReader) {
                reader = response.body.getReader();
                for (;;) {
                    const item = await reader.read();
                    if (item.done) break;
                    if (Date.now() >= budget.deadline) fail('Parcel WFS operation timed out.', 504);
                    size += item.value.byteLength;
                    if (size > maxResponseBytes || budget.bytes + size > maxTotalResponseBytes) {
                        try { await reader.cancel(); } catch { /* Stream may already be closed. */ }
                        fail('Parcel WFS response exceeds the configured byte limit.');
                    }
                    chunks.push(item.value);
                }
            } else {
                const bytes = new Uint8Array(await response.arrayBuffer());
                size = bytes.byteLength;
                if (Date.now() >= budget.deadline) fail('Parcel WFS operation timed out.', 504);
                if (size > maxResponseBytes || budget.bytes + size > maxTotalResponseBytes) fail('Parcel WFS response exceeds the configured byte limit.');
                chunks.push(bytes);
            }
            if (declared && !response.headers.get('content-encoding') && Number(declared) !== size) fail('Parcel WFS response body is incomplete.');
            budget.bytes += size;
            const result = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
            return new TextDecoder('utf-8', { fatal: true }).decode(result);
        } catch (error) {
            if (error.status) throw error;
            fail('Parcel WFS returned an invalid or incomplete XML response.');
        } finally { reader?.releaseLock(); }
    }

    async function request(params, budget) {
        const remaining = budget.deadline - Date.now();
        if (remaining <= 0) fail('Parcel WFS operation timed out.', 504);
        if (++budget.requests > MAX_OPERATION_REQUESTS) fail('Parcel WFS operation exceeds the request limit.');
        const signal = AbortSignal.timeout(Math.min(timeoutMs, remaining));
        try {
            const response = await fetchImpl(`${profile.endpoint}?${params}`, {
                signal, redirect: 'error', headers: { Accept: 'application/gml+xml; version=3.2, application/xml, text/xml' }
            });
            if (Date.now() >= budget.deadline || signal.aborted) fail('Parcel WFS operation timed out.', 504);
            if (!response.ok) throw providerHttpError(response);
            const contentType = response.headers?.get?.('content-type') || '';
            if (contentType && !/(?:xml|gml)/i.test(contentType)) fail('Parcel WFS returned a non-XML response.');
            const body = await readBody(response, budget);
            if (Date.now() >= budget.deadline || signal.aborted) fail('Parcel WFS operation timed out.', 504);
            return body;
        } catch (error) {
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) fail('Parcel WFS request timed out.', 504);
            fail('Parcel WFS is unavailable.');
        }
    }

    async function hitCount(spec, budget) {
        const body = await request(makeParams({ ...spec, resultType: 'hits' }), budget);
        const parsed = await parseGmlParcels(body, { schema: profile.schema, maxBytes: maxResponseBytes, maxFeatures: 1 });
        if (Date.now() >= budget.deadline) fail('Parcel WFS operation timed out.', 504);
        if (parsed.numberMatched === undefined || parsed.numberReturned !== 0 || parsed.featureCount !== 0) fail('Parcel WFS did not provide a complete hit count.');
        return parsed.numberMatched;
    }

    async function readComplete(spec, exactIds = null, budget = newOperationBudget()) {
        const matchedBefore = await hitCount(spec, budget);
        const matched = matchedBefore;
        if (matched > maxFeatures) fail('Parcel WFS query exceeds the configured parcel limit.');
        const byNativeId = new Map();
        let rows = 0, duplicateNativeCount = 0;
        for (let startIndex = 0; startIndex < matched; startIndex += pageSize) {
            const count = Math.min(pageSize, matched - startIndex);
            const body = await request(makeParams({ ...spec, count, startIndex }), budget);
            const parsed = await parseGmlParcels(body, { schema: profile.schema, maxBytes: maxResponseBytes, maxFeatures: count });
            if (Date.now() >= budget.deadline) fail('Parcel WFS operation timed out.', 504);
            const pageMatchCountValid = parsed.numberMatchedUnknown || (parsed.numberMatched !== undefined && parsed.numberMatched === matched);
            if (!pageMatchCountValid || parsed.numberReturned !== count || parsed.featureCount !== count) fail('Parcel WFS page counts do not match the complete query.');
            if (parsed.duplicateNativeCount) fail('Parcel WFS page repeated a native parcel identity.');
            rows += parsed.featureCount;
            duplicateNativeCount += parsed.duplicateNativeCount;
            for (const feature of parsed.features) {
                const nativeId = feature.id;
                if (!safeNativeId(nativeId) || (exactIds && !exactIds.has(nativeId))) fail('Parcel WFS returned an unexpected native parcel identity.');
                const previous = byNativeId.get(nativeId);
                if (previous) {
                    if (JSON.stringify(previous.geometry) !== JSON.stringify(feature.geometry)) fail('Parcel WFS returned conflicting geometry for one parcel identity.');
                    fail('Parcel WFS repeated a native parcel identity across pages.');
                }
                byNativeId.set(nativeId, feature);
            }
        }
        if (rows !== matched) fail('Parcel WFS query did not return its complete matched set.');
        if (byNativeId.size !== rows) fail('Parcel WFS query returned repeated native identities.');
        const matchedAfter = await hitCount(spec, budget);
        if (matchedAfter !== matchedBefore) fail('Parcel WFS match count changed during the query.');
        return { features: [...byNativeId.values()].map(feature => canonicalParcelFeature(descriptor, feature, feature.id)),
            complete: true, sourceId: descriptor.id, returnsWGS84: true, numberMatched: matched, duplicateNativeCount };
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 1, descriptor);
        const bbox = projectedBounds(bounds, profile);
        const result = await readComplete(profile.bboxKvp
            ? { bbox: `${bbox.join(',')},${profile.responseCrs}` }
            : { filter: intersectsFilter(bbox, profile) });
        const shape = bboxPolygon(bounds);
        result.features = result.features.filter(feature => booleanIntersects(feature, shape));
        return result;
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        if (unique.some(id => typeof id !== 'string' || !id.startsWith(descriptor.idPrefix)
            || !safeNativeId(id.slice(descriptor.idPrefix.length))
            || (profile.resourceIdPrefix && !/^(?:0|[1-9]\d*)$/.test(id.slice(descriptor.idPrefix.length))))) {
            throw new HttpError(400, 'Invalid parcel ID or different source.');
        }
        const budget = newOperationBudget();
        const features = [], absentIds = [], foundNativeIds = new Set();
        let numberMatched = 0, duplicateNativeCount = 0;
        for (let offset = 0; offset < unique.length; offset += MAX_ID_BATCH_SIZE) {
            const batchIds = unique.slice(offset, offset + MAX_ID_BATCH_SIZE);
            const nativeIds = batchIds.map(id => id.slice(descriptor.idPrefix.length));
            const spec = profile.resourceIdPrefix
                ? { resourceIds: nativeIds.map(id => `${profile.resourceIdPrefix}${id}`) }
                : { filter: exactIdFilter(nativeIds, profile) };
            const result = await readComplete(spec, new Set(nativeIds), budget);
            const found = new Set(result.features.map(feature => feature.properties.sourceParcelId));
            for (const feature of result.features) {
                const nativeId = feature.properties.sourceParcelId;
                if (foundNativeIds.has(nativeId)) fail('Parcel WFS repeated a native parcel identity across ID batches.');
                foundNativeIds.add(nativeId);
                features.push(feature);
            }
            absentIds.push(...batchIds.filter(id => !found.has(id.slice(descriptor.idPrefix.length))));
            numberMatched += result.numberMatched;
            duplicateNativeCount += result.duplicateNativeCount;
        }
        return { features, absentIds, complete: true, sourceId: descriptor.id, returnsWGS84: true, numberMatched, duplicateNativeCount };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide valid polygon geometry.');
        const result = await queryBounds(geometryBbox(geometry));
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, geoFeature(geometry))) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
