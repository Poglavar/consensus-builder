// Registry of per-city 3D building providers. Each city has its own idiosyncratic source
// (Zagreb: a PostGIS LOD2 mesh table; NYC: live footprint+height feeds), but every
// provider exposes the same `near(geometry, bufferMeters)` contract and returns buildings in
// one common face-mesh shape, so the route and the frontend renderer stay source-agnostic.
// Adding a city = one new provider file + one line in createBuildingProviders(), OR — for any
// city that has no bespoke local model — one entry in overture-cities.js, which gets wired to the
// shared Overture provider automatically below.

import { createZagrebProvider } from './zagreb-3d.js';
import { createNycProvider } from './nyc-footprints.js';
import { createNycArcgisProvider } from './nyc-arcgis.js';
import { createOvertureProvider } from './overture-3d.js';
import { OVERTURE_CITIES } from './overture-cities.js';

const DEFAULT_CITY = 'zagreb';

export function createBuildingProviders(pool, env = process.env) {
    const nycProvider = String(env.NYC_BUILDINGS_SOURCE || 'arcgis').toLowerCase() === 'socrata'
        ? createNycProvider(env)
        : createNycArcgisProvider(env);

    const providers = {
        zagreb: createZagrebProvider(pool),
        new_york: nycProvider
    };

    // Every city declared in overture-cities.js gets the generic Overture provider. A bespoke
    // provider above wins if a city id appears in both (none currently do).
    for (const cityId of Object.keys(OVERTURE_CITIES)) {
        if (!providers[cityId]) providers[cityId] = createOvertureProvider(pool, cityId);
    }

    // Resolve a city id (as sent by the frontend's CityConfigManager) to its provider.
    // Falls back to Zagreb so existing callers that omit `city` keep working unchanged.
    function resolve(cityId) {
        return providers[cityId] || providers[DEFAULT_CITY] || null;
    }

    return { resolve };
}
