// Static dimensional-rule table for NYC zoning districts, transcribed from the
// Zoning Resolution (Article II Ch.2-3) and DCP residence-district profiles.
// This is the only hand-maintained "content" in the envelope feature: PLUTO
// supplies the per-lot inputs (FAR, lot area, dimensions) and this table supplies
// the per-district envelope parameters (height caps, yards) that no NYC API emits.
//
// SCOPE (V1): contextual (Quality Housing) residence districts only. These have
// HARD numeric max base/building heights in the ZR, so the envelope is an honest
// extrusion — no sky-exposure-plane geometry required. Non-contextual districts
// (R6, R7-2, R8 …) deliberately have NO entry here: they let the developer elect
// Height Factor vs Quality Housing and need a sloped sky-exposure-plane solid,
// which is V2. Such lots fall back to a FAR-only answer (no height geometry).
//
// NOTE: heights are in feet, sourced from the ZR / DCP district profiles. These
// reflect the contextual envelope and are subject to a verification pass against
// the current (post-"City of Yes", Dec 2024) Zoning Resolution before being
// treated as authoritative. Each entry carries the FAR we expect PLUTO's
// `residfar` to match (a cross-check, not the source of truth — PLUTO wins).

// Typical residential floor-to-floor height (ft) used to translate a height cap
// into an approximate maximum floor count.
export const RESIDENTIAL_FLOOR_HEIGHT_FT = 10;

// district code -> envelope dimensional rules
//   expectedResidFar : ZR base residential FAR (cross-check vs PLUTO residfar)
//   maxBaseHeight    : max street-wall height before the required setback (ft)
//   maxBuildingHeight: max overall building height (ft) — the hard cap
//   minRearYardFt    : required rear-yard depth on an interior/through lot (ft)
//   lotCoverage      : max lot coverage fraction (interior lot) for floor-area-vs-footprint sanity
const DISTRICTS = {
    R5D:  { expectedResidFar: 2.0,  maxBaseHeight: 35, maxBuildingHeight: 40,  minRearYardFt: 30, lotCoverage: 0.55 },
    R6A:  { expectedResidFar: 3.0,  maxBaseHeight: 60, maxBuildingHeight: 70,  minRearYardFt: 30, lotCoverage: 0.65 },
    R6B:  { expectedResidFar: 2.0,  maxBaseHeight: 40, maxBuildingHeight: 50,  minRearYardFt: 30, lotCoverage: 0.60 },
    R7A:  { expectedResidFar: 4.0,  maxBaseHeight: 65, maxBuildingHeight: 80,  minRearYardFt: 30, lotCoverage: 0.65 },
    R7B:  { expectedResidFar: 3.0,  maxBaseHeight: 60, maxBuildingHeight: 75,  minRearYardFt: 30, lotCoverage: 0.65 },
    R7D:  { expectedResidFar: 4.2,  maxBaseHeight: 85, maxBuildingHeight: 100, minRearYardFt: 30, lotCoverage: 0.65 },
    R7X:  { expectedResidFar: 5.0,  maxBaseHeight: 85, maxBuildingHeight: 125, minRearYardFt: 30, lotCoverage: 0.70 },
    R8A:  { expectedResidFar: 6.02, maxBaseHeight: 85, maxBuildingHeight: 120, minRearYardFt: 30, lotCoverage: 0.70 },
    R8B:  { expectedResidFar: 4.0,  maxBaseHeight: 65, maxBuildingHeight: 75,  minRearYardFt: 30, lotCoverage: 0.70 },
    R8X:  { expectedResidFar: 6.02, maxBaseHeight: 85, maxBuildingHeight: 150, minRearYardFt: 30, lotCoverage: 0.70 },
    R9A:  { expectedResidFar: 7.52, maxBaseHeight: 95, maxBuildingHeight: 145, minRearYardFt: 30, lotCoverage: 0.70 },
    R10A: { expectedResidFar: 10.0, maxBaseHeight: 125, maxBuildingHeight: 185, minRearYardFt: 30, lotCoverage: 0.70 },
};

// Normalize a PLUTO zoning-district code to a table key. PLUTO stores e.g.
// "R6A", "R8A", and (City of Yes) widened codes; we match on the exact code.
export function normalizeDistrictCode(code) {
    return (code ?? '').toString().trim().toUpperCase();
}

// Return the dimensional rules for a district code, or null if V1 doesn't model
// it (non-contextual or out-of-scope district). null is the signal to fall back
// to a FAR-only answer.
export function getDistrictRules(code) {
    const key = normalizeDistrictCode(code);
    return DISTRICTS[key] ? { code: key, ...DISTRICTS[key] } : null;
}

// Whether this district has a hard height cap we can extrude honestly in V1.
export function isContextualDistrict(code) {
    return getDistrictRules(code) !== null;
}

export const SUPPORTED_DISTRICTS = Object.keys(DISTRICTS);
