// Computes an as-of-right maximum buildable envelope for an NYC lot from its
// PLUTO attributes + the district rules table. This is the V1 "first-pass"
// envelope: FAR-driven max floor area plus, for contextual districts, a hard
// height cap and an approximate floor count. It is intentionally honest about
// what it does NOT model (sky-exposure-plane lots, special districts, split
// zoning, zoning-lot mergers, discretionary actions) via `supported`/`caveats`.

import { getDistrictRules, RESIDENTIAL_FLOOR_HEIGHT_FT } from './districts.js';

function round(n, digits = 0) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

// Given a normalized PLUTO row, return the buildable-envelope summary.
export function computeEnvelope(pluto) {
    if (!pluto) return null;

    const district = pluto.zonedist1 || null;
    const rules = getDistrictRules(district);
    const lotArea = pluto.lotArea;
    const caveats = [];

    // Pick the governing residential FAR. PLUTO's residfar already bakes in the
    // contextual cap, so it is the source of truth; affResFar is the affordable
    // (UAP / Inclusionary) bonus ceiling we surface as an upside scenario.
    const baseFar = pluto.residFar;
    const affordableFar = pluto.affResFar && pluto.affResFar > (baseFar ?? 0) ? pluto.affResFar : null;

    const maxFloorArea = baseFar != null && lotArea != null ? baseFar * lotArea : null;
    const maxFloorAreaAffordable = affordableFar != null && lotArea != null ? affordableFar * lotArea : null;

    // Reasons this lot's answer is FAR-only / approximate.
    let supported = true;
    if (pluto.splitZone) { caveats.push('split-zone lot — FAR/heights vary across the lot; not modelled'); supported = false; }
    if (pluto.spdist1) { caveats.push(`special district ${pluto.spdist1} overrides base rules — not modelled`); supported = false; }
    if (!rules) {
        caveats.push(district
            ? `district ${district} is non-contextual (height-factor / sky-exposure-plane) — height not modelled in V1`
            : 'no residential zoning district on this lot');
        supported = false;
    }

    // Height + floors only when we have a hard-cap contextual district.
    let maxHeightFt = null;
    let maxBaseHeightFt = null;
    let maxFloorsByHeight = null;
    if (rules) {
        maxHeightFt = rules.maxBuildingHeight;
        maxBaseHeightFt = rules.maxBaseHeight;
        maxFloorsByHeight = Math.floor(rules.maxBuildingHeight / RESIDENTIAL_FLOOR_HEIGHT_FT);
    }

    // Which constraint binds: FAR or height? Approximate the FAR-implied floor
    // count using the district's lot-coverage cap as the per-floor footprint.
    let maxFloorsByFar = null;
    let bindingConstraint = null;
    if (maxFloorArea != null && rules && lotArea) {
        const perFloorFootprint = lotArea * rules.lotCoverage;
        maxFloorsByFar = perFloorFootprint > 0 ? Math.floor(maxFloorArea / perFloorFootprint) : null;
        if (maxFloorsByFar != null && maxFloorsByHeight != null) {
            bindingConstraint = maxFloorsByFar <= maxFloorsByHeight ? 'FAR' : 'height';
        }
    } else if (maxFloorArea != null) {
        bindingConstraint = 'FAR';
    }

    // Development upside vs what's already built.
    const builtFloorArea = pluto.bldgArea ?? null;
    const unusedFloorArea = maxFloorArea != null && builtFloorArea != null
        ? Math.max(0, maxFloorArea - builtFloorArea)
        : null;

    return {
        supported,
        district,
        overlays: [pluto.overlay1, pluto.overlay2].filter(Boolean),
        specialDistrict: pluto.spdist1 || null,
        lotArea: round(lotArea),
        far: {
            residential: baseFar,
            commercial: pluto.commFar,
            communityFacility: pluto.facilFar,
            affordableResidential: affordableFar,
        },
        maxFloorArea: round(maxFloorArea),
        maxFloorAreaAffordable: round(maxFloorAreaAffordable),
        maxBaseHeightFt,
        maxHeightFt,
        approxMaxFloors: maxFloorsByHeight,
        approxMaxFloorsByFar: maxFloorsByFar,
        bindingConstraint,
        builtFloorArea: round(builtFloorArea),
        unusedFloorArea: round(unusedFloorArea),
        existingFloors: pluto.numFloors,
        caveats,
        // Always-honest disclaimer the frontend should surface verbatim.
        disclaimer: 'As-of-right estimate from PLUTO + contextual district rules. Not a legal determination. Verify on ZoLa and the NYC Zoning Resolution.',
    };
}
