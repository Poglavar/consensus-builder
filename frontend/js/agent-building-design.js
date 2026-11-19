// agent-building-design.js — a simulated agent's building design on one parcel, measured the way the
// server agents measure theirs (backend/agents/planner.js and record-builder.js): the parcel's
// permitted envelope under an urban rule, one seeded build-out inside it (urban-rule-variation.js),
// and the local design record of that single building. The parcel has no known rule in the
// simulation, so the rule is the default setback with a storey ceiling the seed draws from 2 to 8.
// Pure: turf and UrbanRuleVariation are passed in; backend/test/frontend-agent-building-design.test.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentBuildingDesign = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const MIN_FLOORS = 2;
    const MAX_FLOORS = 8;

    // A repeatable number in [0, 1) from a string seed (FNV-1a, then one xorshift round).
    function unitFromSeed(seed) {
        let hash = 2166136261;
        for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
        return (hash >>> 0) / 4294967296;
    }

    // The storey ceiling this seed allows, MIN_FLOORS..MAX_FLOORS.
    function floorCeiling(seed) {
        return MIN_FLOORS + Math.floor(unitFromSeed(`floors:${seed}`) * (MAX_FLOORS - MIN_FLOORS + 1));
    }

    /**
     * The design record of one building on `parcelFeature`, or null when the parcel holds none
     * (below the minimum plot, no room inside the setbacks).
     * @param {Object} args
     * @param {Object} args.parcelFeature  the parcel as a GeoJSON Feature
     * @param {string} args.parcelId       its id, named in the design's block
     * @param {string} args.author         the agent's name
     * @param {string} args.seed           repeatable seed (agent, turn, parcel)
     * @param {Object} args.turf           turf
     * @param {Object} args.variation      UrbanRuleVariation
     */
    function buildingDesign({ parcelFeature, parcelId, author, seed, turf, variation }) {
        if (!parcelFeature?.geometry || !turf || !variation) return null;
        const rule = variation.normalizeParcelRule({ maxFloors: floorCeiling(seed) });
        const evaluated = variation.evaluateParcel(parcelFeature, rule, { turf });
        if (evaluated.status !== 'ok' || !evaluated.envelope) return null;
        const massing = variation.realizeFromEnvelope(evaluated.envelope, rule, Math.floor(unitFromSeed(`massing:${seed}`) * 2 ** 31), { turf });
        if (!massing?.geometry) return null;
        const floors = massing.properties?.floors ?? null;
        const height = massing.properties?.height ?? null;
        const title = floors ? `${floors}-storey building on parcel ${parcelId}` : `Building on parcel ${parcelId}`;
        const blockName = `Parcel ${parcelId}`;
        return {
            goal: 'buildings',
            title,
            description: `${title}, proposed by ${author}.`,
            author,
            buildingProposal: {
                blockName,
                typologyType: 'single',
                parameters: { height, floors, rotation: 0, typology: 'single', rule }
            },
            geometry: {
                buildings: [{
                    type: 'Feature',
                    geometry: massing.geometry,
                    properties: { type: 'proposedBuildingSingle', block: blockName, height, floors, title, author, rotation: 0 }
                }]
            }
        };
    }

    return { MIN_FLOORS, MAX_FLOORS, unitFromSeed, floorCeiling, buildingDesign };
});
