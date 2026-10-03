// Adapts fixed WFS 1.1/2.0 GeoJSON layers to complete WGS84 parcels, with optional provider pacing.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, validateBounds, validateGeometry, canonicalParcelFeature } from './source-contract.js';

const sourceRequestQueues = new Map();

function queueSourceRequest(key, minRequestIntervalMs, request) {
    if (minRequestIntervalMs === undefined) return request();
    let queue = sourceRequestQueues.get(key);
    if (!queue) {
        queue = { lastStartedAt: null, tail: Promise.resolve() };
        sourceRequestQueues.set(key, queue);
    }
    const run = queue.tail.then(async () => {
        if (queue.lastStartedAt !== null) {
            const waitMs = queue.lastStartedAt + minRequestIntervalMs - Date.now();
            if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        queue.lastStartedAt = Date.now();
        return request();
    });
    // Keep the shared queue usable after a failed provider request.
    queue.tail = run.then(() => undefined, () => undefined);
    return run;
}

export function createWfsParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, featureType, idField, idPrefix, outFields } = descriptor;
    const version = descriptor.version ?? '2.0.0';
    const idType = descriptor.idType;
    const minRequestIntervalMs = descriptor.minRequestIntervalMs;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!id || !idPrefix || !identifier.test(idField) || !['string', 'integer'].includes(idType)
        || !['1.1.0', '2.0.0'].includes(version)
        || (minRequestIntervalMs !== undefined && (!Number.isSafeInteger(minRequestIntervalMs) || minRequestIntervalMs < 100 || minRequestIntervalMs > 5000))
        || !/^[A-Za-z0-9_.]+:[A-Za-z0-9_]+$/.test(featureType)
        || !Array.isArray(outFields) || !outFields.includes(idField)
        || (descriptor.parcelNumberField && !outFields.includes(descriptor.parcelNumberField))
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid WFS parcel source descriptor.');
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const pageSize = descriptor.pageSize || 1000;
    const maxFeatures = descriptor.maxFeatures || 10000;
    const maxBboxKm2 = descriptor.maxBboxKm2 || 25;
    const validId = value => idType === 'integer'
        ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        : typeof value === 'string' && value.length > 0 && value.length <= 256
            && (!idPattern || idPattern.test(value));
    const validExternalId = value => idType === 'integer'
        ? typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
        : validId(value);

    async function query(params) {
        const byId = new Map();
        const seenObjects = new Set();
        let offset = 0;
        let matched;
        for (;;) {
            const search = new URLSearchParams({
                service: 'WFS', version, request: 'GetFeature',
                ...(version === '1.1.0' ? { typeName: featureType } : { typeNames: featureType }),
                outputFormat: 'application/json', srsName: 'CRS:84', sortBy: idField,
                ...(version === '1.1.0' ? { maxFeatures: String(pageSize) } : { count: String(pageSize) }),
                startIndex: String(offset), ...params
            });
            let payload;
            try {
                payload = await queueSourceRequest(endpoint, minRequestIntervalMs, async () => {
                    // Start the timeout after any provider-specific rate-limit wait.
                    const signal = AbortSignal.timeout(15000);
                    try {
                        const response = await fetchImpl(`${endpoint}?${search}`, { signal, redirect: 'error', headers: { Accept: 'application/geo+json, application/json' } });
                        if (!response.ok) throw upstreamError(`Parcel provider returned HTTP ${response.status}.`);
                        return await response.json();
                    } catch (error) {
                        if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw upstreamError('Parcel provider timed out.', 504);
                        if (error.status) throw error;
                        throw upstreamError(`Parcel provider is unavailable: ${error.message}`);
                    }
                });
            } catch (error) {
                if (error.status) throw error;
                throw upstreamError(`Parcel provider is unavailable: ${error.message}`);
            }
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('WFS parcel provider returned an invalid FeatureCollection.');
            const page = payload.features;
            if (page.length > pageSize) throw upstreamError('WFS parcel provider returned more features than the configured page limit.');
            const pageMatched = version === '1.1.0' ? payload.totalFeatures : payload.numberMatched;
            if (!Number.isSafeInteger(pageMatched) || pageMatched < 0
                || (version === '2.0.0' && payload.numberReturned !== page.length)
                || (version === '1.1.0' && ((payload.numberMatched !== undefined && payload.numberMatched !== pageMatched)
                    || (payload.numberReturned !== undefined && payload.numberReturned !== page.length)))
                || (matched !== undefined && pageMatched !== matched)) {
                throw upstreamError('WFS parcel provider returned missing, inconsistent or changing match counts.');
            }
            matched = pageMatched;
            if (matched > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            if (offset + page.length > matched || (!page.length && offset < matched)) throw upstreamError('WFS parcel provider returned incomplete pagination.');
            for (const feature of page) {
                const nativeId = feature?.properties?.[idField];
                if (!validId(nativeId)) throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.');
                if (!validateGeometry(feature.geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                // WFS feature IDs are pagination evidence only; durable cadastral IDs come from idField.
                if (typeof feature.id !== 'string' || !feature.id || seenObjects.has(feature.id)) throw upstreamError('WFS parcel provider repeated or omitted a feature ID.');
                seenObjects.add(feature.id);
                const canonical = canonicalParcelFeature(descriptor, feature, nativeId);
                const previous = byId.get(canonical.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(canonical.geometry)) throw upstreamError('Parcel provider returned conflicting geometry for one parcel ID.');
                byId.set(canonical.id, canonical);
            }
            offset += page.length;
            if (offset === matched) break;
            // Construct subsequent requests at the fixed endpoint. Never follow provider-supplied links.
        }
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true };
    }

    function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2, descriptor);
        // CRS:84 fixes longitude/latitude order for both the filter and the GeoJSON response.
        return query({ bbox: `${bbox.join(',')},CRS:84` });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (!validExternalId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            if (idType === 'integer') {
                return tail;
            }
            return `'${tail.replaceAll("'", "''")}'`;
        });
        const filter = `${idField} IN (${native.join(',')})`;
        const result = await query({ cql_filter: filter });
        if (result.features.some(feature => !unique.includes(feature.id))) throw upstreamError('Parcel ID query returned unexpected parcels.');
        const present = new Set(result.features.map(feature => feature.id));
        return { ...result, absentIds: unique.filter(value => !present.has(value)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
