// Registry of per-city 3D building providers. Each city has its own idiosyncratic source
// (Zagreb: a PostGIS LOD2 mesh table; NYC: a live Socrata footprint+height feed), but every
// provider exposes the same `near(geometry, bufferMeters)` contract and returns buildings in
// one common face-mesh shape, so the route and the frontend renderer stay source-agnostic.
// Adding a city = one new provider file + one line in createBuildingProviders().

import { createZagrebProvider } from './zagreb-3d.js';
import { createNycProvider } from './nyc-footprints.js';

const DEFAULT_CITY = 'zagreb';

export function createBuildingProviders(pool, env = process.env) {
    const providers = {
        zagreb: createZagrebProvider(pool),
        new_york: createNycProvider(env)
    };

    // Resolve a city id (as sent by the frontend's CityConfigManager) to its provider.
    // Falls back to Zagreb so existing callers that omit `city` keep working unchanged.
    function resolve(cityId) {
        return providers[cityId] || providers[DEFAULT_CITY] || null;
    }

    return { resolve };
}
