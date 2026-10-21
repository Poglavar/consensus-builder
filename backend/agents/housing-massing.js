// Shared schematic courtyard/compact massing, measured from the actual footprint.
const finite = value => typeof value === "number" && Number.isFinite(value);
export function massingFor(parcel, form, rule, turf) {
    if (!finite(rule.floors) || rule.floors < 1 || !finite(rule.setbackM)) return null;
    if (finite(rule.minPlotM2) && parcel.areaM2 < rule.minPlotM2) return null;
    const ground = turf.feature(parcel.geometry);
    const envelope = rule.setbackM > 0 ? turf.buffer(ground, -rule.setbackM, { units: 'meters', steps: 4 }) : ground;
    if (!envelope || turf.area(envelope) < 80) return null;
    let footprint;
    if (form === 'courtyard') {
        const inner = turf.buffer(envelope, -10, { units: 'meters', steps: 4 });
        if (!inner || turf.area(inner) < 150) return null;
        footprint = turf.difference(envelope, inner);
    } else {
        // Clip a scaled compact mass to its envelope: scaling a concave parcel alone can spill.
        footprint = turf.intersect(turf.transformScale(envelope, 0.72), envelope);
    }
    if (!footprint) return null;
    const allowedFootprint = Math.min(
        finite(rule.coveragePct) ? parcel.areaM2 * rule.coveragePct / 100 : Infinity,
        finite(rule.maxGfaM2) ? rule.maxGfaM2 : Infinity
    );
    if (!(allowedFootprint > 0)) return null;
    // Resize geometry itself. Counts, finance, exported proposal and map then measure one shape.
    for (let step = 0; turf.area(footprint) > allowedFootprint + 0.01 && step < 6; step++) {
        footprint = turf.intersect(turf.transformScale(footprint, Math.sqrt(allowedFootprint / turf.area(footprint)) * 0.999), envelope);
        if (!footprint) return null;
    }
    const footprintM2 = turf.area(footprint);
    if (footprintM2 < 80 || footprintM2 > allowedFootprint + 0.1) return null;
    const floors = Math.min(Math.floor(rule.floors), finite(rule.maxGfaM2) ? Math.floor(rule.maxGfaM2 / footprintM2 + 1e-9) : rule.floors);
    if (floors < 1) return null;
    footprint.properties = { floors, height: floors * 3, form };
    return { massing: footprint, floors, footprintM2, gfaM2: footprintM2 * floors, coveragePct: footprintM2 / parcel.areaM2 * 100 };
}
