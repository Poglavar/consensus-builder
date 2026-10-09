// Adapts a fixed ArcGIS parcel layer to complete, canonical WGS84 parcel collections.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import proj4 from 'proj4';
import { upstreamError, providerHttpError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';
import { retainParcel } from './parcel-components.js';
import { parseEsriParcelCollection } from './esri-parcel-reader.js';
export { validateBounds } from './source-contract.js';

const MAX_DISTINCT_MANIFEST_PAGES = 128;

export function createArcgisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, objectIdField, idPrefix, outFields } = descriptor;
    const pageSize = descriptor.pageSize || 2000;
    const maxFeatures = descriptor.maxFeatures || 10000;
    const maxBboxKm2 = descriptor.maxBboxKm2 || 25;
    const idBatchSize = descriptor.idBatchSize ?? (descriptor.idsQueryMode === 'single-equality' ? 1 : 80);
    const idType = descriptor.idType || 'integer';
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const idQueryBraces = descriptor.idQueryBraces === true;
    const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    // Joined ArcGIS layers publish qualified column names; accept only identifier segments.
    const columnName = value => typeof value === 'string'
        && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/.test(value);
    const idFields = descriptor.idFields;
    const composite = idFields !== undefined;
    const responseSrid = descriptor.responseSrid;
    const geometryPrecision = descriptor.geometryPrecision;
    if (!id || !idPrefix || !Array.isArray(outFields) || !outFields.length
        || outFields.some(field => !columnName(field))
        || (!composite && (!columnName(idField) || !outFields.includes(idField)))
        || !columnName(objectIdField) || !outFields.includes(objectIdField)
        || (composite && (!Array.isArray(idFields) || idFields.length < 2 || idFields.length > 8
            || new Set(idFields).size !== idFields.length
            || idFields.some(field => !columnName(field) || !outFields.includes(field))
            || !descriptor.idFieldTypes || Object.keys(descriptor.idFieldTypes).length !== idFields.length
            || idFields.some(field => !['integer', 'string'].includes(descriptor.idFieldTypes[field]))
            || idField !== undefined || descriptor.idType !== undefined || idPattern || idQueryBraces))
        || (!composite && descriptor.idFieldTypes !== undefined)
        || (descriptor.parcelNumberField && (!columnName(descriptor.parcelNumberField) || !outFields.includes(descriptor.parcelNumberField)))
        || !['integer', 'string'].includes(idType)
        || !Number.isInteger(idBatchSize) || idBatchSize < 1 || idBatchSize > 80
        || (descriptor.idQueryBraces !== undefined && typeof descriptor.idQueryBraces !== 'boolean')
        || (idQueryBraces && idType !== 'string')
        || ![undefined, 'offset', 'object-ids', 'distinct-ids'].includes(descriptor.boundsQueryMode)
        || ![undefined, 'offset', 'object-ids', 'single-equality', 'distinct-ids'].includes(descriptor.idsQueryMode)
        || ![undefined, 'geojson', 'esri-json'].includes(descriptor.queryFormat)
        || (responseSrid !== undefined && (responseSrid !== 3857 || descriptor.queryFormat === 'esri-json'))
        || (geometryPrecision !== undefined && (responseSrid !== 3857
            || !Number.isInteger(geometryPrecision) || geometryPrecision < 6 || geometryPrecision > 8))
        || (descriptor.idsQueryMode === 'single-equality' && (composite || idBatchSize !== 1))
        || ![undefined, 'parts', 'identical-join-rows'].includes(descriptor.nativeGeometryMode)
        || (descriptor.nativeGeometryMode === 'parts' && (descriptor.boundsQueryMode !== 'object-ids' || descriptor.idsQueryMode !== 'object-ids'))
        || (descriptor.nativeGeometryMode === 'identical-join-rows' && (composite || idType !== 'integer'
            || idField !== objectIdField || outFields.length !== 1 || outFields[0] !== idField
            || descriptor.boundsQueryMode !== 'distinct-ids' || descriptor.idsQueryMode !== 'distinct-ids'
            || !Number.isSafeInteger(pageSize) || pageSize < 1
            || ![undefined, 'geojson'].includes(descriptor.queryFormat)
            || responseSrid !== undefined || geometryPrecision !== undefined
            || descriptor.attributeFilters || descriptor.attributeExclusions || descriptor.attributeNotNull
            || descriptor.attributeNull || descriptor.attributeDateEquals || descriptor.partMatchFields
            || descriptor.disjointParts !== undefined || descriptor.partsCoordinatePrecision !== undefined))
        || (descriptor.boundsQueryMode === 'distinct-ids' && descriptor.nativeGeometryMode !== 'identical-join-rows')
        || (descriptor.idsQueryMode === 'distinct-ids' && descriptor.nativeGeometryMode !== 'identical-join-rows')
        || (descriptor.nativeGeometryMode === 'identical-join-rows'
            && (descriptor.boundsQueryMode !== 'distinct-ids' || descriptor.idsQueryMode !== 'distinct-ids'))
        || (descriptor.disjointParts !== undefined && (typeof descriptor.disjointParts !== 'boolean' || descriptor.nativeGeometryMode !== 'parts'))
        || (descriptor.partMatchFields !== undefined && (descriptor.nativeGeometryMode !== 'parts'
            || !Array.isArray(descriptor.partMatchFields) || !descriptor.partMatchFields.length || descriptor.partMatchFields.length > 8
            || descriptor.partMatchFields.some(field => !columnName(field) || !outFields.includes(field))))
        || (descriptor.partsCoordinatePrecision !== undefined && (descriptor.nativeGeometryMode !== 'parts'
            || !Number.isInteger(descriptor.partsCoordinatePrecision) || descriptor.partsCoordinatePrecision < 7 || descriptor.partsCoordinatePrecision > 12))
        || (descriptor.boundsSrid !== undefined && (!Number.isInteger(descriptor.boundsSrid) || descriptor.boundsSrid <= 0
            || typeof descriptor.boundsProjection !== 'string' || !descriptor.boundsProjection.length))
        || (descriptor.boundsProjection !== undefined && descriptor.boundsSrid === undefined)
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid ArcGIS parcel source descriptor.');
    const boundsProjection = descriptor.boundsSrid === undefined ? null : proj4('EPSG:4326', descriptor.boundsProjection);
    const responseProjection = responseSrid === 3857 ? proj4('EPSG:3857', 'EPSG:4326') : null;

    function responseGeometry(geometry) {
        if (!responseProjection) return geometry;
        try {
            if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error();
            const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
            const coordinates = polygons.map(polygon => polygon.map(ring => ring.map(point => {
                if (!Array.isArray(point) || point.length !== 2 || point.some(value =>
                    typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 20037508.34278925
                    || (geometryPrecision !== undefined && Number(value.toFixed(geometryPrecision)) !== value))) throw new Error();
                return responseProjection.forward(point);
            })));
            return { type: geometry.type, coordinates: geometry.type === 'Polygon' ? coordinates[0] : coordinates };
        } catch (_) { throw upstreamError('ArcGIS parcel provider returned invalid projected polygon geometry.'); }
    }

    function validNativeId(value, type = idType) {
        const text = String(value ?? '');
        if (type === 'string') return typeof value === 'string' && text.length > 0
            && text.length <= 256 && (!idPattern || idPattern.test(text))
            && (!idQueryBraces || guidPattern.test(text));
        return /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
    }

    // Fixed-width cadastral fields can contain a literal blank section. Preserve every
    // source component exactly; the snapshot namespace codec intentionally rejects spaces.
    const encodeCompositeId = values => values.map(value =>
        encodeURIComponent(String(value)).replaceAll('~', '%7E')).join('~');
    function decodeCompositeId(value) {
        if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid composite parcel ID.');
        const parts = value.split('~').map(decodeURIComponent);
        if (parts.length !== idFields.length || parts.some((part, index) =>
            !validNativeId(part, descriptor.idFieldTypes[idFields[index]]))
            || encodeCompositeId(parts) !== value) throw new Error('Invalid composite parcel ID.');
        return parts;
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
            decodeCompositeId(encoded);
            return encoded;
        }
        catch (_) { throw upstreamError('Parcel provider returned a missing or invalid native parcel ID.'); }
    }

    // Fixed catalogue filters keep planned/versioned records out of authoritative ground.
    const valuesFilter = createParcelAttributeFilter(descriptor);
    // ArcGIS date fields use TIMESTAMP literals in SQL and epoch milliseconds in JSON.
    // Keep this typed scope fixed in the catalogue, and verify it on every returned row.
    const dateEquals = descriptor.attributeDateEquals ?? {};
    if (descriptor.attributeDateEquals === null || typeof dateEquals !== 'object'
        || Object.getPrototypeOf(dateEquals) !== Object.prototype) throw new Error('Invalid ArcGIS date attribute filter.');
    const dateEntries = Object.entries(dateEquals);
    if (dateEntries.length > 8 || dateEntries.some(([field, value]) => !identifier.test(field)
        || !outFields.includes(field) || descriptor.attributeNull?.includes(field)
        || typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) {
        throw new Error('Invalid ArcGIS date attribute filter.');
    }
    const dateScope = dateEntries.map(([field, value]) =>
        `${field} = TIMESTAMP '${value.slice(0, 19).replace('T', ' ')}'`).join(' AND ');
    const attributeFilter = {
        where: [valuesFilter.where, dateScope].filter(Boolean).join(' AND '),
        matches: props => valuesFilter.matches(props) && dateEntries.every(([field, value]) =>
            typeof props[field] === 'number' && props[field] === Date.parse(value))
    };
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
                outSR: String(responseSrid ?? 4326), f: descriptor.queryFormat === 'esri-json' ? 'json' : 'geojson',
                ...(geometryPrecision === undefined ? {} : { geometryPrecision: String(geometryPrecision) }),
                ...(descriptor.queryFormat === 'esri-json' ? { returnTrueCurves: 'true' } : {}),
                ...(expectedObjects ? {} : { orderByFields: objectIdField,
                    resultRecordCount: String(pageSize), resultOffset: String(offset) }), ...params
            });
            if (attributeFilter.where && params.where) search.set('where', `(${baseWhere}) AND (${params.where})`);
            const raw = await request(search);
            const payload = descriptor.queryFormat === 'esri-json' ? parseEsriParcelCollection(raw) : raw;
            if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('Parcel provider returned an invalid FeatureCollection.');
            if (responseProjection && payload.features.length && (payload.crs?.type !== 'name' || ![
                'EPSG:3857', 'urn:ogc:def:crs:EPSG::3857', 'http://www.opengis.net/def/crs/EPSG/0/3857'
            ].includes(payload.crs?.properties?.name))) {
                throw upstreamError('ArcGIS parcel provider omitted or changed its projected response CRS.');
            }
            const page = descriptor.nativeGeometryMode === 'parts'
                ? [...payload.features].sort((a, b) => Number(a.properties?.[objectIdField]) - Number(b.properties?.[objectIdField]))
                : payload.features;
            if (offset + page.length > maxFeatures) throw upstreamError('Parcel provider query exceeds the parcel limit; use a smaller area.');
            for (const feature of page) {
                const props = feature.properties || {};
                if (!attributeFilter.matches(props)) throw upstreamError('Parcel provider returned a record outside the configured ground status.');
                if (descriptor.partMatchFields?.some(field => !Object.hasOwn(props, field))) throw upstreamError('Parcel provider omitted parcel administrative references.');
                const nativeId = nativeIdFromProperties(props);
                const geometry = responseGeometry(feature.geometry);
                if (!validateGeometry(geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                const objectId = props[objectIdField];
                if (objectId === undefined || objectId === null || seenObjects.has(String(objectId))
                    || (expectedObjects && !expectedObjects.has(String(objectId)))) {
                    throw upstreamError('Parcel provider pagination repeated or omitted an object ID.');
                }
                seenObjects.add(String(objectId));
                const canonical = canonicalParcelFeature(descriptor, { ...feature, geometry }, nativeId);
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
        if (descriptor.boundsQueryMode === 'distinct-ids') return queryDistinctBounds(spatial);
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
    async function queryObjectIds(params, combineScope = true) {
        const base = { where: baseWhere, ...params, f: 'json' };
        if (combineScope && attributeFilter.where && params.where) base.where = `(${baseWhere}) AND (${params.where})`;
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

    // Some joined ArcGIS views expose one native parcel ID but repeat its identical
    // geometry across relationship rows. This opt-in path proves the distinct ID
    // membership twice, then reads complete unfiltered geometry and accepts duplicate
    // rows only when every complete polygon is byte-for-byte equivalent.
    async function distinctCount(params) {
        const search = new URLSearchParams({
            where: params.where || baseWhere, outFields: idField, returnGeometry: 'false',
            returnCountOnly: 'true', returnDistinctValues: 'true', f: 'json',
            ...Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'where'))
        });
        if (params.where && params.where !== baseWhere) search.set('where', `(${baseWhere}) AND (${params.where})`);
        const payload = await request(search);
        if (!Number.isSafeInteger(payload.count) || payload.count < 0 || payload.count > maxFeatures) {
            throw upstreamError('Parcel provider returned an invalid distinct-ID count.');
        }
        return payload.count;
    }

    async function distinctManifestPages(params, expectedCount) {
        const pageCount = Math.ceil(expectedCount / pageSize);
        if (pageCount > MAX_DISTINCT_MANIFEST_PAGES) {
            throw upstreamError('Parcel provider distinct-ID manifest exceeds the request budget.');
        }
        const ids = [];
        const seen = new Set();
        for (let offset = 0; offset < expectedCount; offset += pageSize) {
            const requested = Math.min(pageSize, expectedCount - offset);
            const search = new URLSearchParams({
                where: params.where || baseWhere, outFields: idField, returnGeometry: 'false',
                returnDistinctValues: 'true', orderByFields: idField, resultRecordCount: String(requested),
                resultOffset: String(offset), f: 'json',
                ...Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'where'))
            });
            if (params.where && params.where !== baseWhere) search.set('where', `(${baseWhere}) AND (${params.where})`);
            const payload = await request(search);
            if (!Array.isArray(payload.features)) throw upstreamError('Parcel provider returned an invalid distinct-ID page.');
            const limitFlag = payload.exceededTransferLimit ?? payload.properties?.exceededTransferLimit;
            if (payload.features.length !== requested
                || (limitFlag === true && offset + requested >= expectedCount)
                || (limitFlag !== undefined && typeof limitFlag !== 'boolean')) {
                throw upstreamError('Parcel provider returned incomplete distinct-ID paging.');
            }
            for (const feature of payload.features) {
                const props = feature.attributes || feature.properties || {};
                const value = props[idField];
                if (!validNativeId(value) || seen.has(String(value))) {
                    throw upstreamError('Parcel provider returned duplicate or invalid distinct parcel IDs.');
                }
                seen.add(String(value));
                ids.push(Number(value));
            }
        }
        if (ids.length !== expectedCount) throw upstreamError('Parcel provider returned an incomplete distinct-ID manifest.');
        return ids;
    }

    async function queryDistinctManifest(params) {
        const countBefore = await distinctCount(params);
        const first = await distinctManifestPages(params, countBefore);
        const countMiddle = await distinctCount(params);
        if (countBefore !== countMiddle) throw upstreamError('Parcel provider distinct-ID membership changed during the query.');
        const second = await distinctManifestPages(params, countMiddle);
        const countAfter = await distinctCount(params);
        if (countMiddle !== countAfter
            || first.length !== second.length || first.some((value, index) => value !== second[index])) {
            throw upstreamError('Parcel provider distinct-ID membership changed during the query.');
        }
        return first;
    }

    async function queryIdenticalJoinRows(queryIds, expectedIds = queryIds) {
        const result = new Map();
        let rawRows = 0;
        const expected = new Set(expectedIds.map(String));
        for (let start = 0; start < queryIds.length; start += idBatchSize) {
            const batch = queryIds.slice(start, start + idBatchSize);
            const expectedBatch = batch.filter(value => expected.has(String(value)));
            const where = `${idField} IN (${batch.join(',')})`;
            const params = { where };
            const rawCount = await rawRowCount(params);
            if (!Number.isSafeInteger(rawCount) || rawCount < expectedBatch.length || rawCount > maxFeatures) {
                throw upstreamError('Parcel provider returned an invalid raw-row count for exact geometry reads.');
            }
            rawRows += rawCount;
            if (rawRows > maxFeatures) throw upstreamError('Complete parcel rows exceed the parcel limit; use a smaller area.');
            const search = new URLSearchParams({
                where: `(${baseWhere}) AND (${where})`, outFields: idField, returnGeometry: 'true',
                outSR: '4326', resultRecordCount: String(Math.max(1, rawCount)), f: 'geojson'
            });
            const payload = await request(search);
            const transferFlag = payload.exceededTransferLimit ?? payload.properties?.exceededTransferLimit;
            if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)
                || payload.features.length !== rawCount || transferFlag === true
                || (transferFlag !== undefined && typeof transferFlag !== 'boolean')
                || (rawCount === 0 && transferFlag !== false)) {
                throw upstreamError('Parcel provider returned incomplete exact geometry rows.');
            }
            const batchSet = new Set(batch.map(String));
            const grouped = new Map();
            for (const feature of payload.features) {
                const props = feature.properties || {};
                const rawId = props[idField];
                if (!validNativeId(rawId) || !batchSet.has(String(rawId)) || !expected.has(String(rawId))) {
                    throw upstreamError('Parcel provider returned an unexpected native parcel ID.');
                }
                const geometry = responseGeometry(feature.geometry);
                if (!validateGeometry(geometry)) throw upstreamError('Parcel provider returned invalid polygon geometry.');
                const previous = grouped.get(String(rawId));
                if (previous && JSON.stringify(previous) !== JSON.stringify(geometry)) {
                    throw upstreamError('Parcel provider returned conflicting geometry for repeated join rows.');
                }
                grouped.set(String(rawId), geometry);
            }
            if (grouped.size !== expectedBatch.length || expectedBatch.some(value => !grouped.has(String(value)))) {
                throw upstreamError('Parcel provider exact geometry rows omitted a distinct native parcel ID.');
            }
            const rawCountAfter = await rawRowCount(params);
            if (rawCountAfter !== rawCount) throw upstreamError('Parcel provider raw rows changed during exact geometry reads.');
            for (const value of expectedBatch) {
                const nativeId = String(value);
                const feature = canonicalParcelFeature(descriptor, {
                    type: 'Feature', properties: { [idField]: Number(value) }, geometry: grouped.get(nativeId)
                }, nativeId);
                if (result.has(feature.id)) throw upstreamError('Parcel provider returned a duplicate distinct parcel ID.');
                result.set(feature.id, feature);
            }
        }
        return { features: [...result.values()], sourceRows: rawRows };
    }

    async function rawRowCount(params) {
        const where = params.where === undefined || params.where === baseWhere
            ? baseWhere : `(${baseWhere}) AND (${params.where})`;
        const payload = await request(new URLSearchParams({ where, outFields: idField, returnGeometry: 'false',
            returnCountOnly: 'true', f: 'json' }));
        if (!Number.isSafeInteger(payload.count) || payload.count < 0 || payload.count > maxFeatures) {
            throw upstreamError('Parcel provider returned an invalid raw-row count.');
        }
        return payload.count;
    }

    async function queryDistinctBounds(spatial) {
        const nativeIds = await queryDistinctManifest(spatial);
        const rows = await queryIdenticalJoinRows(nativeIds);
        return { type: 'FeatureCollection', features: rows.features, complete: true, sourceId: id,
            returnsWGS84: true, sourceRows: rows.sourceRows };
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (composite) {
                let parts;
                try { parts = decodeCompositeId(tail); }
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
        if (descriptor.idsQueryMode === 'distinct-ids') {
            const expected = new Set(unique);
            const nativeIds = await queryDistinctManifest({ where: `${idField} IN (${native.join(',')})` });
            const requestedNative = new Set(native.map(Number));
            if (nativeIds.some(value => !requestedNative.has(value))) {
                throw upstreamError('Parcel ID query returned unexpected distinct native IDs.');
            }
            const rows = await queryIdenticalJoinRows(native.map(Number), nativeIds);
            const features = rows.features;
            if (features.some(feature => !expected.has(feature.id))) throw upstreamError('Parcel ID query returned unexpected parcels.');
            const present = new Set(features.map(feature => feature.id));
            return { type: 'FeatureCollection', features, complete: true, sourceId: id, returnsWGS84: true,
                sourceRows: rows.sourceRows, absentIds: unique.filter(value => !present.has(value)) };
        }
        // Some statewide providers time out on large native-ID predicates. Validate the entire
        // request first, then fetch configured small batches; publish only after every batch passes.
        const result = { type: 'FeatureCollection', features: [], complete: true, sourceId: id, returnsWGS84: true };
        let sourceRows = 0;
        for (let start = 0; start < native.length; start += idBatchSize) {
            const values = native.slice(start, start + idBatchSize);
            const expected = new Set(unique.slice(start, start + idBatchSize));
            const equalityOnly = descriptor.idsQueryMode === 'single-equality';
            const params = { where: composite ? values.join(' OR ') : equalityOnly
                ? `${idField} = ${values[0]}` : `${idField} IN (${values.join(',')})` };
            // Older ArcGIS servers support native-key filters and OID reads but reject offsets/order.
            // Equality-only servers reject combined SQL predicates. Resolve one native key's OIDs,
            // then fetch those OIDs with the normal source scope and validate every returned row.
            // An out-of-scope record fails completeness; it never becomes valid ground or absence.
            const batch = equalityOnly ? await queryObjectIds(params, false)
                : descriptor.idsQueryMode === 'object-ids' ? await queryObjectIds(params) : await query(params);
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
