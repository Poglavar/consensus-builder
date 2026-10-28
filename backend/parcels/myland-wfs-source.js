// Adjacent viewport cells share a small, live MyLand read instead of queuing one
// slow provider round trip per cell. Exact-ID reads always reach the provider.
import { bbox as geometryBbox } from '@turf/turf';
import { validateBounds } from './source-contract.js';

export const MYLAND_SOURCE_ID = 'my-sabah-myland-lot-ml12';
export const MYLAND_ENDPOINT = 'https://myland.gov.my/geoserver/ml12/wfs';
export function isMylandWfsSource(descriptor) {
    return descriptor?.id === MYLAND_SOURCE_ID && descriptor.adapter === 'wfs'
        && descriptor.endpoint === MYLAND_ENDPOINT && descriptor.featureType === 'ml12:lot';
}

export function createMylandWfsSource(descriptor, options, createWfs, { now = Date.now } = {}) {
    if (!isMylandWfsSource(descriptor)) throw new Error('Invalid MyLand WFS profile.');
    const base = createWfs({ ...descriptor, wfsProfile: undefined }, options);
    const blocks = new Map();
    const step = 0.005, ttlMs = 60000;
    const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 25, descriptor);
        // Larger deliberate area reads retain the base adapter's exact query limits.
        if (bounds[2] - bounds[0] > step || bounds[3] - bounds[1] > step) return base.queryBounds(bounds);
        const box = bounds.map((value, index) => Number(((index < 2 ? Math.floor : Math.ceil)(value / step) * step).toFixed(8)));
        try { validateBounds(box, descriptor.maxBboxKm2 ?? 25, descriptor); }
        catch { return base.queryBounds(bounds); }
        const key = box.join(',');
        let entry = blocks.get(key);
        if (entry && entry.expiresAt <= now()) { blocks.delete(key); entry = null; }
        if (!entry) {
            while (blocks.size >= 8) blocks.delete(blocks.keys().next().value);
            entry = { expiresAt: Infinity };
            const current = entry;
            current.promise = base.queryBounds(box).then(result => {
                current.expiresAt = now() + ttlMs;
                return { result, boxes: result.features.map(feature => geometryBbox(feature)) };
            }, error => { if (blocks.get(key) === current) blocks.delete(key); throw error; });
            blocks.set(key, current);
        }
        const { result, boxes } = await entry.promise;
        // Filter whole source polygons to the requested envelope; never clip or alter vertices.
        return { ...result, features: result.features.filter((_feature, index) => intersects(boxes[index], bounds)) };
    }
    return Object.freeze({ ...base, queryBounds });
}
