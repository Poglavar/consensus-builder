// The restrictions stage on the server, for MCP: the same constraint reads, rule-set effects and
// existing context the browser computes (frontend/js/planning/constraint-sources.js, restrictions.js,
// rule-terms.js), for one parcel. The server reads the publisher for its own answer to an agent;
// browsers never go through it.
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import config from '../../frontend/data/planning-sources.json' with { type: 'json' };
import { cityPlanningRuleSetIds } from '../scripts/lib/frontend-city-money.mjs';
const require = createRequire(import.meta.url);
const ConstraintSources = require('../../frontend/js/planning/constraint-sources.js');
const Restrictions = require('../../frontend/js/planning/restrictions.js');
const RuleTerms = require('../../frontend/js/planning/rule-terms.js');
const scene = require('../../frontend/js/planning/scene.js');

// One loader (its per-view cache) per fetch implementation.
const loaders = new WeakMap();
const loaderFor = fetchImpl => {
    if (!loaders.has(fetchImpl)) loaders.set(fetchImpl, ConstraintSources.createLoader({ config, scene, fetch: fetchImpl }));
    return loaders.get(fetchImpl);
};
const asFeatures = records => (records || []).map(record => ({ type: 'Feature', id: record.id, properties: { source: 'building-source' }, geometry: record.geometry }));

// Permitted items (envelopes) with the city's prohibited designations cut out, as the map draws
// them, and the same cut applied to `geometry` (an envelope's site a draft builds on). Items pass
// unchanged in a city without a rule set. Returns { items, cut(geometry) → geometry | null, restrictions }.
export async function restrictedEnvelopes({ city, items, bbox, buildings = null, fetchImpl = fetch, ruleSetIds = cityPlanningRuleSetIds(city) }) {
    if (!ruleSetIds.length) return { items, cut: geometry => geometry, restrictions: [] };
    const reads = await loaderFor(fetchImpl).load(ruleSetIds, bbox, { effects: ['prohibit'] });
    const { restrictions } = Restrictions.restrictionsFor(reads, { buildings: asFeatures(buildings), geometryOps: turf });
    return { items: Restrictions.applyToItems(items, restrictions, { geometryOps: turf }), restrictions,
        cut: geometry => Restrictions.cutGeometry(geometry, restrictions, { geometryOps: turf }) };
}
// `buildings`: the existing building records on the parcel ({ id, geometry, height_m, floors },
// as /buildings/under answers), or null when no building source was read. Returns null for a city
// without a rule set; else the designations over the parcel with their effects, whether the read
// was partial, the parcel's existing context and each rule-set policy's limits resolved against it.
// `setting`: the street it faces and the buildings along it (street-width.js streetSetting), or null.
export async function parcelRestrictions({ city, parcel, buildings = null, setting = null, fetchImpl = fetch, ruleSetIds = cityPlanningRuleSetIds(city) }) {
    if (!ruleSetIds.length) return null;
    const existing = RuleTerms.existingContext({ parcel, buildings, street: setting?.street ?? null, neighbours: setting?.neighbours ?? null, geometryOps: turf });
    const pairs = ConstraintSources.ruleSetsFor(config, ruleSetIds);
    const ruleSets = pairs.map(({ ruleSet, source }) => ({ id: ruleSet.id, label: ruleSet.label, baseRule: ruleSet.baseRule ?? null, evidence: ruleSet.evidence,
        source: { id: source.id, label: source.label, coverage: source.coverage, licence: source.licence, attribution: source.attribution },
        policies: (ruleSet.policies || []).map(policy => ({ ...policy, constraints: RuleTerms.resolve(policy.constraints, existing) })) }));
    // Designations that cut the envelope are read with geometry; the others only as which ones the
    // parcel lies in (the publisher tests it, inset 0.25 m so a shared edge does not count).
    let reads, named;
    try {
        const inset = turf.buffer(parcel, -0.25, { units: 'meters' });
        const probe = ['Polygon', 'MultiPolygon'].includes(inset?.geometry?.type) ? inset.geometry : parcel.geometry;
        [reads, named] = await Promise.all([loaderFor(fetchImpl).load(ruleSetIds, turf.bbox(parcel), { effects: ['prohibit'] }),
            loaderFor(fetchImpl).membership(ruleSetIds, probe, { effects: ['restrict', 'note'] })]);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [planning-restrictions] Designations could not be read for ${city}`, error);
        return { ruleSets, unavailable: true, reason: error.message, designations: [], partial: false, existing };
    }
    const located = Restrictions.restrictionsFor(reads, { buildings: asFeatures(buildings), geometryOps: turf });
    const member = Restrictions.membershipRestrictions([{ buildingId: 'parcel', reads: named }], { geometryOps: turf });
    const designations = [...Restrictions.restrictionsUnder(located.restrictions, parcel, turf).map(({ restriction, share }) => ({ ...restriction, shareOfParcel: share })),
        ...member.restrictions.map(({ buildingIds, ...restriction }) => ({ ...restriction, shareOfParcel: null }))];
    return { ruleSets, unavailable: false, partial: located.partial || member.partial, designations, existing };
}
