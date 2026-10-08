// Public, category-scoped WFS adapter for the Bishkek ENI_AREA cadastre layer.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const ENDPOINT = 'https://cadastre.kg/svc-portal/map/proxy.do?http://localhost/o2map/services/wfs?';
const VIEWER = 'https://cadastre.kg/svc-portal/map/main.do';
const CATEGORY = 'земельный участок';
const SAFE_FIELDS = ['PROPCODE', 'NAZNACHENI', 'STS', 'DATEINS', 'DATEUPD', 'THE_GEOM'];
const OUTPUT_FIELDS = ['PROPCODE', 'NAZNACHENI', 'STS', 'DATEINS', 'DATEUPD'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const OGC_NS = 'http://www.opengis.net/ogc';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function xml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function categoryFilter() {
    return `<ogc:PropertyIsEqualTo><ogc:PropertyName>NAZNACHENI</ogc:PropertyName><ogc:Literal>${xml(CATEGORY)}</ogc:Literal></ogc:PropertyIsEqualTo>`;
}

function exactIdsFilter(codes) {
    const terms = codes.map(code => `<ogc:PropertyIsEqualTo><ogc:PropertyName>PROPCODE</ogc:PropertyName><ogc:Literal>${xml(code)}</ogc:Literal></ogc:PropertyIsEqualTo>`);
    const idCondition = terms.length === 1 ? terms[0] : `<ogc:Or>${terms.join('')}</ogc:Or>`;
    return `<ogc:Filter xmlns:ogc="${OGC_NS}"><ogc:And>${categoryFilter()}${idCondition}</ogc:And></ogc:Filter>`;
}

function landCategoryFilter() {
    return `<ogc:Filter xmlns:ogc="${OGC_NS}">${categoryFilter()}</ogc:Filter>`;
}

export function createBishkekCadastreSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, idPrefix } = descriptor || {};
    const pageSize = descriptor?.pageSize ?? 250;
    const maxFeatures = descriptor?.maxFeatures ?? 5000;
    const maxResponseBytes = descriptor?.maxResponseBytes ?? 2 * 1024 * 1024;
    const maxTotalResponseBytes = descriptor?.maxTotalResponseBytes ?? 16 * 1024 * 1024;
    const maxBboxKm2 = descriptor?.maxBboxKm2 ?? 2;
    const maxPages = descriptor?.maxPages ?? 100;
    const timeoutMs = descriptor?.timeoutMs ?? 15000;
    if (!descriptor || typeof descriptor !== 'object' || typeof id !== 'string' || !id || descriptor.endpoint !== ENDPOINT
        || typeof idPrefix !== 'string' || !idPrefix.startsWith('KG-BISHKEK-') || !idPrefix.endsWith('-')
        || (descriptor.outFields !== undefined && (!Array.isArray(descriptor.outFields)
            || stableJson([...descriptor.outFields].sort()) !== stableJson([...SAFE_FIELDS].sort())))
        || (descriptor.attributeFilters && stableJson(descriptor.attributeFilters) !== stableJson({ NAZNACHENI: CATEGORY }))
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < pageSize || maxFeatures > 20000
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 8 * 1024 * 1024
        || !Number.isSafeInteger(maxTotalResponseBytes) || maxTotalResponseBytes < maxResponseBytes || maxTotalResponseBytes > 32 * 1024 * 1024
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0 || maxBboxKm2 > 10
        || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 250
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000
        || typeof fetchImpl !== 'function') {
        throw new Error('Invalid Bishkek cadastre source descriptor.');
    }

    const outputDescriptor = { ...descriptor, outFields: OUTPUT_FIELDS, parcelNumberField: undefined };

    async function readBytes(response, state, limit = maxResponseBytes) {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > limit) throw upstreamError('Bishkek WFS response exceeds the byte limit.');
        if (!response.body?.getReader) throw upstreamError('Bishkek WFS returned no readable response.');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                state.totalBytes += value.byteLength;
                if (size > limit || state.totalBytes > maxTotalResponseBytes) {
                    throw upstreamError('Bishkek WFS response exceeds the byte limit.');
                }
                chunks.push(Buffer.from(value));
            }
        } catch (error) {
            try { await reader.cancel(); } catch { /* The stream may already be closed. */ }
            throw error;
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, size);
    }

    async function readJson(response, state, signal) {
        let bytes;
        try { bytes = await readBytes(response, state); }
        catch (error) {
            if (error?.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw upstreamError('Bishkek WFS request timed out.', 504);
            throw upstreamError('Bishkek WFS response was interrupted.');
        }
        try { return JSON.parse(bytes.toString('utf8')); }
        catch { throw upstreamError('Bishkek WFS returned invalid GeoJSON.'); }
    }

    function makeUrl({ bbox, filter, startIndex, limit }) {
        const params = new URLSearchParams({
            service: 'WFS', version: '1.1.0', request: 'GetFeature', typename: 'ENI_AREA',
            propertyname: SAFE_FIELDS.join(','), outputFormat: 'application/json', srsname: 'EPSG:4326',
            sortBy: 'PROPCODE+A',
            ...(bbox ? { bbox: `${bbox.join(',')},EPSG:4326` } : {}),
            maxFeatures: String(limit), filter, startIndex: String(startIndex)
        });
        return `${ENDPOINT}${params}`;
    }

    async function readPages({ bbox, codes, signal }) {
        const state = { totalBytes: 0 };
        const filter = bbox ? landCategoryFilter() : exactIdsFilter(codes);
        const rowsByCode = new Map();
        const seenFids = new Set();
        const seenPages = new Set();
        let startIndex = 0;
        let pages = 0;
        for (;;) {
            if (++pages > maxPages) throw upstreamError('Bishkek WFS exceeded the page limit.');
            const url = makeUrl({ bbox, filter, startIndex, limit: pageSize });
            let response;
            try {
                response = await fetchImpl(url, { signal, redirect: 'error', headers: {
                    Accept: 'application/json', 'Accept-Language': 'ru-KG,ky-KG;q=0.9,ru-RU;q=0.8,en;q=0.5',
                    Referer: VIEWER, 'User-Agent': USER_AGENT
                } });
                if (response.status !== 200 || !response.ok) throw providerHttpError(response);
            } catch (error) {
                if (error?.status) throw error;
                if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw upstreamError('Bishkek WFS request timed out.', 504);
                throw upstreamError('Bishkek WFS is unavailable.');
            }
            const payload = await readJson(response, state, signal);
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)
                || payload.features.length > pageSize
                || (payload.crs !== undefined && payload.crs !== 'EPSG:4326'
                    && payload.crs?.properties?.name !== 'EPSG:4326'
                    && payload.crs?.properties?.name !== 'urn:ogc:def:crs:EPSG::4326')) {
                throw upstreamError('Bishkek WFS returned an invalid page or coordinate system.');
            }
            const page = payload.features;
            const pageSignature = stableJson(page.map(feature => feature?.id ?? null));
            if (seenPages.has(pageSignature) && page.length) throw upstreamError('Bishkek WFS repeated a page.');
            seenPages.add(pageSignature);
            if (startIndex + page.length > maxFeatures) throw upstreamError('Bishkek WFS query exceeds the feature limit; use a smaller area.');
            for (const feature of page) {
                const properties = feature?.properties;
                const nativeId = properties?.PROPCODE;
                if (typeof feature?.id !== 'string' || !feature.id || seenFids.has(feature.id)) {
                    throw upstreamError('Bishkek WFS repeated or omitted a row feature ID.');
                }
                seenFids.add(feature.id);
                if (typeof nativeId !== 'string' || !ID_PATTERN.test(nativeId)) throw upstreamError('Bishkek WFS returned an invalid native parcel code.');
                if (properties?.NAZNACHENI !== CATEGORY) throw upstreamError('Bishkek WFS returned a feature outside the land-plot category.');
                if (!validateGeometry(feature.geometry)) throw upstreamError('Bishkek WFS returned invalid WGS84 polygon geometry.');
                const extent = geometryBbox(feature);
                if (bbox && (extent[2] < bbox[0] || extent[0] > bbox[2] || extent[3] < bbox[1] || extent[1] > bbox[3])) {
                    throw upstreamError('Bishkek WFS returned a feature outside the requested bounds.');
                }
                if (codes && !codes.includes(nativeId)) throw upstreamError('Bishkek WFS returned an unrequested native parcel code.');
                const safeProperties = Object.fromEntries(OUTPUT_FIELDS.filter(field => field in properties).map(field => [field, properties[field]]));
                const canonical = canonicalParcelFeature(outputDescriptor, { geometry: feature.geometry, properties: safeProperties }, nativeId);
                const signature = stableJson({ geometry: canonical.geometry, sourceProperties: canonical.properties.sourceProperties });
                const previous = rowsByCode.get(nativeId);
                if (previous && previous.signature !== signature) throw upstreamError('Bishkek WFS returned conflicting geometry or attributes for one native parcel code.');
                if (!previous) rowsByCode.set(nativeId, { canonical, signature });
            }
            startIndex += page.length;
            // The service omits total counts. A terminal page shorter than the requested page size is the only completeness signal.
            if (page.length < pageSize) break;
        }
        return [...rowsByCode.values()].map(row => row.canonical);
    }

    function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2, descriptor);
        return readPages({ bbox, signal: AbortSignal.timeout(timeoutMs) }).then(features => ({
            type: 'FeatureCollection', features, sourceId: id, returnsWGS84: true, complete: true
        }));
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 Bishkek parcel IDs.');
        const unique = [...new Set(ids)];
        const codes = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const code = value.slice(idPrefix.length);
            if (!ID_PATTERN.test(code)) throw new HttpError(400, 'Invalid Bishkek parcel ID.');
            return code;
        });
        const features = await readPages({ codes, signal: AbortSignal.timeout(timeoutMs) });
        const byId = new Map(features.map(feature => [feature.id, feature]));
        return { type: 'FeatureCollection', features, sourceId: id, returnsWGS84: true, complete: true,
            absentIds: unique.filter(idValue => !byId.has(idValue)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const response = await queryBounds(geometryBbox(footprint));
        return { ...response, features: response.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
