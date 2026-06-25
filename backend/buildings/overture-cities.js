// Registry of cities whose 3D buildings are sourced from Overture Maps' `buildings` theme
// (footprint + optional height/floor-count, ingested into the `overture_feature` table and
// extruded server-side). This is the generic fallback for any city that lacks a bespoke local
// 3D source like Zagreb's LOD2 mesh or NYC's live footprint feed.
//
// Adding a city is two steps:
//   1. Add an entry here (bbox for ingestion + height-extrusion defaults).
//   2. Run `node scripts/ingest-overture.js --city <id> --layer buildings` to populate the table.
// The provider registry (buildings/index.js) wires every key here to the shared Overture provider
// automatically, and the frontend just needs `buildings.source` set so the city is offered in 3D.

export const OVERTURE_CITIES = {
    belgrade: {
        // Lon/lat bounding box used only at ingestion time to pull the city extract from Overture.
        // [minLng, minLat, maxLng, maxLat] — covers Belgrade proper + inner suburbs.
        bbox: [20.30, 44.74, 20.62, 44.90],
        // Height-extrusion fallbacks for buildings Overture has no measured `height` for. Belgrade
        // heights come only from OSM tags, so most buildings fall back to floors×storey or default.
        floorHeightM: 3.2,   // assumed storey height when only num_floors is known
        defaultHeightM: 9    // last-resort height (~3 storeys) when neither height nor floors exist
    }
};

// Effective extruded height for one building, with the source of that height for debugging.
// Preference: a real Overture/OSM height → floors × storey height → city default.
export function effectiveHeight(heightM, numFloors, cfg) {
    if (Number.isFinite(heightM) && heightM > 0) return { height: heightM, source: 'overture' };
    if (Number.isFinite(numFloors) && numFloors > 0) return { height: numFloors * cfg.floorHeightM, source: 'floors' };
    return { height: cfg.defaultHeightM, source: 'default' };
}
