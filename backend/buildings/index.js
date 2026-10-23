// Source-addressed building services. The caller selects a dataset; geography never selects one.
import { createZagrebProvider } from './zagreb-3d.js';
import { createNycProvider } from './nyc-footprints.js';
import { createNycArcgisProvider } from './nyc-arcgis.js';
import { createOsmProvider } from './osm-3d.js';
import { createCustomBuildingProvider } from './custom-source-3d.js';
import { createOverpassBuildingProvider } from './overpass-source.js';
import { decodeCustomBuildingSource } from '../parcels/custom-source-config.js';

export function createBuildingProviders(pool, env = process.env) {
    const providers = new Map([
        ['gdi-3d', createZagrebProvider(pool)],
        ['nyc-arcgis', createNycArcgisProvider(env)],
        ['nyc-socrata', createNycProvider(env)],
        ['osm', createOsmProvider(pool)]
    ]);
    const customProviders = new Map();
    function resolveSource(sourceId) {
        if (providers.has(sourceId)) return providers.get(sourceId);
        if (typeof sourceId !== 'string' || !sourceId.startsWith('building.')) {
            throw Object.assign(new Error('Choose an explicit building source.'), { status: 400, code: 'invalid-building-source' });
        }
        const descriptor = decodeCustomBuildingSource(sourceId);
        if (!customProviders.has(descriptor.id)) {
            if (customProviders.size >= 100) customProviders.delete(customProviders.keys().next().value);
            customProviders.set(descriptor.id, descriptor.adapter === 'overpass'
                ? createOverpassBuildingProvider(descriptor)
                : createCustomBuildingProvider(descriptor));
        }
        return customProviders.get(descriptor.id);
    }
    return { resolveSource, forRequest: ({ source } = {}) => resolveSource(source) };
}
