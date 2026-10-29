// The exact geometry build shipped to the browser. npm's modular Turf dependency graph can resolve
// a different polygon clipper from the vendored browser bundle, changing a ground piece's hash.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
const source = readFileSync(new URL('../../frontend/vendor/turf-6.5.0/turf.min.js', import.meta.url), 'utf8');
export function installAppGeometry(context) {
    runInContext(source, context, { filename: 'turf-6.5.0/turf.min.js', timeout: 10_000 });
    return context.turf;
}
const context = createContext({ structuredClone, performance, URL, TextEncoder, Uint8Array, Buffer });
context.window = context;
export const appTurf = installAppGeometry(context);
runInContext(readFileSync(new URL('../../frontend/vendor/proj4-2.22.0/proj4.js', import.meta.url), 'utf8'), context, { timeout: 10_000 });
runInContext(readFileSync(new URL('../../frontend/vendor/noble-hashes-1.8.0/sha256.js', import.meta.url), 'utf8'), context, { timeout: 10_000 });
const frontend = new URL('../../frontend/js/', import.meta.url);
for (const path of ['cid.js', 'metric-frame.js', 'local-frame.js', 'footprint-geometry.js', 'corridor-profile.js', 'corridor-osm-form.js', 'corridor-junction.js',
    'corridor-transition.js', 'proposals/corridor-levels.js', 'corridor-footprint.js', 'corridor-clearance.js', 'corridor-tunnel.js',
    'corridor-geometry.js', 'proposals/corridor-authoring.js', 'proposals/formation-depth.js',
    'design-record.js', 'parcel-layout-validation.js', 'parcel-layout-layouts.js', 'reparcellization-slice.js', 'proposals/site-plots.js',
    'parcels/schelling-grid.js', 'proposals/corridor-site-centreline.js', 'proposals/corridor-site-fit.js', 'proposals/road-in-site.js', 'single-building-geometry.js', 'park-planting.js', 'urban-rule-variation.js', 'building-rule-geometry.js', 'vendor/transit-station-models.js', 'transit-stations.js', 'intent-editing.js', 'intent-design.js']) {
    const url = new URL(path, frontend);
    context.require = createRequire(url);
    runInContext(readFileSync(url, 'utf8'), context, { filename: path, timeout: 10_000 });
}
// Projection dependencies belong to the runtime, never the caller's cwd or a polluted global.
export const intentDesign = context.IntentDesign;
export const intentEditing = context.IntentEditing;
export const corridorRuntime = {
    authoring: context.CorridorAuthoring,
    geometry: context.CorridorGeometry,
    osm: context.__corridorOsmForm,
    footprint: context.__corridorFootprint
};

// Thin adapters call these same app generators; no parallel construction geometry.
export const constructorRuntime = {
    record: context.DesignRecord, singleBuilding: context.SingleBuildingGeometry, footprints: context.FootprintGeometry, rules: context.UrbanRuleVariation,
    buildingRules: context.BuildingRuleGeometry, stations: context.TransitStations, sitePlots: context.__sitePlots
};
