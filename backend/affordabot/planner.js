// Deterministic schematic alternatives measured from their actual GeoJSON, never from a scalar cap.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const model = require('../../frontend/js/affordabot-model.js');

const finite = value => typeof value === 'number' && Number.isFinite(value);
export const reformDefaults = Object.freeze({ floors: 6, setbackM: 3, coveragePct: 60 });
export function validateReform(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid reform');
    const ranges = { floors: [1, 12], setbackM: [0, 20], coveragePct: [10, 90] };
    for (const [key, value] of Object.entries(input)) {
        if (!ranges[key] || !finite(value) || value < ranges[key][0] || value > ranges[key][1]
            || (key === 'floors' && !Number.isInteger(value))) throw new Error(`Invalid reform: ${key}`);
    }
    return { ...reformDefaults, ...input };
}
function massingFor(parcel, form, rule, turf) {
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
function planningChanges(parcel, variant, assumptions) {
    if (variant.scenario === 'current') return [];
    const changes = [], rule = parcel.planning.rule;
    if (parcel.planning.housingUse === false) changes.push({ field: 'housingUse', from: parcel.planning.landUse?.mark ?? null, to: 'residential-or-mixed' });
    const compare = (field, from, to, direction = 1) => {
        if (finite(from) && finite(to) && direction * to > direction * from + 0.01) changes.push({ field, from, to });
    };
    compare('floors', rule?.maxFloors, variant.floors);
    compare('setbackM', rule?.minSetbackM, variant.setbackM, -1);
    compare('coveragePct', variant.form === 'compact' ? rule?.maxCoveragePct ?? rule?.maxDetachedCoveragePct : rule?.maxCoveragePct, variant.coveragePct);
    compare('maxGfaM2', rule?.maxGfaM2, variant.gfaM2);
    compare('maxKisn', variant.form === 'compact' ? rule?.maxKisn ?? rule?.maxDetachedKisn : rule?.maxKisn, variant.gfaM2 / parcel.areaM2);
    compare('maxUnits', rule?.maxUnits, variant.finance.homes);
    compare('parkingPerHome', rule?.minParkingPerUnit, assumptions.parkingPerHome, -1);
    if (Array.isArray(rule?.allowedTypologies) && variant.form === 'courtyard' && !rule.allowedTypologies.some(t => ['block','courtyard','perimeter'].includes(t))) {
        changes.push({ field: 'typology', from: rule.allowedTypologies.join(', '), to: 'courtyard' });
    }
    if (finite(rule?.minPlotM2) && parcel.areaM2 < rule.minPlotM2) changes.push({ field: 'minPlotM2', from: rule.minPlotM2, to: parcel.areaM2 });
    return changes;
}
export function planHousingSites(parcels, { turf, assumptions = {}, reform = {}, limit = 10 } = {}) {
    if (!turf) throw new Error('turf is required');
    const financeInputs = model.validateAssumptions(assumptions), proposed = validateReform(reform);
    const candidates = [], failures = [], excluded = [];
    for (const parcel of parcels) {
        // Use the same road authority as the map. Residential zoning or a missing land-use
        // polygon does not make an existing street available for a housing proposal.
        if (['road', 'likely_road'].includes(parcel.roadClassification)) {
            excluded.push({ parcelId: parcel.parcelId, reason: 'road-parcel' }); continue;
        }
        if (!finite(parcel.buildingCount)) { failures.push({ parcelId: parcel.parcelId, error: 'Missing building inventory' }); continue; }
        if (parcel.buildingCount > 0) { excluded.push({ parcelId: parcel.parcelId, reason: 'existing-buildings' }); continue; }
        if (parcel.planning?.sensitiveUse) { excluded.push({ parcelId: parcel.parcelId, reason: 'sensitive-land-use' }); continue; }
        try {
            if (!parcel.geometry || !finite(parcel.areaM2) || parcel.areaM2 <= 0) throw new Error('Invalid parcel geometry or area');
            const rule = parcel.planning.rule;
            const currentKnown = parcel.planning.housingUse === true && finite(rule?.maxFloors) && finite(rule?.minSetbackM);
            const currentRule = { floors: rule?.maxFloors, setbackM: rule?.minSetbackM, coveragePct: rule?.maxCoveragePct, maxGfaM2: rule?.maxGfaM2, minPlotM2: rule?.minPlotM2 };
            const variants = [];
            for (const scenario of ['current', 'reform']) {
                if (scenario === 'current' && !currentKnown) continue;
                for (const form of ['courtyard', 'compact']) {
                    if (scenario === 'current' && form === 'courtyard' && Array.isArray(rule?.allowedTypologies)
                        && !rule.allowedTypologies.some(t => ['block','courtyard','perimeter'].includes(t))) continue;
                    const constraints = scenario === 'current' ? { ...currentRule } : { ...proposed };
                    if (scenario === 'current') {
                        constraints.coveragePct = rule?.maxCoveragePct ?? (form === 'compact' ? rule?.maxDetachedCoveragePct : null);
                        const kisn = rule?.maxKisn ?? (form === 'compact' ? rule?.maxDetachedKisn : null);
                        if (finite(kisn)) constraints.maxGfaM2 = Math.min(constraints.maxGfaM2 ?? Infinity, parcel.areaM2 * kisn);
                    }
                    const massing = massingFor(parcel, form, constraints, turf);
                    if (!massing) continue;
                    const maxHomes = scenario === 'current' ? rule?.maxUnits ?? null : null;
                    const minParkingPerHome = scenario === 'current' ? rule?.minParkingPerUnit ?? null : null;
                    const variant = { id: `${scenario}-${form}`, scenario, form, setbackM: constraints.setbackM, maxHomes, minParkingPerHome, ...massing,
                        finance: model.rentalFeasibility({ gfaM2: massing.gfaM2, siteAreaM2: parcel.areaM2, maxHomes, minParkingPerHome }, financeInputs) };
                    variant.changes = planningChanges(parcel, variant, financeInputs);
                    variants.push(variant);
                }
            }
            const reforms = variants.filter(variant => variant.scenario === 'reform' && variant.finance.homes > 0);
            if (!reforms.length) { excluded.push({ parcelId: parcel.parcelId, reason: 'no-schematic-fit' }); continue; }
            reforms.sort((a, b) => (a.finance.rentMonth ?? Infinity) - (b.finance.rentMonth ?? Infinity)
                || b.finance.homes - a.finance.homes || a.id.localeCompare(b.id));
            const best = reforms[0], baseline = variants.filter(v => v.scenario === 'current');
            const currentHomes = parcel.planning.housingUse === false ? 0 : currentKnown
                ? Math.max(0, ...baseline.map(v => v.finance.homes ?? 0)) : null;
            const gaps = ['ownership', 'availability', 'constraints', 'network-access', 'cost-evidence', 'affordability-delivery', 'planning-review'];
            if (!currentKnown && parcel.planning.housingUse !== false) gaps.push('current-capacity');
            if (!parcel.accessibility?.nearestStop) gaps.push('transit');
            const changes = best.changes;
            candidates.push({ ...parcel, bounds: turf.bbox(turf.feature(parcel.geometry)), variants,
                recommendedVariantId: best.id, currentHomes, addedHomes: currentHomes === null ? null : best.finance.homes - currentHomes,
                changes, evidenceGaps: gaps, status: 'research',
                // This ranks research leads; it is explicitly not a comprehensive accessibility score.
                score: (best.finance.withinTarget ? 100 : 0)
                    + (parcel.planning.housingUse !== null ? 30 : 0) + (currentKnown ? 20 : 0)
                    + Math.min(best.finance.homes, 200) / 10
                    + (finite(parcel.accessibility?.nearestStop?.distanceM) ? Math.max(0, 10 - parcel.accessibility.nearestStop.distanceM / 100) : 0)
                    + (changes.length ? 5 : 0)
            });
        } catch (error) { failures.push({ parcelId: parcel.parcelId, error: error.message }); }
    }
    candidates.sort((a, b) => b.score - a.score || a.parcelId.localeCompare(b.parcelId));
    return { candidates: candidates.slice(0, limit), failures, excluded, totalCandidates: candidates.length,
        assumptions: financeInputs, reform: proposed, status: failures.length ? 'partial' : 'complete' };
}
