// Registry of per-city 3D building providers. Each city has its own idiosyncratic source
// (Zagreb: a PostGIS LOD2 mesh table; NYC: live footprint+height feeds), but every
// provider exposes the same `near(geometry, bufferMeters)` contract and returns buildings in
// one common face-mesh shape, so the route and the frontend renderer stay source-agnostic.
// Adding a city = one new provider file + one line in createBuildingProviders(), OR — for any
// city that has no bespoke local model — one entry in overture-cities.js, which gets wired to the
// shared Overture provider automatically below. Every other city, explore included, gets the
// OpenStreetMap provider (osm-3d.js): OSM is the default source for everybody.

import { createZagrebProvider } from './zagreb-3d.js';
import { createNycProvider } from './nyc-footprints.js';
import { createNycArcgisProvider } from './nyc-arcgis.js';
import { createOvertureProvider } from './overture-3d.js';
import { OVERTURE_CITIES } from './overture-cities.js';
import { createOsmProvider } from './osm-3d.js';
import { createCustomBuildingProvider } from './custom-source-3d.js';
import { createOverpassBuildingProvider } from './overpass-source.js';
import { decodeCustomBuildingSource } from '../parcels/custom-source-config.js';

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

    // One OSM provider per city id, made on first use. The id is validated because it becomes a
    // cache key and a staged-table label.
    const osmProviders = new Map();
    function osmProviderFor(cityId) {
        if (typeof cityId !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(cityId)) return null;
        if (!osmProviders.has(cityId)) osmProviders.set(cityId, createOsmProvider(pool, cityId));
        return osmProviders.get(cityId);
    }

    // Resolve a city id (as sent by the frontend's CityConfigManager) to its provider. A caller that
    // omits `city` keeps the historical Zagreb default; a named city without its own provider gets
    // OSM. (It used to get Zagreb's provider too, which answers nothing outside Zagreb.)
    function resolve(cityId) {
        if (cityId === undefined || cityId === null || cityId === '') return providers[DEFAULT_CITY] || null;
        return providers[cityId] || osmProviderFor(cityId);
    }

    // The same answer for capability checks (does this city have footprint data?): every valid city
    // has OSM, and a malformed id has nothing.
    function resolveExact(cityId) {
        return resolve(cityId);
    }

    // A user-chosen building source (`building.<base64url>`), decoded and validated on every use;
    // one provider per id, bounded like the parcel gateway's runtime cache. Throws 400 on a bad id.
    const customProviders = new Map();
    function resolveSource(sourceId) {
        const descriptor = decodeCustomBuildingSource(sourceId);
        if (!customProviders.has(descriptor.id)) {
            if (customProviders.size >= 100) customProviders.delete(customProviders.keys().next().value);
            customProviders.set(descriptor.id, descriptor.adapter === 'overpass'
                ? createOverpassBuildingProvider(descriptor)
                : createCustomBuildingProvider(descriptor));
        }
        return customProviders.get(descriptor.id);
    }

    // The provider for a request body: its own `source` when it names one, else its city's.
    function forRequest({ city, source } = {}) {
        if (typeof source === 'string' && source) return resolveSource(source);
        return resolve(city);
    }

    return { resolve, resolveExact, resolveSource, forRequest };
}
