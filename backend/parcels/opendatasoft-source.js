// Read safe native parcel IDs and unchanged polygons through Opendatasoft Explore v2.1.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, providerHttpError, validateBounds, validateGeometry, canonicalParcelFeature } from './source-contract.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function readBoundedJson(response) {
    const reader = response.body?.getReader();
    if (!reader) throw upstreamError('Opendatasoft returned no response body.');
    const decoder = new TextDecoder();
    let bytes = 0, text = '', complete = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) { complete = true; break; }
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw upstreamError('Opendatasoft response exceeds the byte limit.');
            text += decoder.decode(value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
    } finally {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function createOpendatasoftParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, idPrefix, geometryField, outFields } = descriptor;
    const base = new URL(endpoint);
    const field = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    const pageSize = descriptor.pageSize ?? 100;
    const maxFeatures = descriptor.maxFeatures ?? 10000;
    if (!id || !idPrefix || descriptor.idType !== 'string' || !field(idField) || !field(geometryField)
        || !Array.isArray(outFields) || outFields.length !== 1 || outFields[0] !== idField
        || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
        || !base.pathname.endsWith('/records') || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000) {
        throw new Error('Invalid Opendatasoft parcel source descriptor.');
    }
    // Numeric IDs stay strings; strata-plan IDs use the same namespace. No numeric coercion.
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{1,256}$/.test(value);

    async function request(where, limit, offset) {
        const signal = AbortSignal.timeout(15000);
        try {
            const response = await fetchImpl(`${endpoint}?${new URLSearchParams({
                select: `${idField},${geometryField}`, where, order_by: idField,
                limit: String(limit), offset: String(offset)
            })}`, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
            if (!response.ok) throw providerHttpError(response);
            const body = await readBoundedJson(response);
            if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.results)
                || body.results.length > limit) throw upstreamError('Opendatasoft provider returned invalid counts or rows.');
            if (body.total_count > maxFeatures) throw upstreamError('Parcel query exceeds the parcel limit; use a smaller area.');
            return body;
        } catch (error) {
            if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error.name)) throw upstreamError('Parcel provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('Parcel provider is unavailable.');
        }
    }

    async function query(where) {
        const features = [], seen = new Set();
        let expected, offset = 0;
        do {
            const page = await request(where, Math.min(pageSize, maxFeatures - offset), offset);
            expected ??= page.total_count;
            if (page.total_count !== expected || offset + page.results.length > expected
                || (offset < expected && !page.results.length)) throw upstreamError('Opendatasoft parcel paging changed or ended early.');
            for (const row of page.results) {
                const nativeId = row?.[idField];
                const geometry = row?.[geometryField]?.geometry;
                // Blank and repeated keys are explicit failures, never silently omitted or collapsed.
                if (!validId(nativeId) || seen.has(nativeId)) throw upstreamError('Opendatasoft returned a blank, invalid or repeated parcel ID.');
                if (!validateGeometry(geometry)) throw upstreamError('Opendatasoft returned invalid polygon geometry.');
                seen.add(nativeId);
                features.push(canonicalParcelFeature(descriptor, { type: 'Feature', geometry,
                    properties: { [idField]: nativeId } }, nativeId));
            }
            offset += page.results.length;
        } while (offset < expected);
        // Count changes make the query retryable, including a previously empty ID query.
        const after = await request(where, 0, 0);
        if (after.total_count !== expected) throw upstreamError('Opendatasoft dataset changed during the parcel query.');
        return { type: 'FeatureCollection', features, complete: true, sourceId: id, returnsWGS84: true };
    }

    function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25);
        const [west, south, east, north] = bounds;
        // Explore in_bbox takes latitude,longitude corners; returned rings remain longitude,latitude.
        return query(`in_bbox(${geometryField},${south},${west},${north},${east})`);
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const requested = [...new Set(ids)];
        const native = requested.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix) || !validId(value.slice(idPrefix.length))) {
                throw new HttpError(400, 'Invalid parcel ID for this source.');
            }
            return `'${value.slice(idPrefix.length)}'`;
        });
        const result = await query(`${idField} in (${native.join(',')})`);
        if (result.features.some(feature => !requested.includes(feature.id))) throw upstreamError('Opendatasoft exact read returned an unexpected parcel.');
        const present = new Set(result.features.map(feature => feature.id));
        return { ...result, absentIds: requested.filter(value => !present.has(value)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
