// Existing-stock totals need a named source and complete inventory coverage. Observed features
// are evidence of presence, but an empty query alone is not evidence of an empty parcel.
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function buildingBaseline(input = {}) {
    input = input && typeof input === 'object' ? input : {};
    const buildingSourceId = typeof input.buildingSourceId === 'string' && input.buildingSourceId.trim()
        ? input.buildingSourceId.trim() : null;
    const buildingCoverage = ['complete', 'partial'].includes(input.buildingCoverage) ? input.buildingCoverage : 'unknown';
    const complete = buildingSourceId !== null && buildingCoverage === 'complete';
    const count = complete ? nonnegative(input.buildingCount) : null;
    const builtFootprintM2 = complete ? nonnegative(input.builtFootprintM2) : null;
    const builtGfaM2 = complete && input.builtKnown !== false ? nonnegative(input.builtGfaM2) : null;
    return {
        buildingSourceId, buildingCoverage,
        buildingCount: Number.isInteger(count) ? count : null,
        builtFootprintM2, builtGfaM2, builtKnown: builtGfaM2 !== null
    };
}
