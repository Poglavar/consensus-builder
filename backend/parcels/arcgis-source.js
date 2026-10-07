// Adapts a fixed ArcGIS parcel layer to complete, canonical WGS84 parcel collections.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import proj4 from 'proj4';
import { upstreamError, providerHttpError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';
import { encodeSnapshotNativeId as encodeCompositeId, decodeSnapshotNativeId as decodeCompositeId } from './geojson-snapshot-source.js';
import { retainParcel } from './parcel-components.js';
export { validateBounds } from './source-contract.js';

export function createArcgisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, objectIdField, idPrefix, outFields } = descriptor;
    const pageSize = descriptor.pageSize || 2000;
    const maxFeatures = descriptor.maxFeatures || 10000;
    const maxBboxKm2 = descriptor.maxBboxKm2 || 25;
    const idBatchSize = descriptor.idBatchSize ?? 80;
    const idType = descriptor.idType || 'integer';
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const idQueryBraces = descriptor.idQueryBraces === true;
    const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const idFields = descriptor.idFields;
    const composite = idFields !== undefined;
    if (!id || !idPrefix || (!composite && !identifier.test(idField)) || !identifier.test(objectIdField)
        || (composite && (!Array.isArray(idFields) || idFields.length < 2 || idFields.length > 8
            || new Set(idFields).size !== idFields.length
            || idFields.some(field => typeof field !== 'string' || !identifier.test(field) || !outFields.includes(field))
            || !descriptor.idFieldTypes || Object.keys(descriptor.idFieldTypes).length !== idFields.length
            || idFields.some(field => !['integer', 'string'].includes(descriptor.idFieldTypes[field]))
            || idField !== undefined || descriptor.idType !== undefined || idPattern || idQueryBraces))
        || (!composite && descriptor.idFieldTypes !== undefined)
        || (descriptor.parcelNumberField && (!identifier.test(descriptor.parcelNumberField) || !outFields.includes(descriptor.parcelNumberField)))
        || !['integer', 'string'].includes(idType)
        || !Number.isInteger(idBatchSize) || idBatchSize < 1 || idBatchSize > 80
        || (descriptor.idQueryBraces !== undefined && typeof descriptor.idQueryBraces !== 'boolean')
        || (idQueryBraces && idType !== 'string')
        || ![undefined, 'offset', 'object-ids'].includes(descriptor.boundsQueryMode)
        || ![undefined, 'offset', 'object-ids'].includes(descriptor.idsQueryMode)
        || ![undefined, 'parts'].includes(descriptor.nativeGeometryMode)
        || (descriptor.nativeGeometryMode === 'parts' && (descriptor.boundsQueryMode !== 'object-ids' || descriptor.idsQueryMode !== 'object-ids'))
        || (descriptor.disjointParts !== undefined && (typeof descriptor.disjointParts !== 'boolean' || descriptor.nativeGeometryMode !== 'parts'))
        || (descriptor.partMatchFields !== undefined && (descriptor.nativeGeometryMode !== 'parts'
            || !Array.isArray(descriptor.partMatchFields) || !descriptor.partMatchFields.length || descriptor.partMatchFields.length > 8
            || descriptor.partMatchFields.some(field => typeof field !== 'string' || !identifier.test(field) || !outFields.includes(field))))
        || (descriptor.partsCoordinatePrecision !== undefined && (descriptor.nativeGeometryMode !== 'parts'
            || !Number.isInteger(descriptor.partsCoordinatePrecision) || descriptor.partsCoordinatePrecision < 7 || descriptor.partsCoordinatePrecision > 12))
        || (descriptor.boundsSrid !== undefined && (!Number.isInteger(descriptor.boundsSrid) || descriptor.boundsSrid <= 0
            || typeof descriptor.boundsProjection !== 'string' || !descriptor.boundsProjection.length))
        || (descriptor.boundsProjection !== undefined && descriptor.boundsSrid === undefined)
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid ArcGIS parcel source descriptor.');
    const boundsProjection = descriptor.boundsSrid === undefined ? null : proj4('EPSG:4326', descriptor.boundsProjection);

    function validNativeId(value, type = idType) {
        const text = String(value ?? '');
        if (type === 'string') return typeof value === 'string' && text.length > 0
            && text.length <= 256 && (!idPattern || idPattern.test(text))
            && (!idQueryBraces || guidPattern.test(text));
        return /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
    }

    function nativeIdFromProperties(props) {
        if (!composite) {
            const value = props[idField];
            if (!validNativeId(value)) throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.');
            return value;
        }
        const values = idFields.map(field => props[field]);
        if (values.some((value, index) => !validNativeId(value, descriptor.idFieldTypes[idFields[index]]))) {
            throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.');
        }
        try {
            const encoded = encodeCompositeId(values);
            decodeCompositeId(encoded, idFields.length);
            return encoded;
        }
        catch (_) { throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.'); }
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
            throw Object.assign(upstreamError('Parcel provider is unavailable.'), { cause: error });
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
            const page = descriptor.nativeGeometryMode === 'parts'
                ? [...payload.features].sort((a, b) => Number(a.properties?.[objectIdField]) - Number(b.properties?.[objectIdField]))
                : payload.features;
            if (offset + page.length > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            for (const feature of page) {
                const props = feature.properties || {};
                if (!attributeFilter.matches(props)) throw upstreamError('Parcel provider returned a record outside the configured ground status.');
                if (descriptor.partMatchFields?.some(field => !Object.hasOwn(props, field))) throw upstreamError('Parcel provider omitted parcel administrative references.');
                const nativeId = nativeIdFromProperties(props);
                if (!validateGeometry(feature.geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                const objectId = props[objectIdField];
                if (objectId === undefined || objectId === null || seenObjects.has(String(objectId))
                    || (expectedObjects && !expectedObjects.has(String(objectId)))) {
                    throw upstreamError('Parcel provider pagination repeated or omitted an object ID.');
                }
                seenObjects.add(String(objectId));
                const canonical = canonicalParcelFeature(descriptor, feature, nativeId);
                if (descriptor.partsCoordinatePrecision !== undefined) {
                    const factor = 10 ** descriptor.partsCoordinatePrecision;
                    const round = value => Array.isArray(value) ? value.map(round) : Math.round(value * factor) / factor;
                    canonical.geometry = { ...canonical.geometry, coordinates: round(canonical.geometry.coordinates) };
                    const rings = canonical.geometry.type === 'Polygon' ? canonical.geometry.coordinates : canonical.geometry.coordinates.flat();
                    if (!validateGeometry(canonical.geometry) || rings.some(ring => new Set(ring.slice(0, -1).map(point => point.join(','))).size < 3)) {
                        throw upstreamError('Parcel component precision conversion produced invalid geometry.');
                    }
                }
                if (descriptor.nativeGeometryMode === 'parts') canonical.properties.sourcePartCount = 1;
                retainParcel(byId, canonical, descriptor);
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
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true,
            ...(descriptor.nativeGeometryMode === 'parts' ? { sourceRows: seenObjects.size } : {}) };
    }

    async function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2);
        // Some providers disagree on count and OID manifests when reprojecting envelopes.
        // Project every corner locally; opposite corners alone can clip a rotated envelope.
        const corners = boundsProjection ? [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]]
            .map(point => boundsProjection.forward(point)) : null;
        if (corners?.some(point => point.some(value => !Number.isFinite(value)))) throw new Error('Invalid projected parcel bounds.');
        const projected = corners ? [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
            Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))] : bbox;
        const spatial = { geometry: projected.join(','), geometryType: 'esriGeometryEnvelope', inSR: String(descriptor.boundsSrid || 4326), spatialRel: 'esriSpatialRelIntersects' };
        if (descriptor.boundsQueryMode !== 'object-ids') return query(spatial);
        const result = await queryObjectIds(spatial);
        if (descriptor.nativeGeometryMode !== 'parts' || !result.features.length) return result;
        // A viewport can hit only one component. Fetch every component of each observed native
        // parcel before publishing it, so panning never changes the geometry of a retained ID.
        const features = [], ids = result.features.map(feature => feature.id);
        let sourceRows = 0;
        for (let start = 0; start < ids.length; start += 80) {
            const exact = await queryIds(ids.slice(start, start + 80));
            if (exact.absentIds.length) throw upstreamError('Parcel provider changed between viewport and complete component reads.');
            sourceRows += exact.sourceRows;
            if (sourceRows > maxFeatures) throw upstreamError('Complete parcel components exceed the parcel limit; use a smaller area.');
            features.push(...exact.features);
        }
        return { ...result, features, sourceRows, viewportSourceRows: result.sourceRows };
    }

    // Resolve complete OID manifests for spatial or native-key queries on older/slow layers.
    // OIDs are transport tokens, never canonical IDs.
    async function queryObjectIds(params) {
        const base = { where: baseWhere, ...params, f: 'json' };
        if (attributeFilter.where && params.where) base.where = `(${baseWhere}) AND (${params.where})`;
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
        if (descriptor.nativeGeometryMode === 'parts') objects.sort((a, b) => a - b);
        for (let start = 0; start < objects.length; start += pageSize) {
            const batch = objects.slice(start, start + pageSize);
            const page = await query({ objectIds: batch.join(',') }, new Set(batch.map(String)));
            for (const feature of page.features) retainParcel(byId, feature, descriptor);
        }
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true,
            ...(descriptor.nativeGeometryMode === 'parts' ? { sourceRows: objects.length } : {}) };
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (composite) {
                let parts;
                try { parts = decodeCompositeId(tail, idFields.length); }
                catch (_) { throw new HttpError(400, 'Invalid parcel ID.'); }
                return '(' + parts.map((part, index) => {
                    const field = idFields[index], type = descriptor.idFieldTypes[field];
                    if (!validNativeId(part, type)) throw new HttpError(400, 'Invalid parcel ID.');
                    return `${field} = ${type === 'integer' ? part : `'${part.replaceAll("'", "''")}'`}`;
                }).join(' AND ') + ')';
            }
            if (!validNativeId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            // Native string keys must retain leading zeroes and use SQL string literals.
            // Some ArcGIS services serialize bare GUIDs but require brace-wrapped SQL literals.
            // This affects only the upstream query; the canonical ID retains the published value.
            const queryValue = idQueryBraces ? `{${tail}}` : tail;
            return idType === 'string' ? `'${queryValue.replaceAll("'", "''")}'` : tail;
        });
        // Some statewide providers time out on large native-ID predicates. Validate the entire
        // request first, then fetch configured small batches; publish only after every batch passes.
        const result = { type: 'FeatureCollection', features: [], complete: true, sourceId: id, returnsWGS84: true };
        let sourceRows = 0;
        for (let start = 0; start < native.length; start += idBatchSize) {
            const values = native.slice(start, start + idBatchSize);
            const expected = new Set(unique.slice(start, start + idBatchSize));
            const params = { where: composite ? values.join(' OR ') : `${idField} IN (${values.join(',')})` };
            // Older ArcGIS servers support native-key filters and OID reads but reject offsets/order.
            const batch = descriptor.idsQueryMode === 'object-ids' ? await queryObjectIds(params) : await query(params);
            if (batch.features.some(feature => !expected.has(feature.properties.parcelId))) throw upstreamError('Parcel ID query returned unexpected parcels.');
            sourceRows += batch.sourceRows ?? batch.features.length;
            if (sourceRows > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use fewer IDs.');
            result.features.push(...batch.features);
        }
        if (descriptor.nativeGeometryMode === 'parts') result.sourceRows = sourceRows;
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
