// Adapts a fixed ArcGIS parcel layer to complete, canonical WGS84 parcel collections.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, providerHttpError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';
export { validateBounds } from './source-contract.js';

export function createArcgisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, objectIdField, idPrefix, outFields } = descriptor;
    const pageSize = descriptor.pageSize || 2000;
    const maxFeatures = descriptor.maxFeatures || 10000;
    const maxBboxKm2 = descriptor.maxBboxKm2 || 25;
    const idType = descriptor.idType || 'integer';
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const idQueryBraces = descriptor.idQueryBraces === true;
    const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!id || !idPrefix || !identifier.test(idField) || !identifier.test(objectIdField)
        || (descriptor.parcelNumberField && (!identifier.test(descriptor.parcelNumberField) || !outFields.includes(descriptor.parcelNumberField)))
        || !['integer', 'string'].includes(idType)
        || (descriptor.idQueryBraces !== undefined && typeof descriptor.idQueryBraces !== 'boolean')
        || (idQueryBraces && idType !== 'string')
        || ![undefined, 'offset', 'object-ids'].includes(descriptor.boundsQueryMode)
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid ArcGIS parcel source descriptor.');

    function validNativeId(value) {
        const text = String(value ?? '');
        if (idType === 'string') return typeof value === 'string' && text.length > 0
            && text.length <= 256 && (!idPattern || idPattern.test(text))
            && (!idQueryBraces || guidPattern.test(text));
        return /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
    }

    // Fixed catalogue filters keep planned/versioned records out of authoritative ground.
    const attributeFilter = createParcelAttributeFilter(descriptor);
    const baseWhere = attributeFilter.where || '1=1';

    async function request(search) {
        const signal = AbortSignal.timeout(15000);
        let payload;
        try {
            // ArcGIS supports form POST; avoid intermediary URL limits for long OID/GUID batches.
            const url = `${endpoint}/query?${search}`;
            const usePost = url.length > 1800;
            const response = await fetchImpl(usePost ? `${endpoint}/query` : url, {
                signal, ...(usePost ? { method: 'POST', body: search.toString() } : {}),
                headers: { Accept: 'application/geo+json, application/json',
                    ...(usePost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }
            });
            if (!response.ok) throw providerHttpError(response);
            payload = await response.json();
        } catch (error) {
            if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw upstreamError('Parcel provider timed out.', 504);
            if (error.status) throw error;
            throw upstreamError('Parcel provider is unavailable.');
        }
        if (payload.error) throw providerHttpError(payload.error.code);
        return payload;
    }

    async function query(params, expectedObjects = null) {
        const byId = new Map();
        const seenObjects = new Set();
        let offset = 0;
        for (;;) {
            const search = new URLSearchParams({
                where: baseWhere, outFields: outFields.join(','), returnGeometry: 'true',
                outSR: '4326', f: 'geojson',
                ...(expectedObjects ? {} : { orderByFields: objectIdField,
                    resultRecordCount: String(pageSize), resultOffset: String(offset) }), ...params
            });
            if (attributeFilter.where && params.where) search.set('where', `(${baseWhere}) AND (${params.where})`);
            const payload = await request(search);
            if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('Parcel provider returned an invalid FeatureCollection.');
            const page = payload.features;
            if (offset + page.length > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            for (const feature of page) {
                const props = feature.properties || {};
                if (!attributeFilter.matches(props)) throw upstreamError('Parcel provider returned a record outside the configured ground status.');
                const nativeId = props[idField];
                if (!validNativeId(nativeId)) {
                    throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.');
                }
                if (!validateGeometry(feature.geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                const objectId = props[objectIdField];
                if (objectId === undefined || objectId === null || seenObjects.has(String(objectId))
                    || (expectedObjects && !expectedObjects.has(String(objectId)))) {
                    throw upstreamError('Parcel provider pagination repeated or omitted an object ID.');
                }
                seenObjects.add(String(objectId));
                const parcelId = `${idPrefix}${nativeId}`;
                const canonical = canonicalParcelFeature(descriptor, feature, nativeId);
                const previous = byId.get(parcelId);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(canonical.geometry)) {
                    throw upstreamError('Parcel provider returned conflicting geometry for one parcel ID.');
                }
                byId.set(parcelId, canonical);
            }
            // Some ArcGIS GeoJSON services omit the flag even for a truncated full page.
            const limitFlag = payload.exceededTransferLimit ?? payload.properties?.exceededTransferLimit;
            if (expectedObjects) {
                if (limitFlag === true || seenObjects.size !== expectedObjects.size) {
                    throw upstreamError('Parcel provider returned incomplete object-ID paging.');
                }
                break;
            }
            const hasMore = limitFlag === true || (typeof limitFlag !== 'boolean' && page.length === pageSize);
            if (!hasMore) break;
            if (!page.length || offset + page.length >= maxFeatures) throw upstreamError('Parcel provider returned incomplete pagination.');
            offset += page.length;
        }
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true };
    }

    async function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2);
        const spatial = { geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' };
        if (descriptor.boundsQueryMode !== 'object-ids') return query(spatial);

        // Some layers time out on spatial geometry reads. Resolve bounded OIDs first,
        // then retrieve exact batches; OIDs are transport tokens, never canonical IDs.
        const base = { where: baseWhere, ...spatial, f: 'json' };
        const countResult = await request(new URLSearchParams({ ...base, returnCountOnly: 'true' }));
        if (!Number.isSafeInteger(countResult.count) || countResult.count < 0) throw upstreamError('Parcel provider returned an invalid count.');
        if (countResult.count > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use a smaller area.');
        const manifest = await request(new URLSearchParams({ ...base, returnIdsOnly: 'true' }));
        // ArcGIS uses an explicit null ID list for a successful empty spatial query.
        const objects = countResult.count === 0 && manifest.objectIds === null ? [] : manifest.objectIds;
        if (!Array.isArray(objects) || objects.length !== countResult.count
            || objects.some(value => !Number.isSafeInteger(value) || value < 0)
            || new Set(objects).size !== objects.length
            || manifest.exceededTransferLimit === true
            || (manifest.objectIdFieldName && manifest.objectIdFieldName !== objectIdField)) {
            throw upstreamError('Parcel provider returned an incomplete or invalid object-ID list.');
        }
        const byId = new Map();
        for (let start = 0; start < objects.length; start += pageSize) {
            const batch = objects.slice(start, start + pageSize);
            const page = await query({ objectIds: batch.join(',') }, new Set(batch.map(String)));
            for (const feature of page.features) {
                const previous = byId.get(feature.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(feature.geometry)) {
                    throw upstreamError('Parcel provider returned conflicting geometry for one parcel ID.');
                }
                byId.set(feature.id, feature);
            }
        }
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true };
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (!validNativeId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            // Native string keys must retain leading zeroes and use SQL string literals.
            // Some ArcGIS services serialize bare GUIDs but require brace-wrapped SQL literals.
            // This affects only the upstream query; the canonical ID retains the published value.
            const queryValue = idQueryBraces ? `{${tail}}` : tail;
            return idType === 'string' ? `'${queryValue.replaceAll("'", "''")}'` : tail;
        });
        const result = await query({ where: `${idField} IN (${native.join(',')})` });
        if (result.features.some(feature => !unique.includes(feature.properties.parcelId))) throw upstreamError('Parcel ID query returned unexpected parcels.');
        const present = new Set(result.features.map(feature => feature.properties.parcelId));
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
