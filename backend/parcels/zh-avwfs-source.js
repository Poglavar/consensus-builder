// Zurich MapServer serializes GeoJSON without FIDs or reliable paging counts.
// Use the cadastral EGRID attribute and independent WFS hits around each read.
import proj4 from 'proj4';
import { bbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { canonicalParcelFeature, validateBounds, validateGeometry, upstreamError, providerHttpError } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';

// EPSG:2056 and EPSG operation CH1903+ to WGS 84 (1), not a fitted offset.
export const LV95_PROJECTION = '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346 +units=m +no_defs';
const EGRID = /^CH[0-9]{12}$/;

export function createZurichAvwfsSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idPrefix } = descriptor;
    const pageSize = descriptor.pageSize ?? 200;
    const maxFeatures = descriptor.maxFeatures ?? 10000;
    const idBatchSize = descriptor.idBatchSize ?? 40;
    const maxBytes = descriptor.maxResponseBytes ?? 2 * 1024 * 1024;
    const timeoutMs = descriptor.timeoutMs ?? 15000;
    if (endpoint !== 'https://maps.zh.ch/wfs/AVZHWFS' || descriptor.wfsProfile !== 'zh-avwfs-lv95-v1'
        || descriptor.featureType !== 'ms:liegenschaften_f' || descriptor.idField !== 'egris_egrid'
        || descriptor.geometryField !== 'geometry' || descriptor.idType !== 'string'
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'egris_egrid'
        || descriptor.responseSrid !== 2056 || descriptor.boundsSrid !== 2056
        || descriptor.projection !== LV95_PROJECTION || !id || !idPrefix
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000
        || !Number.isSafeInteger(idBatchSize) || idBatchSize < 1 || idBatchSize > 80
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) {
        throw new Error('Invalid Zurich AVWFS parcel profile.');
    }
    const projection = proj4(LV95_PROJECTION, 'EPSG:4326');

    async function read(params) {
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature',
            typeNames: descriptor.featureType, srsName: 'EPSG:2056',
            propertyName: 'egris_egrid,geometry', sortBy: 'egris_egrid', ...params }).toString();
        const signal = AbortSignal.timeout(timeoutMs);
        try {
            const response = await fetchImpl(url.href, { signal, redirect: 'error', cache: 'no-store',
                headers: { Accept: 'application/json, application/xml' } });
            if (!response.ok) throw providerHttpError(response);
            const reader = response.body?.getReader();
            if (!reader) throw upstreamError('AVWFS omitted its response body.');
            const chunks = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxBytes) throw upstreamError('AVWFS response exceeds the byte limit.');
                    chunks.push(value);
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            return new TextDecoder().decode(concatBytes(chunks));
        } catch (error) {
            if (error.status) throw error;
            throw upstreamError(signal.aborted ? 'AVWFS timed out.' : 'AVWFS is unavailable.', signal.aborted ? 504 : 502);
        }
    }

    async function hits(params) {
        const xml = await read({ ...params, resultType: 'hits' });
        const match = /<(?:wfs:)?FeatureCollection\b[^>]*\bnumberMatched="([0-9]+)"/.exec(xml);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw upstreamError('AVWFS omitted its bounded match count.');
        return Number(match[1]);
    }

    function transform(geometry) {
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw upstreamError('AVWFS returned non-polygon geometry.');
        try {
            const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            const coordinates = polygons.map(polygon => polygon.map(ring => ring.map(point => {
                if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)) throw new Error();
                return [...projection.forward(point.slice(0, 2)), ...point.slice(2)];
            })));
            const result = { type: geometry.type, coordinates: geometry.type === 'Polygon' ? coordinates[0] : coordinates };
            if (!validateGeometry(result)) throw new Error();
            return result;
        } catch { throw upstreamError('AVWFS returned invalid LV95 polygon geometry.'); }
    }

    async function query(params) {
        const count = await hits(params);
        if (count > maxFeatures) throw upstreamError('AVWFS query exceeds the parcel limit; use a smaller area.');
        const features = new Map();
        for (let offset = 0; offset < count;) {
            let data;
            try { data = JSON.parse(await read({ ...params, outputFormat: 'application/json', count: String(pageSize), startIndex: String(offset) })); }
            catch (error) { if (error.status) throw error; throw upstreamError('AVWFS returned invalid GeoJSON.'); }
            if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)
                || !geoJsonResponseCrsMatches(data.crs, 2056, { required: true })
                || data.features.length === 0 || data.features.length > pageSize || offset + data.features.length > count
                || (data.numberMatched !== undefined && data.numberMatched !== count)) throw upstreamError('AVWFS returned incomplete or inconsistent pagination.');
            for (const feature of data.features) {
                const nativeId = feature?.properties?.egris_egrid;
                if (!EGRID.test(nativeId) || features.has(nativeId)) throw upstreamError('AVWFS repeated or omitted a native EGRID.');
                features.set(nativeId, canonicalParcelFeature(descriptor, { geometry: transform(feature.geometry), properties: { egris_egrid: nativeId } }, nativeId));
            }
            offset += data.features.length;
        }
        if (await hits(params) !== count) throw upstreamError('AVWFS match count changed during the read.');
        return { type: 'FeatureCollection', features: [...features.values()], complete: true, sourceId: id, returnsWGS84: true };
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix) || !EGRID.test(value.slice(idPrefix.length))) throw new HttpError(400, 'Invalid AVWFS parcel ID.');
            return value.slice(idPrefix.length);
        });
        const features = [];
        for (let i = 0; i < native.length; i += idBatchSize) {
            const batch = native.slice(i, i + idBatchSize);
            const clauses = batch.map(value => `<fes:PropertyIsEqualTo><fes:ValueReference>egris_egrid</fes:ValueReference><fes:Literal>${value}</fes:Literal></fes:PropertyIsEqualTo>`);
            const filter = `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0">${clauses.length === 1 ? clauses[0] : `<fes:Or>${clauses.join('')}</fes:Or>`}</fes:Filter>`;
            const result = await query({ filter });
            if (result.features.some(feature => !batch.includes(feature.properties.sourceParcelId))) throw upstreamError('AVWFS ignored its exact EGRID filter.');
            features.push(...result.features);
        }
        const found = new Set(features.map(feature => feature.id));
        return { type: 'FeatureCollection', features, complete: true, sourceId: id, returnsWGS84: true,
            absentIds: unique.filter(value => !found.has(value)) };
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 1, descriptor);
        const [w, s, e, n] = bounds;
        const corners = [[w, s], [e, s], [w, n], [e, n]].map(point => projection.inverse(point));
        const native = [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
            Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))];
        const result = await query({ bbox: `${native.join(',')},urn:ogc:def:crs:EPSG::2056` });
        const footprint = bboxPolygon(bounds);
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, footprint)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(bbox(footprint));
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, footprint)) };
    }
    return Object.freeze({ queryIds, queryBounds, queryGeometry });
}
