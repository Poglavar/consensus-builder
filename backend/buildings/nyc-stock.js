// Both NYC feeds expose the same footprint evidence as their 3D source. The shared engine
// supplies containment and intersection queries, preserving holes and partial source coverage.
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFootprintProvider } = require('../../frontend/js/footprint-provider.js');

export function createNycStockProvider({ source, featuresIn }) {
    const cache = new Map();
    return createFootprintProvider({
        turf,
        sources: { near: source, footprints: source },
        async featuresIn(bbox) {
            const key = bbox.join(',');
            const cached = cache.get(key);
            if (cached && Date.now() - cached.at < 300000) return cached.result;
            const raw = await featuresIn(bbox);
            let incomplete = false;
            const features = raw.features.flatMap(feature => {
                const props = feature.properties || {};
                const id = props.BIN || props.bin || props.DOITT_ID || props.doitt_id || props.OBJECTID || props.objectid;
                if (!id || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) {
                    incomplete = true;
                    return [];
                }
                const feet = props.HEIGHT_ROOF ?? props.height_roof;
                const height = feet == null ? null : Number(feet);
                return [{ type: 'Feature', id: String(id), geometry: feature.geometry,
                    properties: { measured_height_m: Number.isFinite(height) && height > 0 ? height * 0.3048 : null } }];
            });
            const result = { features, truncated: raw.truncated === true || incomplete };
            if (cache.size >= 200) cache.delete(cache.keys().next().value);
            cache.set(key, { at: Date.now(), result });
            return result;
        }
    });
}
