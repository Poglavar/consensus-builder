// What a design or plan would carry as a planning application in its jurisdiction's submission
// format (planning-sources.json `submissionTargets`, chosen by the jurisdiction of the city's rule
// sets): the red line, the figures, the drawings it would attach and its permanent link. Pure: the
// download dialogs (plan-file-ui.js) pass the records and the geometry helpers in, and node tests
// run the same code.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanningApplicationPreview = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';
    const yieldApi = () => (global && global.__planYield) || require('../proposals/plan-yield.js');
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    // The submission target of a city with these rule sets, or null. A city's jurisdiction is the
    // jurisdiction of its rule sets; a city without one, or a jurisdiction without a target, has none.
    function targetFor(config, ruleSetIds = []) {
        const ids = new Set(ruleSetIds);
        const jurisdictions = new Set((config?.ruleSets || []).filter(set => ids.has(set.id)).map(set => set.jurisdiction).filter(Boolean));
        return (config?.submissionTargets || []).find(target => jurisdictions.has(target.jurisdiction)) || null;
    }

    // The red line: the union of the records' sites (siteOf: site-binding.js, an authored site or
    // the design's own footprint). unite(features) → Feature; areaOf(geometry) → m².
    function redLine(records, { siteOf, unite, areaOf }) {
        const sites = records.map(record => siteOf(record)).filter(Boolean)
            .map(geometry => ({ type: 'Feature', properties: {}, geometry }));
        if (!sites.length) return null;
        const united = sites.length === 1 ? sites[0] : unite(sites);
        const geometry = united?.geometry || null;
        const areaM2 = geometry ? areaOf(geometry) : null;
        return geometry ? { geometry, areaM2: finite(areaM2) ? areaM2 : null } : null;
    }

    // The figures the format asks for that a design states: buildings, floor area, homes (the
    // plan-yield estimate), the tallest building's storeys and open space. A figure no building
    // measures is null, never 0.
    function figures(records, assumptions = {}) {
        const api = yieldApi();
        const total = api.planYield(records, assumptions).total;
        let tallest = null;
        for (const record of records) {
            for (const feature of api.buildingFeaturesOf(record)) {
                const floors = api.measureBuilding(feature, record.buildingProposal || record.building_proposal, assumptions).floors;
                if (finite(floors) && (tallest === null || floors > tallest)) tallest = floors;
            }
        }
        const measured = total.buildings > total.unmeasuredBuildings;
        return {
            buildings: total.buildings,
            grossFloorAreaM2: measured ? total.grossFloorAreaM2 : null,
            homes: measured ? total.apartments : null,
            tallestStoreys: tallest,
            openSpaceM2: total.openSpaces ? total.openSpaceM2 : null
        };
    }

    // The whole preview. `link`: the published design's or plan's permanent address, or null.
    function preview({ records, target, link = null, siteOf, unite, areaOf, assumptions }) {
        if (!target) return null;
        const list = (records || []).filter(record => record && typeof record === 'object');
        return { target, redLine: redLine(list, { siteOf, unite, areaOf }), figures: figures(list, assumptions),
            attachments: [...(target.attachments || [])], link };
    }

    // The red line as the format's site boundary: a GeoJSON Feature (WGS84), as BOPS publishes it.
    function boundaryFeature(model, title) {
        if (!model?.redLine) return null;
        return { type: 'Feature', geometry: model.redLine.geometry,
            properties: { name: title || '', areaM2: model.redLine.areaM2, format: model.target.id, ...(model.link ? { link: model.link } : {}) } };
    }

    return { targetFor, redLine, figures, preview, boundaryFeature };
});
