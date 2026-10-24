// Keep the daily priority city, then try each other configured city once. Source failures
// remain visible; an exhausted search with errors is not a healthy no-picks run.
import { chooseHousingArea } from './housing-policy.js';

export async function findHousingPlan(areas, day, planArea, { log = () => {} } = {}) {
    const first = chooseHousingArea(areas, day);
    const ranked = [...areas].sort((a, b) => b.medianMultiple - a.medianMultiple);
    const cities = new Set();
    const ordered = [first, ...ranked].filter(area => {
        if (cities.has(area.city)) return false;
        cities.add(area.city);
        return true;
    });
    const areaAttempts = [];
    const errors = [];
    let emptyPlan;
    for (const area of ordered) {
        let plan;
        try {
            plan = await planArea(area);
        } catch (error) {
            areaAttempts.push({ city: area.city, outcome: 'error', error: error.message });
            errors.push(error);
            log(`affordabot ${area.city}: area failed; trying another city — ${error.stack || error}`);
            continue;
        }
        const selected = plan.preflight.candidates.length > 0;
        areaAttempts.push({ city: area.city, outcome: selected ? 'selected' : 'no-candidates', parcels: plan.parcels.length });
        if (selected) return { ...plan, areaAttempts };
        emptyPlan ??= plan;
        log(`affordabot ${area.city}: no eligible candidates; trying another city`);
    }
    if (errors.length) {
        const error = new AggregateError(errors, `Affordabot exhausted ${ordered.length} cities without candidates; ${errors.length} area(s) failed: `
            + areaAttempts.filter(a => a.outcome === 'error').map(a => `${a.city}: ${a.error}`).join('; '));
        error.areaAttempts = areaAttempts;
        throw error;
    }
    return { ...emptyPlan, areaAttempts };
}
