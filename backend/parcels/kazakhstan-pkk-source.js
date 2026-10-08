// Astana's official public EGKN PKK parcel view, scoped to Esil district.
import proj4 from 'proj4';
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const ENDPOINT = 'https://map.gov4c.kz/geoserver/wfs';
const VIEWER = 'https://map.gov4c.kz/egkn/';
const FEATURE_TYPE = 'egkn:u_view';
const DISTRICT_ID = 254;
const SOURCE_CRS = 'EPSG:32642';
const SOURCE_CRS_URN = 'urn:ogc:def:crs:EPSG::32642';
const NATIVE_PATTERN = /^[0-9]{1,32}$/;
const MAX_ID_FILTER_TERMS = 20;
const OUT_FIELDS = ['gid', 'kad_nomer'];
const FES_NS = 'http://www.opengis.net/fes/2.0';
const USER_AGENT = 'Mozilla/5.0';
const toMetric = proj4('EPSG:4326', SOURCE_CRS);
const toWgs84 = proj4(SOURCE_CRS, 'EPSG:4326');

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function xml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function idFilter(codes) {
    const comparisons = codes.map(code => `<fes:PropertyIsEqualTo><fes:ValueReference>kad_nomer</fes:ValueReference><fes:Literal>${xml(code)}</fes:Literal></fes:PropertyIsEqualTo>`);
    const condition = comparisons.length === 1 ? comparisons[0] : `<fes:Or>${comparisons.join('')}</fes:Or>`;
    return `<fes:Filter xmlns:fes="${FES_NS}">${condition}</fes:Filter>`;
}

function transformCoordinates(value, transform, depth, coordinateDepth) {
    if (!Array.isArray(value) || !value.length) throw upstreamError('Astana PKK returned malformed coordinates.');
    if (depth === coordinateDepth) {
        if (value.length < 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
            throw upstreamError('Astana PKK returned malformed coordinates.');
        }
        const point = transform.forward(value.slice(0, 2));
        if (!point.every(Number.isFinite)) throw upstreamError('Astana PKK coordinates could not be projected.');
        return [...point, ...value.slice(2)];
    }
    return value.map(item => transformCoordinates(item, transform, depth + 1, coordinateDepth));
}

function validProjectedGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.length > 0 && polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring =>
        Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point) && point.length >= 2
            && Number.isFinite(point[0]) && Number.isFinite(point[1])
            && point[0] >= 100000 && point[0] <= 900000 && point[1] >= 0 && point[1] <= 10000000)
        && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
}

function projectGeometry(geometry) {
    if (!validProjectedGeometry(geometry)) throw upstreamError('Astana PKK returned geometry outside EPSG:32642.');
    const coordinateDepth = geometry.type === 'Polygon' ? 2 : 3;
    const projected = { type: geometry.type, coordinates: transformCoordinates(geometry.coordinates, toWgs84, 0, coordinateDepth) };
    if (!validateGeometry(projected)) throw upstreamError('Astana PKK returned invalid projected parcel geometry.');
    return projected;
}

function projectBounds(bounds) {
    const [west, south, east, north] = bounds;
    const corners = [[west, south], [west, north], [east, south], [east, north]].map(point => toMetric.forward(point));
    if (corners.some(point => !point.every(Number.isFinite))) throw new HttpError(400, 'Bbox could not be projected to Astana PKK coordinates.');
    return [Math.min(...corners.map(point => point[0])), Math.min(...corners.map(point => point[1])),
        Math.max(...corners.map(point => point[0])), Math.max(...corners.map(point => point[1]))];
}

export function createKazakhstanPkkSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, idPrefix } = descriptor || {};
    const districtId = descriptor?.districtId ?? DISTRICT_ID;
    const pageSize = descriptor?.pageSize ?? 1000;
    const maxFeatures = descriptor?.maxFeatures ?? 10000;
    const maxResponseBytes = descriptor?.maxResponseBytes ?? 4 * 1024 * 1024;
    const maxTotalResponseBytes = descriptor?.maxTotalResponseBytes ?? 24 * 1024 * 1024;
    const maxBboxKm2 = descriptor?.maxBboxKm2 ?? 2;
    const maxPages = descriptor?.maxPages ?? 100;
    const timeoutMs = descriptor?.timeoutMs ?? 15000;
    if (!descriptor || typeof descriptor !== 'object' || typeof id !== 'string' || !id
        || descriptor.endpoint !== ENDPOINT || descriptor.featureType !== FEATURE_TYPE
        || districtId !== DISTRICT_ID || typeof idPrefix !== 'string' || idPrefix !== 'KZ-ASTANA-PKK-'
        || (descriptor.idField !== undefined && descriptor.idField !== 'kad_nomer')
        || (descriptor.outFields !== undefined && (!Array.isArray(descriptor.outFields)
            || stableJson([...descriptor.outFields].sort()) !== stableJson([...OUT_FIELDS].sort())))
        || (descriptor.projection !== undefined && descriptor.projection !== SOURCE_CRS)
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < pageSize || maxFeatures > 20000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 8 * 1024 * 1024
        || !Number.isSafeInteger(maxTotalResponseBytes) || maxTotalResponseBytes < maxResponseBytes || maxTotalResponseBytes > 32 * 1024 * 1024
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 10
        || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 250
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000
        || typeof fetchImpl !== 'function') {
        throw new Error('Invalid Astana PKK parcel source descriptor.');
    }

    const outputDescriptor = { ...descriptor, outFields: OUT_FIELDS, idField: 'kad_nomer', parcelNumberField: 'kad_nomer' };

    async function readJson(response, state, signal) {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > maxResponseBytes) throw upstreamError('Astana PKK response exceeds the byte limit.');
        if (!response.body?.getReader) throw upstreamError('Astana PKK returned no readable response.');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                state.totalBytes += value.byteLength;
                if (size > maxResponseBytes || state.totalBytes > maxTotalResponseBytes) {
                    throw upstreamError('Astana PKK response exceeds the byte limit.');
                }
                chunks.push(Buffer.from(value));
            }
        } catch (error) {
            try { await reader.cancel(); } catch { /* The stream may already be closed. */ }
            if (error?.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw upstreamError('Astana PKK request timed out.', 504);
            throw upstreamError('Astana PKK response was interrupted.');
        } finally { reader.releaseLock(); }
        try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
        catch { throw upstreamError('Astana PKK returned invalid GeoJSON.'); }
    }

    function makeUrl({ bbox, filter, startIndex }) {
        const params = new URLSearchParams({
            service: 'WFS', version: '2.0.0', request: 'GetFeature', typename: FEATURE_TYPE,
            outputFormat: 'application/json', srsname: SOURCE_CRS, propertyname: 'gid,kad_nomer,geom',
            count: String(pageSize), startIndex: String(startIndex), sortBy: 'gid',
            viewparams: `district_id:${districtId}`,
            ...(bbox ? { bbox: `${bbox.join(',')},${SOURCE_CRS}` } : {}),
            ...(filter ? { filter } : {})
        });
        return `${ENDPOINT}?${params}`;
    }

    async function query({ bbox, codes, operationSignal, operationState }) {
        const metricBounds = bbox ? projectBounds(bbox) : undefined;
        const filter = codes ? idFilter(codes) : undefined;
        const state = operationState ?? { totalBytes: 0 };
        const signal = operationSignal ?? AbortSignal.timeout(timeoutMs);
        const byNativeId = new Map();
        const seenGids = new Set();
        let startIndex = 0;
        let matched;
        let pageCount = 0;
        for (;;) {
            if (++pageCount > maxPages) throw upstreamError('Astana PKK exceeded the page limit.');
            let payload;
            try {
                const response = await fetchImpl(makeUrl({ bbox: metricBounds, filter, startIndex }), { signal, redirect: 'error', headers: {
                    Accept: 'application/json', Referer: VIEWER, 'User-Agent': USER_AGENT
                } });
                if (response.status !== 200 || !response.ok) throw providerHttpError(response);
                payload = await readJson(response, state, signal);
            } catch (error) {
                if (error?.status) throw error;
                if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw upstreamError('Astana PKK request timed out.', 504);
                throw upstreamError('Astana PKK is unavailable.');
            }
            const page = payload?.features;
            const counts = ['numberMatched', 'totalFeatures'].filter(key => payload?.[key] !== undefined).map(key => payload[key]);
            const pageMatched = counts[0];
            const emptyWithoutCrs = (payload?.crs === null || payload?.crs === undefined)
                && Array.isArray(page) && page.length === 0 && pageMatched === 0
                && payload?.numberReturned === 0;
            const validCrs = (payload?.crs?.type === 'name'
                && [SOURCE_CRS_URN, SOURCE_CRS].includes(payload.crs.properties?.name)) || emptyWithoutCrs;
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(page) || page.length > pageSize
                || !counts.length || counts.some(value => !Number.isSafeInteger(value) || value < 0 || value !== pageMatched)
                || payload.numberReturned !== page.length || (matched !== undefined && pageMatched !== matched)
                || !validCrs) {
                throw upstreamError('Astana PKK returned incomplete or inconsistent GeoJSON metadata.');
            }
            matched = pageMatched;
            if (matched > maxFeatures || startIndex + page.length > matched || startIndex + page.length > maxFeatures) {
                throw upstreamError('Astana PKK query exceeds its match or parcel limit.');
            }
            if (page.length === 0 && startIndex < matched) throw upstreamError('Astana PKK ended pagination before its match count.');
            for (const feature of page) {
                const properties = feature?.properties;
                const gid = properties?.gid;
                const nativeId = properties?.kad_nomer;
                if (!Number.isSafeInteger(gid) || gid < 0 || seenGids.has(gid)) throw upstreamError('Astana PKK repeated or omitted a stable transport gid.');
                seenGids.add(gid);
                if (typeof nativeId !== 'string' || !NATIVE_PATTERN.test(nativeId)) throw upstreamError('Astana PKK returned an invalid native cadastre key.');
                if (codes && !codes.includes(nativeId)) throw upstreamError('Astana PKK returned an unrequested native cadastre key.');
                if (!validProjectedGeometry(feature.geometry)) throw upstreamError('Astana PKK returned geometry outside EPSG:32642.');
                const sourceExtent = geometryBbox(feature.geometry);
                // The public view can overfetch beyond its BBOX. Validate and count every row,
                // then remove envelope misses locally without changing any parcel boundary.
                const intersectsBounds = !metricBounds || !(sourceExtent[2] < metricBounds[0] || sourceExtent[0] > metricBounds[2]
                    || sourceExtent[3] < metricBounds[1] || sourceExtent[1] > metricBounds[3]);
                const geometry = projectGeometry(feature.geometry);
                const safeFeature = { geometry, properties: { gid, kad_nomer: nativeId } };
                const canonical = canonicalParcelFeature(outputDescriptor, safeFeature, nativeId);
                const signature = stableJson({ geometry: canonical.geometry, properties: canonical.properties.sourceProperties });
                const previous = byNativeId.get(nativeId);
                if (previous && previous.signature !== signature) throw upstreamError('Astana PKK returned conflicting rows for one native cadastre key.');
                if (!previous) byNativeId.set(nativeId, { canonical, signature, intersectsBounds });
            }
            startIndex += page.length;
            if (startIndex === matched) break;
            if (page.length === 0) throw upstreamError('Astana PKK returned an empty page before completion.');
        }
        return [...byNativeId.values()].filter(item => item.intersectsBounds).map(item => item.canonical);
    }

    const result = (features, extra = {}) => ({ type: 'FeatureCollection', features,
        complete: true, sourceId: id, returnsWGS84: true, ...extra });

    async function queryBounds(bounds) {
        validateBounds(bounds, maxBboxKm2, descriptor);
        return result(await query({ bbox: bounds }));
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 Astana parcel IDs.');
        const unique = [...new Set(ids)];
        const codes = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const code = value.slice(idPrefix.length);
            if (!NATIVE_PATTERN.test(code)) throw new HttpError(400, 'Invalid Astana cadastral ID.');
            return code;
        });
        const state = { totalBytes: 0 };
        const signal = AbortSignal.timeout(timeoutMs);
        const byId = new Map();
        for (let offset = 0; offset < codes.length; offset += MAX_ID_FILTER_TERMS) {
            const batch = await query({ codes: codes.slice(offset, offset + MAX_ID_FILTER_TERMS), operationSignal: signal, operationState: state });
            for (const feature of batch) byId.set(feature.id, feature);
            if (byId.size > maxFeatures) throw upstreamError('Astana PKK query exceeds its parcel limit.');
        }
        const features = [...byId.values()];
        const present = new Set(features.map(feature => feature.id));
        return result(features, { absentIds: unique.filter(id => !present.has(id)) });
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const response = await queryBounds(geometryBbox(footprint));
        return { ...response, features: response.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
