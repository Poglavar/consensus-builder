// Source-addressed building services. The caller selects a dataset; geography never selects one.
import { createZagrebProvider } from './zagreb-3d.js';
import { createDguProvider } from './dgu-cadastre.js';
import { createNycProvider } from './nyc-footprints.js';
import { createNycArcgisProvider } from './nyc-arcgis.js';
import { createOsmProvider } from './osm-3d.js';
import { createCustomBuildingProvider } from './custom-source-3d.js';
import { createOverpassBuildingProvider } from './overpass-source.js';
import { createWienLod2Provider } from './wien-lod2.js';
import { decodeCustomBuildingSource } from '../parcels/custom-source-config.js';

import { createRequire } from 'node:module';
const SourceRuntime = createRequire(import.meta.url)('../../frontend/js/source-runtime.js');

const builtins = [
    ['wien-lod2', 'wien-lod2'],
    ['gdi-3d', 'gdi-3d'], ['dgu', 'dgu'], ['nyc-arcgis', 'nyc-arcgis'], ['nyc-socrata', 'nyc-socrata'], ['osm', 'osm']
];
export const buildingSourceRegistry = SourceRuntime.createRegistry({
    abstraction: 'buildings',
    adapters: {
        'gdi-3d': { create: (_config, { pool }) => createZagrebProvider(pool), custom: false },
        dgu: { create: (_config, { pool }) => createDguProvider(pool), custom: false },
        'nyc-arcgis': { create: (_config, { env }) => createNycArcgisProvider(env), custom: false },
        'nyc-socrata': { create: (_config, { env }) => createNycProvider(env), custom: false },
        osm: { create: (_config, { pool }) => createOsmProvider(pool), custom: false },
        'wien-lod2': { create: () => createWienLod2Provider(), custom: false },
        arcgis: { create: createCustomBuildingProvider },
        wfs: { create: createCustomBuildingProvider },
        'ogc-api': { create: createCustomBuildingProvider },
        socrata: { create: createCustomBuildingProvider },
        'geojson-snapshot': { create: createCustomBuildingProvider },
        overpass: { create: createOverpassBuildingProvider }
    },
    sources: builtins.map(([id, adapter]) => SourceRuntime.source('buildings', adapter, { id })),
    required: ['near', 'footprints', 'footprintsUnder']
});

export function createBuildingProviders(pool, env = process.env) {
    const providers = new Map(builtins.map(([id]) => [id, buildingSourceRegistry.open(id, { pool, env })]));
    const customProviders = new Map();
    function resolveSource(sourceId) {
        if (providers.has(sourceId)) return providers.get(sourceId);
        if (typeof sourceId !== 'string' || !sourceId.startsWith('building.')) {
            throw Object.assign(new Error('Choose an explicit building source.'), { status: 400, code: 'invalid-building-source' });
        }
        const descriptor = decodeCustomBuildingSource(sourceId);
        if (!customProviders.has(descriptor.id)) {
            if (customProviders.size >= 100) customProviders.delete(customProviders.keys().next().value);
            customProviders.set(descriptor.id, buildingSourceRegistry.open(
                SourceRuntime.source('buildings', descriptor.adapter, descriptor, { kind: 'custom' })));
        }
        return customProviders.get(descriptor.id);
    }
    return { resolveSource, forRequest: ({ source } = {}) => resolveSource(source) };
}
