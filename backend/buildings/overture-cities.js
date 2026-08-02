// Registry of cities whose 3D buildings are sourced from Overture Maps' `buildings` theme
// (footprint + optional height/floor-count) — the generic fallback for any city that lacks a bespoke
// local 3D source like Zagreb's LOD2 mesh or NYC's live footprint feed.
//
// The footprints themselves live in the SHARED `public.overture_building_footprint` table, ingested
// by cadastre-data (`buildings/fetch-overture-buildings.js`) and also read by zagreb-isochrone's 3D
// world. This app used to keep a second copy in its own `overture_feature` table, from its own
// DuckDB ingest — Split existed twice, byte-for-byte, and each city had to be ingested twice to be
// visible in both apps. There is now ONE table and ONE ingestion; this file only declares which
// slice of it a city reads, plus this app's extrusion policy.
//
// Adding a city is two steps:
//   1. Ingest its area once, in cadastre-data:
//        node buildings/fetch-overture-buildings.js --run --city <region> [--bbox W,S,E,N]
//   2. Add an entry here naming that `region`, then set `buildings.source` in the frontend's
//      city-config.js so the city is offered in 3D.
// The provider registry (buildings/index.js) wires every key here to the shared Overture provider
// automatically.
//
// Optional per-city keys:
//   greeneryTreeSpacingM — scatter spacing (real metres) for trees planted through `osm_decor`
//                          greenery polygons; default 12. See decor/overture-trees.js.

export const OVERTURE_CITIES = {
    belgrade: {
        // Row set in overture_building_footprint (its `city` column). Usually the same string as the
        // CityConfigManager id, but not always: cadastre-data ingests by AREA, so several cities can
        // share one regional ingest (see sibenik).
        region: 'belgrade',
        // Height-extrusion fallbacks for buildings Overture has no measured `height` for. Belgrade
        // heights come only from OSM tags, so most buildings fall back to floors×storey or default.
        floorHeightM: 3.2,   // assumed storey height when only num_floors is known
        defaultHeightM: 9    // last-resort height (~3 storeys) when neither height nor floors exist
    },
    split: {
        // cadastre-data's `split` ingest: the whole Trogir → Kaštela bay → Split/Solin conurbation,
        // incl. Čiovo (bbox 16.20,43.45,16.55,43.60).
        region: 'split',
        // Dalmatian stock is mostly 2–3 storey stone/masonry with ~3 m storeys.
        floorHeightM: 3.0,
        defaultHeightM: 8
    },
    sibenik: {
        // Not a Šibenik-only ingest: cadastre-data pulled the whole Zadar–Šibenik–Knin area
        // (bbox 15.15,43.65,16.30,44.20) for the M606/M607/L211 railway reconstructions, and the
        // Šibenik–Vodice coast sits inside it. Reusing that row set is the point — a `sibenik`
        // ingest would re-download buildings this table already holds.
        region: 'sjeverna-dalmacija',
        // Same Dalmatian stone/masonry stock as Split.
        floorHeightM: 3.0,
        defaultHeightM: 8
    }
};

// Effective extruded height for one building, with the source of that height for debugging.
// Preference: a real Overture/OSM height → floors × storey height → city default.
export function effectiveHeight(heightM, numFloors, cfg) {
    if (Number.isFinite(heightM) && heightM > 0) return { height: heightM, source: 'overture' };
    if (Number.isFinite(numFloors) && numFloors > 0) return { height: numFloors * cfg.floorHeightM, source: 'floors' };
    return { height: cfg.defaultHeightM, source: 'default' };
}
