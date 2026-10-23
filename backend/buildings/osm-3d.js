// The default 3D building provider, for every city without a bespoke or Overture source, including
// the anywhere-on-Earth "explore" city: OpenStreetMap footprints, from the staged copy in the shared
// overture_building_footprint table where one exists, else live Overpass (osm-reference.js, cached
// per grid cell). Each footprint is extruded to a flat-top block at its measured height, else its
// storeys × 3 m, else a seeded estimate (building-heights.js); every block carries `height_source`
// so an estimate is never mistaken for a survey. Same near/footprints/footprintsUnder contract as
// the Overture provider, so the route and renderer stay source-agnostic.

import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { fetchOsmBuildings } from './osm-reference.js';
import { fetchStagedOsmBuildings } from './osm-staged.js';

const require = createRequire(import.meta.url);
// The provider core (extrusion, footprints, demolition scan) is shared with the browser, which runs
// it over Overture's public tiles: frontend/js/footprint-provider.js.
const core = require('../../frontend/js/footprint-provider.js');

export const { expandBbox, footprintFeatureToBuilding, unavailableFrom } = core;

const log = (...args) => console.log(`[${new Date().toISOString()}] [osm-3d]`, ...args);

export function createOsmProvider(pool, {
    fetchLive = fetchOsmBuildings,
    fetchStaged = fetchStagedOsmBuildings
} = {}) {
    async function featuresIn(bbox) {
        const staged = await fetchStaged(pool, bbox).catch(error => {
            log('staged lookup failed, using Overpass:', error.message);
            return null;
        });
        return staged || await fetchLive(bbox);
    }

    return core.createFootprintProvider({
        turf,
        featuresIn,
        label: 'osm',
        log,
        sources: { near: 'osm-3d', footprints: 'osm-footprints' }
    });
}
