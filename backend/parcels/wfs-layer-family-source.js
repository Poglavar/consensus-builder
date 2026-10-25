// Explicit layer families retain GeoServer's layer-qualified native feature IDs.
// Every child uses the same bounded, geometry-only WFS transport in both runtimes.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { validateBounds, validateGeometry, upstreamError } from './source-contract.js';

export function createWfsLayerFamilySource(descriptor, options, createWfsSource) {
    const { featureTypes, idPrefix, maxFeatures = 10000, maxBboxKm2 = 25 } = descriptor;
    if (!Array.isArray(featureTypes) || !featureTypes.length || featureTypes.length > 32
        || new Set(featureTypes).size !== featureTypes.length
        || featureTypes.some(type => typeof type !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*$/.test(type))
        || !featureTypes.includes(descriptor.featureType) || descriptor.nativeIdMode !== 'feature-id'
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 100000) {
        throw new Error('Invalid WFS native feature-ID layer family.');
    }
    const children = new Map();
    for (const featureType of featureTypes) {
        const localName = featureType.split(':')[1];
        if (children.has(localName)) throw new Error('WFS layer family has ambiguous native ID namespaces.');
        children.set(localName, createWfsSource({ ...descriptor, wfsProfile: undefined,
            featureTypes: undefined, featureType, idPattern: `^${localName}\\.[0-9]+$` }, options));
    }

    function collection(features, extra = {}) {
        if (features.length > maxFeatures) throw upstreamError('Parcel layer family exceeds the parcel limit; use a smaller area.');
        if (new Set(features.map(feature => feature.id)).size !== features.length) {
            throw upstreamError('WFS layer family returned repeated native IDs.');
        }
        return { type: 'FeatureCollection', features, complete: true, sourceId: descriptor.id, returnsWGS84: true, ...extra };
    }

    async function queryBounds(bounds) {
        validateBounds(bounds, maxBboxKm2, descriptor);
        const features = [];
        const footprint = bboxPolygon(bounds);
        // Always ask every configured layer: retained capability extents are not a
        // current spatial index and must not imply absence after a provider update.
        for (const child of children.values()) {
            const result = await child.queryBounds(bounds);
            if (result.complete !== true) throw upstreamError('WFS layer family returned incomplete bounds.');
            features.push(...result.features.filter(feature => booleanIntersects(feature, footprint)));
            if (features.length > maxFeatures) throw upstreamError('Parcel layer family exceeds the parcel limit; use a smaller area.');
        }
        return collection(features);
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)], groups = new Map();
        // Validate the whole batch before issuing any provider request. An unknown
        // layer is an invalid reference, rather than evidence of source absence.
        for (const id of unique) {
            const match = typeof id === 'string' && id.startsWith(idPrefix)
                ? /^([A-Za-z_][A-Za-z0-9_]*)\.[0-9]+$/.exec(id.slice(idPrefix.length)) : null;
            if (!match || !children.has(match[1])) throw new HttpError(400, 'Parcel ID belongs to an unknown WFS layer.');
            if (!groups.has(match[1])) groups.set(match[1], []);
            groups.get(match[1]).push(id);
        }
        const features = [], absentIds = [];
        for (const [layer, batch] of groups) {
            const result = await children.get(layer).queryIds(batch);
            if (result.complete !== true) throw upstreamError('WFS layer family returned incomplete exact IDs.');
            features.push(...result.features);
            absentIds.push(...result.absentIds);
        }
        return collection(features, { absentIds });
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const result = await queryBounds(geometryBbox(geometry));
        return { ...result, features: result.features.filter(feature => booleanIntersects(feature, geometry)) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
