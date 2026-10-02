// Adapts a fixed WFS 2.0 GeoJSON layer to the same complete WGS84 parcel contract as ArcGIS.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { upstreamError, validateBounds, validateGeometry, canonicalParcelFeature } from './source-contract.js';

export function createWfsParcelSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const { id, endpoint, featureType, idField, idPrefix, outFields } = descriptor;
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!id || !idPrefix || !identifier.test(idField) || descriptor.idType !== 'string'
        || !/^[A-Za-z0-9_.]+:[A-Za-z0-9_]+$/.test(featureType)
        || !Array.isArray(outFields) || !outFields.includes(idField)
        || (descriptor.parcelNumberField && !outFields.includes(descriptor.parcelNumberField))
        || new URL(endpoint).protocol !== 'https:') throw new Error('Invalid WFS parcel source descriptor.');
    const idPattern = descriptor.idPattern ? new RegExp(descriptor.idPattern) : null;
    const pageSize = descriptor.pageSize || 1000;
    const maxFeatures = descriptor.maxFeatures || 10000;
    const maxBboxKm2 = descriptor.maxBboxKm2 || 25;
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
        && (!idPattern || idPattern.test(value));

    async function query(params) {
        const byId = new Map();
        const seenObjects = new Set();
        let offset = 0;
        let matched;
        for (;;) {
            const search = new URLSearchParams({
                service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: featureType,
                outputFormat: 'application/json', srsName: 'CRS:84', sortBy: idField,
                count: String(pageSize), startIndex: String(offset), ...params
            });
            const signal = AbortSignal.timeout(15000);
            let payload;
            try {
                const response = await fetchImpl(`${endpoint}?${search}`, { signal, headers: { Accept: 'application/geo+json, application/json' } });
                if (!response.ok) throw upstreamError(`Parcel provider returned HTTP ${response.status}.`);
                payload = await response.json();
            } catch (error) {
                if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw upstreamError('Parcel provider timed out.', 504);
                if (error.status) throw error;
                throw upstreamError(`Parcel provider is unavailable: ${error.message}`);
            }
            if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw upstreamError('WFS parcel provider returned an invalid FeatureCollection.');
            const page = payload.features;
            if (!Number.isSafeInteger(payload.numberMatched) || payload.numberMatched < 0
                || payload.numberReturned !== page.length || (matched !== undefined && payload.numberMatched !== matched)) {
                throw upstreamError('WFS parcel provider returned missing, inconsistent or changing match counts.');
            }
            matched = payload.numberMatched;
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
        validateBounds(bbox, maxBboxKm2);
        // CRS:84 fixes longitude/latitude order for both the filter and the GeoJSON response.
        return query({ bbox: `${bbox.join(',')},CRS:84` });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        const native = unique.map(value => {
            if (typeof value !== 'string' || !value.startsWith(idPrefix)) throw new HttpError(400, 'Parcel ID belongs to a different source.');
            const tail = value.slice(idPrefix.length);
            if (!validId(tail)) throw new HttpError(400, 'Invalid parcel ID.');
            return `'${tail.replaceAll("'", "''")}'`;
        });
        const result = await query({ cql_filter: `${idField} IN (${native.join(',')})` });
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
