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
