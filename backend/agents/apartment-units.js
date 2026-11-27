// The apartments of a published design building, as a developer agent lists them in a crowdfunding
// round (docs/developer-crowdfunding.md "Apartment reservations"): the building is laid out in node by
// the shared planner behind X-ray's Suggested layouts (vendor/interior-viewer/interior-planner.js) and
// each apartment gets the address X-ray's Copy apartment link gives (building-unit-links.js:
// design::<cid>::<building index>, <level>::<flat>), its map location and its
// layout region for the drawing. The browser lays a building out with more context (live parcel
// pieces, nearby streets for the entrance, neighbouring buildings, the facade's bay width), so its
// walls can differ while the numbered flat on the same storey keeps its address.
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { context: plannerContext, generator: plannerGenerator } = require('../../frontend/vendor/interior-viewer/interior-planner.js');
require('../../frontend/js/building-floor-plans.js');
const unitLinks = require('../../frontend/js/building-unit-links.js');
const planYield = require('../../frontend/js/proposals/plan-yield.js');
const buildingUse = require('../../frontend/js/building-use.js');

const round6 = value => Math.round(value * 1e6) / 1e6;

/**
 * Every apartment of one building of a published design, ground floor up.
 * @param {{ designCid: string, content: object, buildingIndex?: number, deps?: object }} options
 * @returns {{ xrayBuilding: string, at: string, heightM: number|null, apartments: Array<{ unit: string, unitSlot: string,
 *   level: number, areaM2: number, rooms: Array, region: object|null, dimensionsM: object|null, storeyRegions: Array }>, reason?: string }}
 */
export function designApartments({ designCid, content, buildingIndex = 0, deps = {} } = {}) {
    const features = planYield.buildingFeaturesOf(content);
    const feature = features[buildingIndex];
    if (!feature) return { apartments: [], reason: 'no-building' };
    const xrayBuilding = unitLinks.designBuilding(designCid, buildingIndex);
    const [lng, lat] = turf.centroid(feature).geometry.coordinates;
    const at = `${round6(lat)},${round6(lng)},19`;
    const bp = content.buildingProposal || content.building_proposal || null;
    const measured = planYield.measureBuilding(feature, bp, {});
    const use = buildingUse.statedUse(feature.properties || {});
    if (!(measured.heightM > 0)) return { xrayBuilding, at, apartments: [], reason: 'no-height' };
    if (use && !buildingUse.housesPeople(use)) return { xrayBuilding, at, apartments: [], reason: 'not-housing' };
    const rules = use ? buildingUse.layoutRules(use) : null;
    const planned = (deps.context || plannerContext).planBuilding(feature, {
        turf: deps.turf || turf, generator: deps.generator || plannerGenerator, parcels: [], neighbours: [], roads: null,
        heightM: measured.heightM, storeyFallbackM: measured.floorHeightM, owner: feature, ...(rules ? { rules } : {})
    });
    const apartments = [];
    for (const slice of planned.slices) {
        const model = slice.result?.floorPlans;
        if (!model) continue;
        const layouts = new Map(model.layouts.map(layout => [layout.id, layout]));
        for (const storey of model.storeys) {
            const layout = layouts.get(storey.layoutId);
            const regions = layout?.architecture?.apartmentRegions || [];
            for (const unit of unitLinks.unitsForStorey(model, storey, layout)) {
                if (!unit.key) continue;
                const record = (storey.units || []).find(row => row.id === unit.id);
                apartments.push({
                    unit: unit.key, unitSlot: unit.id, ordinal: unit.ordinal, level: storey.level, areaM2: unit.areaM2,
                    rooms: record?.rooms || [], region: regions.find(region => region.id === unit.regionId) || null,
                    storeyRegions: regions, dimensionsM: layout?.architecture?.dimensionsM || null
                });
            }
        }
    }
    return { xrayBuilding, at, heightM: measured.heightM, apartments, ...(apartments.length ? {} : { reason: 'no-layout' }) };
}

/**
 * The residential buildings of a plan's designs that have generated apartments: [{ designCid, title,
 * buildingIndex, xrayBuilding, at, apartments }], largest first. `designs` = [{ cid, content }].
 */
export function planApartmentBuildings(designs, deps = {}) {
    const buildings = [];
    for (const design of designs || []) {
        const count = planYield.buildingFeaturesOf(design.content || {}).length;
        for (let index = 0; index < count; index += 1) {
            let found;
            try {
                found = designApartments({ designCid: design.cid, content: design.content, buildingIndex: index, deps });
            } catch (error) {
                // A generator fault leaves this building out of the offer, as Plan stats leaves it to the per-m² rule.
                console.error(`[${new Date().toISOString()}] [apartment-units] building ${index} of ${design.cid} could not be laid out: ${error.message}`);
                continue;
            }
            if (found.apartments.length) buildings.push({ designCid: design.cid, title: design.content?.title || null, buildingIndex: index, ...found });
        }
    }
    return buildings.sort((a, b) => b.apartments.length - a.apartments.length || a.xrayBuilding.localeCompare(b.xrayBuilding));
}
