// Registry of per-city 3D building providers. Each city has its own idiosyncratic source
// (Zagreb: a PostGIS LOD2 mesh table; NYC: live footprint+height feeds), but every
// provider exposes near(), footprints() and footprintsUnder(), returning buildings in
// one common face-mesh shape, so the route and the frontend renderer stay source-agnostic.
// Adding a city = one new provider file + one line in createBuildingProviders(), OR — for any
// city that has no bespoke local model — one entry in overture-cities.js, which gets wired to the
// shared Overture provider automatically below. Every other city, explore included, gets the
// OpenStreetMap provider (osm-3d.js) here. The app itself no longer asks for those cities: their
// config says 'overture-tiles', which the browser reads straight from Overture's public tiles
// (frontend/js/overture-tiles.js); this provider still answers other callers.
//
// A request names no city: its geometry does (location-first.md). The city whose data applies there
// (jurisdiction.js, the rule the boot and the globe share) picks the provider; nowhere covered is
// explore, which gets OSM.

import { createZagrebProvider } from './zagreb-3d.js';
import { createNycProvider } from './nyc-footprints.js';
import { createNycArcgisProvider } from './nyc-arcgis.js';
import { createOvertureProvider } from './overture-3d.js';
import { OVERTURE_CITIES } from './overture-cities.js';
import { createOsmProvider } from './osm-3d.js';
import { createCustomBuildingProvider } from './custom-source-3d.js';
import { createOverpassBuildingProvider } from './overpass-source.js';
import { decodeCustomBuildingSource } from '../parcels/custom-source-config.js';
import { jurisdictionOf } from '../jurisdiction.js';

const NO_CITY = 'explore';

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

    // A city id to its provider: its own, else OSM; no city (explore) is OSM too, and a malformed id
    // has none.
    function resolve(cityId) {
        if (cityId === undefined || cityId === null || cityId === '') return osmProviderFor(NO_CITY);
        return providers[cityId] || osmProviderFor(cityId);
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

    // The provider for a request: its own `source` when it names one, else that of the city whose
    // data applies where `geometry` lies. A city the client sends is not consulted.
    function forRequest({ source, geometry } = {}) {
        if (typeof source === 'string' && source) return resolveSource(source);
        return resolve(jurisdictionOf(geometry));
    }

    return { resolve, resolveSource, forRequest };
}
