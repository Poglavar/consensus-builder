// Height policy for an explicitly configured footprint source.
// Effective extruded height for one building, with the source of that height for debugging.
// Preference: a real Overture/OSM height → floors × storey height → city default.
export function effectiveHeight(heightM, numFloors, cfg) {
    if (Number.isFinite(heightM) && heightM > 0) return { height: heightM, source: 'overture' };
    if (Number.isFinite(numFloors) && numFloors > 0) return { height: numFloors * cfg.floorHeightM, source: 'floors' };
    return { height: cfg.defaultHeightM, source: 'default' };
}
