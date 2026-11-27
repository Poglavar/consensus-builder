// Based on existing buildings (the Block editor's mode, `parameters.mode: "existing"`): the existing
// buildings a design redraws, each on its own footprint at a stated number of storeys ('exact') or
// at its existing height plus added storeys ('additional'), with the design's roof. Pure: the Block
// editor and the MCP Block constructor both build their buildings and saved parameters here, so a
// design an agent drafts is the design a person saves (docs/vocabulary.md, Raised existing buildings).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RaisedExistingBuildings = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null), function () {
    'use strict';
    const RULES = Object.freeze(['exact', 'additional']);
    const ROOFS = Object.freeze(['flat', 'pitched', 'mansard']);
    // The editor's sliders: storeys, added storeys and the storey height in metres.
    const LIMITS = Object.freeze({ proposedHeightFloors: [1, 20], additionalFloors: [0, 20], floorHeightM: [2.5, 5] });
    const DEFAULTS = Object.freeze({ rule: 'exact', proposedHeightFloors: 6, additionalFloors: 1, floorHeightM: 3.5, roof: 'flat' });
    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

    // The buildings a design on `site` redraws: those at least half inside it, so neighbours merely
    // touching its boundary are not swept in. `features` are the building sources' footprints
    // (properties.id and .source); each comes back as { ...properties, id: 'source:id', geometry }.
    function footprintsOnSite(features, site, turf) {
        const block = { type: 'Feature', properties: {}, geometry: site && site.type === 'Feature' ? site.geometry : site };
        const mostlyInside = feature => {
            try {
                const inside = turf.intersect(feature, block);
                return !!inside && turf.area(inside) >= 0.5 * turf.area(feature);
            } catch (_) { return false; }
        };
        return (features || []).filter(feature => feature && feature.geometry && mostlyInside(feature)).map(feature => ({
            ...feature.properties, id: `${feature.properties.source}:${feature.properties.id}`, geometry: feature.geometry
        }));
    }

    // The building's current height as far as its source knows it: the measured height, else its
    // storeys times the design's storey height, else null.
    // A source may state either as a numeric string; null, absent and zero all read as unknown.
    function existingHeightOf(footprint, floorHeightM) {
        const measured = Number(footprint && footprint.height_m);
        if (positive(measured)) return measured;
        const floors = Number(footprint && footprint.floors);
        if (positive(floors)) return floors * floorHeightM;
        return null;
    }

    // Whether 'additional' means anything here: some building's current height or storeys is known.
    function heightsKnown(footprints) {
        return (footprints || []).some(footprint => footprint && (positive(Number(footprint.height_m)) || positive(Number(footprint.floors))));
    }

    // Per-building proposed height under the rule, or null to leave the building out.
    // 'exact': every footprint at exactly the stated storeys (even below its current height: the
    // design states the intended height, it demolishes nothing). 'additional': current height plus
    // the added storeys; a building whose height is unknown is left out, there is nothing to add to.
    function proposedHeightOf(footprint, settings) {
        const existingH = existingHeightOf(footprint, settings.floorHeightM);
        if (settings.rule === 'additional') {
            return { existingH, proposedH: existingH === null ? null : existingH + settings.additionalFloors * settings.floorHeightM };
        }
        return { existingH, proposedH: settings.proposedHeightFloors * settings.floorHeightM };
    }

    // One proposed building per footprint the rule raises, on its own footprint, carrying the
    // building it extends (sourceBuildingId, existingHeight), the storey height and the roof.
    function raise(footprints, settings, { blockName = null } = {}) {
        const features = [];
        (footprints || []).forEach(footprint => {
            const { existingH, proposedH } = proposedHeightOf(footprint, settings);
            if (proposedH === null) return;
            let geometry;
            try { geometry = JSON.parse(JSON.stringify(footprint.geometry)); } catch (_) { return; }
            features.push({
                type: 'Feature',
                properties: {
                    type: 'proposedBuilding',
                    block: blockName,
                    basedOnExisting: true,
                    sourceBuildingId: footprint.id != null ? footprint.id : null,
                    existingHeight: existingH,
                    height: Math.round(proposedH * 100) / 100,
                    // The design's storey height: Plan stats counts the storeys before and after by it,
                    // and a slanted roof sets its attic by it (rule-building-details.js detailRuleOf).
                    floorHeightM: settings.floorHeightM,
                    // The roof set on the raised building (rule-building-details.js reads it from here).
                    ...(settings.roof && settings.roof !== 'flat' ? { roof: settings.roof } : {}),
                    buildingIndex: features.length
                },
                geometry
            });
        });
        return features;
    }

    // The buildings that would stop the design going on the map: for each raised building, the part
    // of it outside `site` when that part is ground under the shared rule the apply check uses
    // (`ground` is geometry-tolerances.js). A building at least half inside is kept by
    // footprintsOnSite, so a straddling one is redrawn whole and must be shown before Done.
    function outsideSite(features, site, turf, ground, toleranceM = 0) {
        const cover = { type: 'Feature', properties: {}, geometry: site && site.type === 'Feature' ? site.geometry : site };
        const outside = [];
        (features || []).forEach((feature, index) => {
            const rest = ground.uncoveredBy(turf, feature, [cover], { site: 'raised-existing-buildings.outsideSite' });
            if (!rest || !ground.isGround(turf, rest, toleranceM)) return;
            outside.push({ index, areaM2: turf.area(rest), geometry: rest.geometry });
        });
        return outside;
    }

    // The design's saved parameters, from which the editor reopens it.
    function parameters(settings) {
        return {
            mode: 'existing',
            typology: 'block',
            rule: settings.rule,
            proposedHeightFloors: settings.proposedHeightFloors,
            additionalFloors: settings.additionalFloors,
            floorHeightM: settings.floorHeightM,
            roof: settings.roof,
            algorithm: null
        };
    }

    return { RULES, ROOFS, LIMITS, DEFAULTS, footprintsOnSite, existingHeightOf, heightsKnown, proposedHeightOf, raise, outsideSite, parameters };
});
