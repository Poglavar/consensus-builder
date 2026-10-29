// Apartments counted building by building for Plan stats and Compare plans: the suggested default
// layout (default-floor-plans.js through default-floor-plan-context.js, the X-ray "Suggested
// layouts") lays each building out and its apartments are counted; a building's own floor plans
// count as they are. Only a building stated as housing is laid out (building-use.js; a Block, Row or
// Detached rule building is housing): a building the generator cannot lay out, one of another or
// no stated use, or an uploaded model without floor plans stays with the per-m² rule in
// plan-yield.js, and the reason is kept.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanUnits = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const SLICE_MS = 12;
    const yieldApi = () => (root && root.__planYield) || (typeof require === 'function' ? require('./plan-yield.js') : null);
    const useApi = () => (root && root.BuildingUse) || (typeof require === 'function' ? require('../building-use.js') : null);
    const HOUSING_TYPOLOGIES = ['block', 'row', 'detached'];

    // The building's stated use, or 'residential' for a housing rule's building that states none.
    function useOf(feature) {
        const props = (feature && feature.properties) || {};
        const stated = useApi().normalize(props.use);
        if (stated) return stated;
        const typology = props.urbanRule && props.urbanRule.typology;
        return HOUSING_TYPOLOGIES.includes(typology) ? 'residential' : null;
    }

    // { apartments, shopNetM2, workNetM2 } from a floor-plan model (building-floor-plans v2): the
    // apartments on every floor, the shops' net area, and the apartments of a storey the use gives to
    // offices (mixed: the first floor) as office area.
    function countModel(floorPlans, use = null) {
        const floors = (Array.isArray(floorPlans && floorPlans.floors) ? floorPlans.floors : []).filter(floor => !(floor.level < 0));
        const storeys = use ? useApi().storeyUses(use, floors.length) : [];
        return floors.reduce((sum, floor, index) => {
            const apartments = Array.isArray(floor.apartments) ? floor.apartments : [];
            const office = storeys[Number.isInteger(floor.level) ? floor.level : index] === 'office';
            return {
                apartments: sum.apartments + (office ? 0 : apartments.length),
                workNetM2: sum.workNetM2 + (office ? apartments.reduce((area, unit) => area + (Number(unit.areaM2) || 0), 0) : 0),
                shopNetM2: sum.shopNetM2 + (Array.isArray(floor.units) ? floor.units : [])
                    .filter(unit => unit.kind === 'shop').reduce((area, unit) => area + (Number(unit.areaM2) || 0), 0)
            };
        }, { apartments: 0, shopNetM2: 0, workNetM2: 0 });
    }

    /**
     * One building: { apartments, shopNetM2 } or { reason } when the rule has to count it.
     * deps: { context, generator, turf, parcels, neighbours, heightM, floorHeightM, existing, region, cache }
     */
    function countBuilding(feature, deps) {
        const props = (feature && feature.properties) || {};
        const use = deps.existing ? null : useOf(feature);
        if (props.floorPlans) return countModel(props.floorPlans, use);
        if (props.modelUrl) return { reason: 'uploaded-model' };
        if (!use) return { reason: 'no-use' };
        if (!useApi().housesPeople(use)) return { reason: 'not-housing' };
        if (!(deps.heightM > 0)) return { reason: 'no-height' };
        // A stated use sets the ground floor; a rule building without one keeps the generator's own choice.
        const rules = useApi().normalize(props.use) ? useApi().layoutRules(use) : null;
        const planned = deps.context.planBuilding(feature, { turf: deps.turf, generator: deps.generator, parcels: deps.parcels || [],
            neighbours: deps.neighbours || [], roads: null, heightM: deps.heightM, storeyFallbackM: deps.floorHeightM,
            cache: deps.cache, owner: feature, existing: deps.existing === true, ...(rules ? { rules } : {}), ...(deps.region ? { region: deps.region } : {}) });
        const failed = planned.slices.find(slice => !slice.result || !slice.result.floorPlans);
        if (!planned.slices.length || failed) {
            const warning = failed && failed.result && failed.result.warnings.find(item => item.severity === 'error');
            return { reason: warning ? warning.code : 'no-layout' };
        }
        return planned.slices.reduce((sum, slice) => {
            const counted = countModel(slice.result.floorPlans, use);
            return { apartments: sum.apartments + counted.apartments, shopNetM2: sum.shopNetM2 + counted.shopNetM2, workNetM2: sum.workNetM2 + counted.workNetM2 };
        }, { apartments: 0, shopNetM2: 0, workNetM2: 0 });
    }

    /**
     * Every building of `records` (plan-yield records: designs, or existing buildings when `existing`).
     * deps: countBuilding's, without heightM/neighbours, plus parcelsNear(feature) and an optional
     * pause() awaited between slices of work. Returns { unitsOf(feature) → counted | null, laidOut,
     * estimated, reasons: { code: count } }.
     */
    async function count(records, deps) {
        const plan = yieldApi();
        const features = [];
        (records || []).forEach(record => {
            const bp = record && (record.buildingProposal || record.building_proposal);
            plan.buildingFeaturesOf(record).forEach(feature => features.push({ feature, bp }));
        });
        const all = features.map(entry => entry.feature);
        const counted = new Map();
        const reasons = {};
        let laidOut = 0, started = Date.now();
        for (const { feature, bp } of features) {
            const measured = plan.measureBuilding(feature, bp, {});
            if (measured.gfaM2 === null) continue;
            let result;
            try {
                result = countBuilding(feature, { ...deps, heightM: measured.heightM, floorHeightM: measured.floorHeightM,
                    parcels: deps.parcelsNear ? deps.parcelsNear(feature) : [],
                    neighbours: deps.context.neighbourPool(feature, deps.existing ? [] : all, deps.existing ? all : (deps.standing || []), deps.turf) });
            } catch (error) {
                // A generator fault leaves this building to the rule, said in the reasons and the log.
                console.error(`[${new Date().toISOString()}] [plan-units] a building could not be laid out`, error);
                result = { reason: 'layout-failed' };
            }
            if (result.reason) reasons[result.reason] = (reasons[result.reason] || 0) + 1;
            else { counted.set(feature, result); laidOut += 1; }
            if (deps.pause && Date.now() - started > SLICE_MS) { await deps.pause(); started = Date.now(); }
        }
        const estimated = Object.values(reasons).reduce((sum, n) => sum + n, 0);
        return { unitsOf: feature => counted.get(feature) || null, laidOut, estimated, reasons };
    }

    // The browser: the generator modules load on first use (map-mode-loader.js); parcels are the
    // plan's own live pieces near each building.
    async function forSnapshot(records, { parcels = [], existing = false, standing = [] } = {}) {
        await root.__ensureFloorPlanModules();
        const turf = root.turf;
        const context = root.__defaultFloorPlanContext;
        const cities = root.CityConfigManager;
        const region = cities && typeof cities.getCurrentCityConfig === 'function' ? context.regionOf(cities.getCurrentCityConfig()) : null;
        const boxes = parcels.map(parcel => ({ parcel, box: turf.bbox(parcel) }));
        const started = Date.now();
        const result = await count(records, { context, generator: root.__defaultFloorPlans, turf, region, cache: sharedCache, existing, standing,
            parcelsNear: feature => {
                const [w, s, e, n] = turf.bbox(feature);
                return boxes.filter(({ box }) => box[0] <= e && box[2] >= w && box[1] <= n && box[3] >= s).map(({ parcel }) => parcel);
            },
            pause: () => new Promise(resolve => setTimeout(resolve, 0)) });
        console.log(`[${new Date().toISOString()}] [plan-units] ${result.laidOut} buildings laid out, ${result.estimated} by the rule (${JSON.stringify(result.reasons)}) in ${Date.now() - started} ms`);
        return result;
    }
    // Layouts keyed by building, storeys, neighbours and rules (planBuilding's cache key).
    const sharedCache = new Map();
    return { useOf, countModel, countBuilding, count, forSnapshot };
});
