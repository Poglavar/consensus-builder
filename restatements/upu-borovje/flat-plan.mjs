// The UPU Borovje buildings on their plots (README.md, "Version 1: the plan as drawn"): every traced building
// footprint is fitted inside the plot the plan gives it, so a building is content on its plot and never takes
// ground of its own. The raster trace overhangs two plots slightly (M1-9 by 34.8 m², 5.8 %, and M1-11 by
// 25.5 m², 1.1 %); that edge is clipped. A building that would lose more than 10 % of its footprint or split
// in two is refused: its position then needs a decision of its own. Pure: footprints and plots in, fitted
// footprints out.

export const MAX_TRIMMED_SHARE = 0.1;

const feature = geometry => ({ type: 'Feature', properties: {}, geometry });

/**
 * @param buildings [{ name, geometry }] traced footprints (Polygon)
 * @param plotOf (name) → the plot geometry the plan gives that building
 * @param turf @turf/turf 6.5
 * @returns [{ name, geometry, beforeM2, afterM2, trimmedM2 }] in the order given
 */
export function fitBuildingsToPlots(buildings, plotOf, turf) {
    return buildings.map(({ name, geometry }) => {
        const plot = plotOf(name);
        if (!plot) throw new Error(`Missing intended plot for ${name}.`);
        const beforeM2 = turf.area(feature(geometry));
        const outside = turf.difference(feature(geometry), feature(plot));
        const trimmedM2 = outside ? turf.area(outside) : 0;
        let fitted = geometry;
        if (trimmedM2 > 1e-6) {
            const clipped = turf.intersect(feature(geometry), feature(plot));
            if (!clipped || clipped.geometry.type !== 'Polygon' || turf.area(clipped) < beforeM2 * (1 - MAX_TRIMMED_SHARE)) {
                throw new Error(`${name}: clipping would disconnect the building or remove more than 10%.`);
            }
            fitted = clipped.geometry;
        }
        return { name, geometry: fitted, beforeM2, afterM2: turf.area(feature(fitted)), trimmedM2 };
    });
}

/**
 * The building at the plan's above-ground floor-area limit (kisn): when its footprint × storeys
 * exceeds kisn × its plot's area, the slab is shortened along its long axis about its centroid, so it
 * keeps its depth and stays inside the traced envelope, until it meets the limit. A building within
 * the limit is returned as it is. Pure; areas are geodesic (turf.area), the shortening is done in Web
 * Mercator, which is conformal, so it scales the area by exactly the chosen factor.
 * @param {{ name, geometry, plot, floors, kisn }} building  geometry and plot are Polygons
 * @returns {{ geometry, factor, footprintM2, floorAreaM2, limitM2 }}
 */
export function fitToFloorAreaLimit({ name, geometry, plot, floors, kisn }, turf) {
    const footprintM2 = turf.area(feature(geometry));
    const limitM2 = kisn * turf.area(feature(plot));
    if (footprintM2 * floors <= limitM2) {
        return { geometry, factor: 1, footprintM2, floorAreaM2: footprintM2 * floors, limitM2 };
    }
    const projected = turf.toMercator(feature(geometry)).geometry.coordinates[0];
    // The long axis: the direction of the longest edge of the (near-rectangular) envelope.
    let axis = null, longest = 0;
    for (let i = 1; i < projected.length; i++) {
        const dx = projected[i][0] - projected[i - 1][0], dy = projected[i][1] - projected[i - 1][1];
        const length = Math.hypot(dx, dy);
        if (length > longest) { longest = length; axis = [dx / length, dy / length]; }
    }
    const [cx, cy] = turf.centroid(turf.toMercator(feature(geometry))).geometry.coordinates;
    // A hair under the limit, so the projection round trip cannot tip it over.
    const factor = (limitM2 / (footprintM2 * floors)) * 0.999;
    const shortened = projected.map(([x, y]) => {
        const u = (x - cx) * axis[0] + (y - cy) * axis[1];
        const v = -(x - cx) * axis[1] + (y - cy) * axis[0];
        const su = u * factor;
        return [cx + su * axis[0] - v * axis[1], cy + su * axis[1] + v * axis[0]];
    });
    const result = turf.toWgs84(turf.polygon([shortened])).geometry;
    const outside = turf.difference(feature(result), feature(geometry));
    if (outside && turf.area(outside) > 0.05) throw new Error(`${name}: the shortened building leaves its envelope`);
    const fittedM2 = turf.area(feature(result));
    if (fittedM2 * floors > limitM2) throw new Error(`${name}: ${Math.round(fittedM2 * floors)} m² still exceeds the limit ${Math.round(limitM2)} m²`);
    return { geometry: result, factor, footprintM2: fittedM2, floorAreaM2: fittedM2 * floors, limitM2 };
}
