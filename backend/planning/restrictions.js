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

let loader = null;
// `buildings`: the existing building records on the parcel ({ id, geometry, height_m, floors },
// as /buildings/under answers), or null when no building source was read. Returns null for a city
// without a rule set; else the designations over the parcel with their effects, whether the read
// was partial, the parcel's existing context and each rule-set policy's limits resolved against it.
export async function parcelRestrictions({ city, parcel, buildings = null, fetchImpl = fetch, ruleSetIds = cityPlanningRuleSetIds(city) }) {
    if (!ruleSetIds.length) return null;
    loader ??= ConstraintSources.createLoader({ config, scene, fetch: fetchImpl });
    const existing = RuleTerms.existingContext({ parcel, buildings, geometryOps: turf });
    const pairs = ConstraintSources.ruleSetsFor(config, ruleSetIds);
    const ruleSets = pairs.map(({ ruleSet, source }) => ({ id: ruleSet.id, label: ruleSet.label, baseRule: ruleSet.baseRule ?? null, evidence: ruleSet.evidence,
        source: { id: source.id, label: source.label, coverage: source.coverage, licence: source.licence, attribution: source.attribution },
        policies: (ruleSet.policies || []).map(policy => ({ ...policy, constraints: RuleTerms.resolve(policy.constraints, existing) })) }));
    let reads;
    try { reads = await loader.load(ruleSetIds, turf.bbox(parcel)); }
    catch (error) {
        console.error(`[${new Date().toISOString()}] [planning-restrictions] Designations could not be read for ${city}`, error);
        return { ruleSets, unavailable: true, reason: error.message, designations: [], partial: false, existing };
    }
    const { restrictions, partial } = Restrictions.restrictionsFor(reads, { buildings: (buildings || []).map(record => ({ type: 'Feature', id: record.id, properties: { source: 'building-source' }, geometry: record.geometry })), geometryOps: turf });
    const designations = Restrictions.restrictionsUnder(restrictions, parcel, turf).map(({ restriction, share }) => ({
        ...restriction, shareOfParcel: share }));
    return { ruleSets, unavailable: false, partial, designations, existing };
}
