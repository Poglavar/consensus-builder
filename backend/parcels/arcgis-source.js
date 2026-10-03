// Adapts a fixed ArcGIS parcel layer to complete, canonical WGS84 parcel collections.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, validateBounds, validateGeometry, canonicalParcelFeature, createParcelAttributeFilter } from './source-contract.js';
export { validateBounds } from './source-contract.js';

export function createArcgisParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, idField, objectIdField, idPrefix, outFields } = descriptor;
    const pageSize = descriptor.pageSize || 2000;
    const maxFeatures = descriptor.maxFeatures || 10000;
    const maxBboxKm2 = descriptor.maxBboxKm2 || 25;
    const idType = descriptor.idType || 'integer';
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!id || !idPrefix || !identifier.test(idField) || !identifier.test(objectIdField)
        || (descriptor.parcelNumberField && (!identifier.test(descriptor.parcelNumberField) || !outFields.includes(descriptor.parcelNumberField)))
        || !['integer', 'string'].includes(idType)
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid ArcGIS parcel source descriptor.');

    function validNativeId(value) {
        const text = String(value ?? '');
        if (idType === 'string') return typeof value === 'string' && text.length > 0
            && text.length <= 256 && (!idPattern || idPattern.test(text));
        return /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
    }

    // Fixed catalogue filters keep planned/versioned records out of authoritative ground.
    const attributeFilter = createParcelAttributeFilter(descriptor);
    const baseWhere = attributeFilter.where || '1=1';

    async function query(params) {
        const byId = new Map();
        const seenObjects = new Set();
        let offset = 0;
        for (;;) {
            const search = new URLSearchParams({
                where: baseWhere, outFields: outFields.join(','), returnGeometry: 'true',
                outSR: '4326', f: 'geojson', orderByFields: objectIdField,
                resultRecordCount: String(pageSize), resultOffset: String(offset), ...params
            });
            if (attributeFilter.where && params.where) search.set('where', `(${baseWhere}) AND (${params.where})`);
            const signal = AbortSignal.timeout(15000);
            let payload;
            try {
                const response = await fetchImpl(`${endpoint}/query?${search}`, { signal, headers: { Accept: 'application/geo+json, application/json' } });
                if (!response.ok) throw upstreamError(`Parcel provider returned HTTP ${response.status}.`);
                payload = await response.json();
            } catch (error) {
                if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw upstreamError('Parcel provider timed out.', 504);
                if (error.status) throw error;
                throw upstreamError(`Parcel provider is unavailable: ${error.message}`);
            }
            if (payload.error) throw upstreamError(`ArcGIS parcel query failed: ${payload.error.message || payload.error.code}`);
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
                if (objectId === undefined || objectId === null || seenObjects.has(String(objectId))) {
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
            const hasMore = limitFlag === true || (typeof limitFlag !== 'boolean' && page.length === pageSize);
            if (!hasMore) break;
            if (!page.length || offset + page.length >= maxFeatures) throw upstreamError('Parcel provider returned incomplete pagination.');
            offset += page.length;
        }
        return { type: 'FeatureCollection', features: [...byId.values()], complete: true, sourceId: id, returnsWGS84: true };
    }

    function queryBounds(bbox) {
        validateBounds(bbox, maxBboxKm2);
        return query({ geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (!validNativeId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            // Native string keys must retain leading zeroes and use SQL string literals.
            return idType === 'string' ? `'${tail.replaceAll("'", "''")}'` : tail;
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
