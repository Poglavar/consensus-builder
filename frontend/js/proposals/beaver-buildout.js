// Opening-readiness scenarios for exact plan members, shared by the map and MCP.
(function (root, factory) {
    'use strict';
    const api = factory(
        root.PlanRecord || (typeof require === 'function' ? require('../plan-record.js') : null),
        root.__planYield || (typeof require === 'function' ? require('./plan-yield.js') : null)
    );
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.BeaverBuildout = api;
})(typeof window !== 'undefined' ? window : globalThis, function (record, yieldApi) {
    'use strict';
    const ACCESS = ['unknown', 'independent', 'requires-connection'];
    const SERVICES = ['unknown', 'ready'];
    const month = record.semanticRules.month;
    const invalid = message => Object.assign(new Error(message), { code: 'invalid-opening-scenario' });
    const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

    function inventory(plan, designs) {
        const byCid = new Map(designs.map(design => [design.cid, design.content]));
        return plan.designCids.flatMap(cid => {
            const content = byCid.get(cid);
            if (!content) throw invalid('A plan member is unavailable.');
            const buildings = yieldApi.buildingFeaturesOf(content);
            const space = ['park', 'square'].includes(content.structureProposal?.kind) ? content.structureProposal.geometry : null;
            if (!buildings.length && !space) return [];
            const measured = yieldApi.measureProposal(content);
            return [{
                cid, title: content.title, goal: content.goal, planCompletionMonth: plan.schedule?.[cid]?.end ?? null,
                floorM2: measured.grossFloorAreaM2, spaceM2: space ? yieldApi.geometryAreaM2(space) : 0,
                unmeasuredBuildings: measured.unmeasuredBuildings,
                geometry: space || content.site || { type: 'FeatureCollection', features: buildings }
            }];
        });
    }

    function readiness(completionMonth, at, access, services, delayConnection) {
        if (!completionMonth) return { status: 'unknown', reason: 'missing-date' };
        if (completionMonth > at) return { status: 'later', reason: 'after-month' };
        if (delayConnection && access === 'requires-connection') return { status: 'blocked', reason: 'connection' };
        if (access === 'unknown') return { status: 'unknown', reason: 'access' };
        if (services !== 'ready') return { status: 'unknown', reason: 'servicing' };
        return { status: 'ready', reason: 'ready' };
    }

    function evaluate(inventory, { month: at, delayConnection = false, assumptions = {} } = {}) {
        if (!month(at) || typeof delayConnection !== 'boolean' || !isObject(assumptions)) {
            throw invalid('Supply a valid assessment month and connection scenario.');
        }
        const ids = new Set(inventory.map(member => member.cid));
        for (const [cid, value] of Object.entries(assumptions)) {
            if (!ids.has(cid)) throw invalid('An opening assumption names a design outside this plan assessment.');
            if (!isObject(value) || Object.keys(value).some(key => !['access', 'servicing', 'completionMonth'].includes(key))
                || (Object.hasOwn(value, 'access') && !ACCESS.includes(value.access))
                || (Object.hasOwn(value, 'servicing') && !SERVICES.includes(value.servicing))
                || (Object.hasOwn(value, 'completionMonth') && !month(value.completionMonth))) {
                throw invalid('An opening assumption has an invalid access, servicing or completion value.');
            }
        }
        const bucket = () => ({ floorM2: 0, spaceM2: 0, designs: 0, unmeasuredBuildings: 0 });
        const totals = { ready: bucket(), blocked: bucket(), unknown: bucket(), later: bucket(), all: bucket() };
        const lostToDelay = bucket();
        function add(target, member) {
            target.floorM2 += member.floorM2;
            target.spaceM2 += member.spaceM2;
            target.unmeasuredBuildings += member.unmeasuredBuildings;
            target.designs++;
        }
        const members = inventory.map(({ geometry, ...member }) => {
            const assumption = assumptions[member.cid] || {};
            const { access = 'unknown', servicing = 'unknown' } = assumption;
            const completionMonth = assumption.completionMonth ?? member.planCompletionMonth;
            const available = readiness(completionMonth, at, access, servicing, false);
            const delayed = readiness(completionMonth, at, access, servicing, true);
            const outcome = delayConnection ? delayed : available;
            add(totals.all, member);
            add(totals[outcome.status], member);
            if (available.status === 'ready' && delayed.status === 'blocked') add(lostToDelay, member);
            return { ...member, completionMonth, access, servicing, ...outcome };
        });
        return { month: at, delayConnection, members, totals, lostToDelay,
            readyShare: totals.all.floorM2 > 0 ? totals.ready.floorM2 / totals.all.floorM2 : null };
    }
    return Object.freeze({ inventory, evaluate, ACCESS, SERVICES });
});
