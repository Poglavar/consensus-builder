// Adapts fixed WFS 1.0/1.1/2.0 GeoJSON layers with attribute IDs or verified native feature-ID routes.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import proj4 from 'proj4';
import { HttpError } from '../utils/helpers.js';
import { concatBytes } from './byte-utils.js';
import { upstreamError, providerHttpError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';

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
    const responseSrid = descriptor.responseSrid;
    // Projected responses require a published operation in the descriptor and independent
    // native-coordinate alignment evidence before the source is admitted.
    const responseProjection = responseSrid !== undefined && responseSrid !== 3857
        ? descriptor.projection : undefined;
    const responseCoordinatePrecision = descriptor.responseCoordinatePrecision;
    const requestProperties = descriptor.requestProperties;
    const idBatchSize = descriptor.idBatchSize ?? 80;
    const idType = descriptor.idType;
    const minRequestIntervalMs = descriptor.minRequestIntervalMs;
    const featureIdMode = descriptor.nativeIdMode === 'feature-id';
    const featureIdParameter = descriptor.featureIdParameter ?? (version === '2.0.0' ? 'resourceId' : 'featureID');
    // XML NCNames permit Unicode letters, digits and combining marks, excluding CQL operators.
    const identifier = /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u;
    if (!id || !idPrefix || (featureIdMode ? idField !== null || idType !== 'string' || requestProperties !== true
        || !['resourceId', 'featureID'].includes(featureIdParameter)
        || (version === '1.1.0' && featureIdParameter !== 'featureID')
        || !Array.isArray(outFields) || outFields.length !== 0
        : typeof idField !== 'string' || !identifier.test(idField)) || !['string', 'integer'].includes(idType)
        || (descriptor.nativeIdMode !== undefined && !featureIdMode)
        || (!featureIdMode && descriptor.featureIdParameter !== undefined)
        || !['1.0.0', '1.1.0', '2.0.0'].includes(version)
        || (responseSrid !== undefined && responseSrid !== 3857
            && (!Number.isSafeInteger(responseSrid) || responseSrid <= 0 || typeof responseProjection !== 'string'))
        || (responseProjection !== undefined && (responseSrid === undefined || responseSrid === 3857
            || !/^\+proj=/.test(responseProjection)))
        || (responseCoordinatePrecision !== undefined && (responseSrid !== 3857
            || !Number.isInteger(responseCoordinatePrecision) || responseCoordinatePrecision < 0 || responseCoordinatePrecision > 8))
        || (requestProperties !== undefined && typeof requestProperties !== 'boolean')
        || !Number.isSafeInteger(idBatchSize) || idBatchSize < 1 || idBatchSize > 80
        || (minRequestIntervalMs !== undefined && (!Number.isSafeInteger(minRequestIntervalMs) || minRequestIntervalMs < 100 || minRequestIntervalMs > 5000))
        || !/^([\p{L}_][\p{L}\p{N}\p{M}_.-]*):([\p{L}_][\p{L}\p{N}\p{M}_.-]*)$/u.test(featureType)
        || !Array.isArray(outFields) || (!featureIdMode && !outFields.includes(idField))
        || (requestProperties && (typeof descriptor.geometryField !== 'string' || !identifier.test(descriptor.geometryField)
            || outFields.some(field => typeof field !== 'string' || !identifier.test(field))))
        || (descriptor.parcelNumberField && !outFields.includes(descriptor.parcelNumberField))
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid WFS parcel source descriptor.');
    const attributeFilter = createParcelAttributeFilter(descriptor);
    const hasFixedAttributeFilter = Boolean(attributeFilter.where);
    if (hasFixedAttributeFilter && (typeof descriptor.geometryField !== 'string' || !identifier.test(descriptor.geometryField))) {
        throw new Error('Invalid WFS parcel source descriptor.');
    }
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const pageSize = featureIdMode ? descriptor.pageSize ?? 1000 : descriptor.pageSize || 1000;
    const maxFeatures = featureIdMode ? descriptor.maxFeatures ?? 10000 : descriptor.maxFeatures || 10000;
    const maxBboxKm2 = featureIdMode ? descriptor.maxBboxKm2 ?? 25 : descriptor.maxBboxKm2 || 25;
    const maxResponseBytes = descriptor.maxResponseBytes ?? 8 * 1024 * 1024;
    if (featureIdMode && (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10000
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 100000
        || !Number.isFinite(maxBboxKm2) || maxBboxKm2 <= 0
        || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 20 * 1024 * 1024)) {
        throw new Error('Invalid WFS parcel source limits.');
    }
    // A few GeoServer deployments round GeoJSON to four decimal places. Asking for
    // metres preserves their source precision; transform only an explicitly tagged CRS.
    const toWgs84 = responseSrid === 3857 ? proj4('EPSG:3857', 'EPSG:4326')
        : responseProjection ? proj4(responseProjection, 'EPSG:4326') : null;
    function wgs84Geometry(geometry) {
        if (!toWgs84) return geometry;
        try {
            if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error();
            const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            const coordinates = polygons.map(polygon => polygon.map(ring => ring.map(point => {
                if (!Array.isArray(point) || point.length < 2 || point.slice(0, 2).some(value =>
                    typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 20037508.34278925)) throw new Error();
                // Mixed upstream serializers can alternate between full precision and a
                // fixed decimal limit. Normalize in metres at the documented read precision.
                const xy = responseCoordinatePrecision === undefined ? point.slice(0, 2)
                    : point.slice(0, 2).map(value => Number(value.toFixed(responseCoordinatePrecision)));
                return toWgs84.forward(xy);
            })));
            return { type: geometry.type, coordinates: geometry.type === 'Polygon' ? coordinates[0] : coordinates };
        } catch (_) {
            throw upstreamError('WFS parcel provider returned invalid projected polygon geometry.');
        }
    }
    const validId = value => idType === 'integer'
        ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        : typeof value === 'string' && value.length > 0 && value.length <= 256
            && (!idPattern || idPattern.test(value));
    const validExternalId = value => idType === 'integer'
        ? typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
        : validId(value);
    const routableFeatureId = value => validId(value) && /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(value);
    // GeoTools' fid-<JVM UID> values are generated transport identities, even if a
    // single server happens to reuse them. They cannot become durable parcel keys.
    const generatedFeatureId = value => /(?:^|\.)fid--?[0-9a-f]+_[0-9a-f]+_-?[0-9a-f]+$/i.test(value);
    const unstableIdentity = () => upstreamError('WFS provider has no stable native feature identity.', 502, 'parcel-source-unstable-identity');

    async function readPayload(response) {
        if (!featureIdMode) return response.json();
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('WFS provider omitted its response body.');
        let bytes = 0;
        const chunks = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxResponseBytes) throw upstreamError('WFS provider exceeded the response byte limit.');
                chunks.push(value);
            }
            return JSON.parse(new TextDecoder('utf-8').decode(concatBytes(chunks)));
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    async function query(params) {
        const byId = new Map();
        const seenObjects = new Set();
        let offset = 0;
        let matched;
        for (;;) {
            const search = new URLSearchParams({
                service: 'WFS', version, request: 'GetFeature',
                ...(version !== '2.0.0' ? { typeName: featureType } : { typeNames: featureType }),
                outputFormat: 'application/json', srsName: responseSrid ? `EPSG:${responseSrid}` : version === '1.0.0' ? 'EPSG:4326' : 'CRS:84',
                ...(!featureIdMode ? { sortBy: idField } : {}),
                ...(requestProperties ? { propertyName: [...new Set([descriptor.geometryField, ...outFields])].join(',') } : {}),
                // GeoServer accepts count beside WFS 1.0 maxFeatures; both advertise the
                // same observed limit to the qualification request recorder.
                ...(version === '1.0.0' ? { maxFeatures: String(pageSize), count: String(pageSize) }
                    : version === '1.1.0' ? { maxFeatures: String(pageSize) } : { count: String(pageSize) }),
                // GeoServer requests a natural primary-key sort even for startIndex=0.
                // A feature-ID-only layer has no attribute to invent for that sort.
                ...(!featureIdMode || offset > 0 ? { startIndex: String(offset) } : {}), ...params
            });
            let payload;
            try {
                payload = await queueSourceRequest(endpoint, minRequestIntervalMs, async () => {
                    // Start the timeout after any provider-specific rate-limit wait.
                    const signal = AbortSignal.timeout(15000);
                    try {
                        const response = await fetchImpl(`${endpoint}?${search}`, { signal, redirect: 'error',
                            ...(featureIdMode ? { cache: 'no-store' } : {}),
                            headers: { Accept: 'application/geo+json, application/json' } });
                        if (!response.ok) throw providerHttpError(response);
                        return await readPayload(response);
                    } catch (error) {
                        if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw upstreamError('Parcel provider timed out.', 504);
                        if (error.status) throw error;
                        throw upstreamError('Parcel provider is unavailable.');
                    }
                });
            } catch (error) {
                if (error.status) throw error;
                throw upstreamError('Parcel provider is unavailable.');
            }
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('WFS parcel provider returned an invalid FeatureCollection.');
            if (!geoJsonResponseCrsMatches(payload.crs, responseSrid ?? 4326,
                { required: toWgs84 !== null && payload.features.length > 0 })) {
                throw upstreamError(toWgs84
                    ? 'WFS parcel provider omitted or changed its projected response CRS.'
                    : 'WFS parcel provider declared an unsupported or mismatched response CRS.');
            }
            const page = payload.features;
            if (page.length > pageSize) throw upstreamError('WFS parcel provider returned more features than the configured page limit.');
            const pageMatched = version !== '2.0.0' ? payload.totalFeatures : payload.numberMatched;
            if (!Number.isSafeInteger(pageMatched) || pageMatched < 0
                || (version === '2.0.0' && payload.numberReturned !== page.length)
                || (version !== '2.0.0' && ((payload.numberMatched !== undefined && payload.numberMatched !== pageMatched)
                    || (payload.numberReturned !== undefined && payload.numberReturned !== page.length)))
                || (matched !== undefined && pageMatched !== matched)) {
                throw upstreamError('WFS parcel provider returned missing, inconsistent or changing match counts.');
            }
            matched = pageMatched;
            if (matched > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            if (offset + page.length > matched || (!page.length && offset < matched)) throw upstreamError('WFS parcel provider returned incomplete pagination.');
            for (const feature of page) {
                if (hasFixedAttributeFilter && !attributeFilter.matches(feature?.properties || {})) {
                    throw upstreamError('WFS parcel provider returned a feature outside its configured attribute filter.');
                }
                const nativeId = featureIdMode ? feature?.id : feature?.properties?.[idField];
                if (featureIdMode && typeof nativeId === 'string' && generatedFeatureId(nativeId)) throw unstableIdentity();
                if (featureIdMode ? !routableFeatureId(nativeId) : !validId(nativeId)) throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.');
                const geometry = wgs84Geometry(feature.geometry);
                if (!validateGeometry(geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                // Attribute mode uses feature IDs only as pagination evidence. Feature-ID
                // mode also requires an independent native-ID round trip before bounds publish.
                if (typeof feature.id !== 'string' || !feature.id || seenObjects.has(feature.id)) throw upstreamError('WFS parcel provider repeated or omitted a feature ID.');
                seenObjects.add(feature.id);
                const canonical = canonicalParcelFeature(descriptor, { ...feature, geometry }, nativeId);
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
        // CRS:84 fixes longitude/latitude order for both the spatial filter and GeoJSON response.
        if (hasFixedAttributeFilter) {
            const [west, south, east, north] = bbox;
            const spatial = `BBOX(${descriptor.geometryField},${west},${south},${east},${north},'CRS:84')`;
            return query({ cql_filter: `(${attributeFilter.where}) AND (${spatial})` });
        }
        const result = query({ bbox: `${bbox.join(',')},${version === '1.0.0' ? 'EPSG:4326' : 'CRS:84'}` });
        return featureIdMode ? verifyFeatureIds(result) : result;
    }

    async function verifyFeatureIds(resultPromise) {
        const result = await resultPromise;
        // No schema attribute exists to sort on. Check every enumerated feature
        // through the official ID route, without trusting page position or geometry IDs.
        for (let offset = 0; offset < result.features.length; offset += idBatchSize) {
            const batch = result.features.slice(offset, offset + idBatchSize);
            const exact = await queryIds(batch.map(feature => feature.id));
            const byId = new Map(exact.features.map(feature => [feature.id, feature]));
            if (exact.absentIds.length || batch.some(feature => !byId.has(feature.id)
                || JSON.stringify(feature.geometry) !== JSON.stringify(byId.get(feature.id).geometry))) throw unstableIdentity();
        }
        return result;
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (featureIdMode ? !routableFeatureId(tail) : !validExternalId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            // A vanished generated ID is not proof of parcel absence. Reject it even
            // when the provider would answer the official route with an empty result.
            if (featureIdMode && generatedFeatureId(tail)) throw unstableIdentity();
            if (featureIdMode) return tail;
            if (idType === 'integer') {
                return tail;
            }
            return `'${tail.replaceAll("'", "''")}'`;
        });
        const features = [];
        for (let offset = 0; offset < native.length; offset += idBatchSize) {
            const batchIds = unique.slice(offset, offset + idBatchSize);
            const batch = native.slice(offset, offset + idBatchSize).join(',');
            let params;
            if (featureIdMode) params = { [featureIdParameter]: batch };
            else {
                // GeoTools treats bare ID IN (...) as feature-ID syntax, not the attribute
                // called "id". Quote that reserved identifier to query the published row key.
                const nativeField = /^id$/i.test(idField) ? `"${idField}"` : idField;
                const idFilter = `${nativeField} IN (${batch})`;
                params = { cql_filter: hasFixedAttributeFilter ? `(${attributeFilter.where}) AND (${idFilter})` : idFilter };
            }
            const result = await query(params);
            if (result.features.some(feature => !batchIds.includes(feature.id))) throw upstreamError('Parcel ID query returned unexpected parcels.');
            features.push(...result.features);
        }
        // Publish absence only after every batch completed; a failed later request is not a partial answer.
        const present = new Set(features.map(feature => feature.id));
        return { type: 'FeatureCollection', features, complete: true, sourceId: id, returnsWGS84: true,
            absentIds: unique.filter(value => !present.has(value)) };
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint));
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
