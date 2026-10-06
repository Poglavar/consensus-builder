// Attaches authored floors only to the exact source building and footprint they were registered to.
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const { validateFloorPlans, buildingSourceId } = require('../../frontend/js/building-floor-plans.js');

export function attachBuildingFloorPlans(buildings, sourceBuildings) {
    if (!Array.isArray(buildings) || !Array.isArray(sourceBuildings)) {
        throw new TypeError('Floor-plan attachment requires building feature arrays.');
    }
    const result = structuredClone(buildings);
    let changed = 0;
    let floors = 0;
    for (const source of sourceBuildings) {
        const plans = source.properties?.floorPlans;
        if (!plans) continue;
        const errors = validateFloorPlans(plans);
        if (errors.length) throw new Error(`Invalid floor plans: ${errors.join('; ')}`);
        const sourceId = buildingSourceId(source);
        if (!sourceId) throw new Error('Floor-plan source has no stable building identity.');
        const matches = result.filter(feature => buildingSourceId(feature) === sourceId);
        if (matches.length !== 1) throw new Error(`Expected one floor-plan building ${sourceId}; found ${matches.length}.`);
        const target = matches[0];
        if (target.geometry?.type !== source.geometry?.type
            || JSON.stringify(target.geometry?.coordinates) !== JSON.stringify(source.geometry?.coordinates)) {
            throw new Error(`Footprint changed for ${sourceId}; re-register its floor plans before importing.`);
        }
        floors += plans.floors.length;
        if (!isDeepStrictEqual(target.properties.floorPlans, plans)) {
            target.properties.floorPlans = structuredClone(plans);
            changed++;
        }
    }
    return { buildings: result, changed, floors };
}
