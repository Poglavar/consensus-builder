// TASPRO spatial filters have a high fixed cost. Share complete bounded reads between
// adjacent viewport cells; exact UUID reads always go back to the provider.
import { bbox as geometryBbox, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { validateBounds, validateGeometry, upstreamError } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';

export function createTasproWfsSource(descriptor, options, createWfsSource) {
    const { wfsProfile, boundsCacheCellSize: step, ...base } = descriptor;
    if (wfsProfile !== 'taspro-grid-cache-v1' || descriptor.featureType !== 'taspro:spatial_units'
        || descriptor.idField !== 'uid' || descriptor.geometryField !== 'geom'
        || descriptor.sortField !== 'id' || descriptor.requestProperties !== true
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== 'uid'
        || !Number.isFinite(step) || step < 0.001 || step > 0.005
        || descriptor.minRequestIntervalMs === undefined) throw new Error('Invalid TASPRO WFS profile.');
    const source = createWfsSource(base, options);
    const cache = new Map();
    const ttlMs = 60_000;
    const maxEntries = 64;
    const coordinate = value => Number(value.toFixed(10));
    const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

    function tile(x, y) {
        const key = `${x},${y}`;
        let entry = cache.get(key);
        if (entry && entry.expiresAt <= Date.now()) { cache.delete(key); entry = null; }
        if (entry) return entry.promise;
        if (cache.size >= maxEntries) {
            const settled = [...cache].find(([, value]) => Number.isFinite(value.expiresAt));
            if (!settled) throw upstreamError('Too many pending TASPRO parcel regions.');
            cache.delete(settled[0]);
        }
        const bounds = [x * step, y * step, (x + 1) * step, (y + 1) * step].map(coordinate);
        // A failed/incomplete read is never retained as an empty or complete region.
        entry = { expiresAt: Infinity };
        entry.promise = source.queryBounds(bounds).then(result => {
            if (result.complete !== true || !Array.isArray(result.features)) throw upstreamError('Incomplete TASPRO parcel region.');
            entry.expiresAt = Date.now() + ttlMs;
            return result;
        }).catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
        cache.set(key, entry);
        return entry.promise;
    }

    async function queryBounds(bounds, { signal } = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        signal?.throwIfAborted();
        const [west, south, east, north] = bounds;
        const minX = Math.floor(west / step), maxX = Math.ceil(east / step) - 1;
        const minY = Math.floor(south / step), maxY = Math.ceil(north / step) - 1;
        if ((maxX - minX + 1) * (maxY - minY + 1) > 256) throw new HttpError(400, 'Request fewer TASPRO parcel regions.');
        const features = new Map();
        // Provider requests are serialized by the existing shared WFS endpoint queue.
        for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
            signal?.throwIfAborted();
            const result = await tile(x, y);
            signal?.throwIfAborted();
            for (const feature of result.features) {
                if (!overlaps(geometryBbox(feature), bounds)) continue;
                const previous = features.get(feature.id);
                if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(feature.geometry)) {
                    throw upstreamError('Conflicting TASPRO parcel geometry across regions.');
                }
                features.set(feature.id, feature);
            }
            if (features.size > (descriptor.maxFeatures ?? 10000)) throw upstreamError('TASPRO parcel limit exceeded; request a smaller area.');
        }
        return { type: 'FeatureCollection', features: [...features.values()], complete: true,
            sourceId: descriptor.id, returnsWGS84: true };
    }

    async function queryGeometry(geometry, options) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const result = await queryBounds(geometryBbox(footprint), options);
        return { ...result, features: result.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryGeometry, queryIds: source.queryIds });
}
