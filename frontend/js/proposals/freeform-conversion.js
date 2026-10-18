// proposals/freeform-conversion.js — leaving a building rule's parcels.
//
// Block, Row and Detached are RULES: their buildings are what the rule produces on its parcels, so
// they cannot be moved off them. Leaving the parcels is a conversion to a Freeform building (goal
// 'single', one building): the rule's stored massing (the envelope, at the maximum height the rule
// allows) is frozen and merged into one — footprint, height, floors — and from then on it is edited
// directly and the rule's parameters no longer apply. The varied heights the map shows are only an
// example build-out and are never frozen (user decision 2026-10-18). The other way to land
// a rule somewhere new is to run the same rule on the parcels there (parcelsMostlyInside, also what
// a cadastre-source swap will use to find a rule's new parcels).
//
// Pure: geometry operations are injected, so node tests run the same code as the browser
// (window.__freeformConversion).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__freeformConversion = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const RULE_TYPOLOGIES = Object.freeze(['block', 'row', 'parcelBased']);
    // The rules a saved record converts from (convertsToFreeform). Detached is a per-parcel rule over
    // a selection: separate houses are not one building, so a saved Detached converts only when it
    // covers exactly one parcel, which is one house. Dropped elsewhere in its editor, a Detached on
    // several parcels becomes one Freeform per house instead (proposal-editor-shell.js
    // convertActiveDesignToFreeformBuildings).
    const CONVERTIBLE_TYPOLOGIES = Object.freeze(['block', 'row']);
    // A Freeform building is never lower than this (single-building.js height slider floor).
    const MIN_HEIGHT_M = 3;
    const DEFAULT_HEIGHT_M = 10;
    const STOREY_HEIGHT_M = 3.3;
    // A parcel belongs to the dropped outline when at least this share of its own area lies inside.
    const MOSTLY_INSIDE_SHARE = 0.5;

    const clone = value => (value === undefined || value === null) ? value : JSON.parse(JSON.stringify(value));
    const key = value => String(value === undefined || value === null ? '' : value).trim().toLowerCase().replace(/[\s_-]+/g, '');
    const finitePositive = value => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : null;
    };

    // The rule typology of a building record, or null when it is not a rule (a Freeform building,
    // a park, a road …). 'urban-rule' and the stored typology 'buildings' are the Block rule.
    function ruleTypologyOf(record) {
        if (!record || typeof record !== 'object') return null;
        const goal = key(record.goal);
        const raw = record.typologyType
            || record.buildingProposal?.typologyType
            || record.buildingProposal?.parameters?.typology
            || '';
        const typology = key(raw) || goal;
        if (typology === 'single' || goal === 'single') return null;
        if (typology === 'row') return 'row';
        if (typology === 'parcelbased') return 'parcelBased';
        if (['block', 'buildings', 'urbanrule'].includes(typology)) return 'block';
        return null;
    }

    function heightOf(properties) {
        const direct = finitePositive(properties.height) || finitePositive(properties.heightM);
        if (direct) return direct;
        const storeys = finitePositive(properties.storeys) || finitePositive(properties.floors) || finitePositive(properties.levels);
        return storeys ? storeys * STOREY_HEIGHT_M : DEFAULT_HEIGHT_M;
    }

    function polygonsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return [geometry.coordinates];
        if (geometry.type === 'MultiPolygon') return geometry.coordinates;
        return [];
    }

    // The one building a Block or Row becomes. A Freeform building is ONE building on its own parcel,
    // so the rule's party-wall buildings merge: the footprint is the union of theirs (a courtyard
    // block keeps its hole). The stored massing is taken as is: the envelope at the rule's maximum
    // height, never the example build-out the map varies inside it. Parts of different heights take
    // the highest, the most the rule allows; the user lowers it afterwards in the Freeform editor.
    // Every rule input (urbanRule, variationSeed, massing, setbacks …) is dropped: what remains is
    // the building.
    //
    // Refused, with a code, when the result would not be one building:
    //   'not-contiguous'    the footprints do not touch (a block split by gaps, separate buildings)
    // ops: { union(featureA, featureB) -> Feature | null }.
    function mergedBuilding(features, ops = {}) {
        const parts = [];
        (Array.isArray(features) ? features : []).forEach(feature => {
            if (!feature || !feature.geometry) return;
            const properties = feature.properties || {};
            polygonsOf(feature.geometry).forEach(coordinates => {
                if (!Array.isArray(coordinates) || !Array.isArray(coordinates[0]) || coordinates[0].length < 4) return;
                parts.push({
                    feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: clone(coordinates) } },
                    height: Math.max(MIN_HEIGHT_M, Math.round(heightOf(properties) * 10) / 10),
                    floors: finitePositive(properties.storeys) || finitePositive(properties.floors) || finitePositive(properties.levels),
                    modelUrl: properties.modelUrl || null
                });
            });
        });
        if (!parts.length) return { ok: false, code: 'no-buildings' };
        const tallest = parts.reduce((best, part) => (part.height > best.height ? part : best), parts[0]);
        let footprint = parts[0].feature;
        if (parts.length > 1) {
            if (typeof ops.union !== 'function') return { ok: false, code: 'no-geometry-engine' };
            for (let index = 1; index < parts.length && footprint; index += 1) {
                footprint = ops.union(footprint, parts[index].feature) || null;
            }
            if (!footprint) return { ok: false, code: 'not-contiguous' };
        }
        const merged = polygonsOf(footprint.geometry);
        if (merged.length !== 1) return { ok: false, code: 'not-contiguous', parts: merged.length };
        const floors = tallest.floors;
        const modelUrl = parts.length === 1 ? parts[0].modelUrl : null;
        return {
            ok: true,
            building: {
                type: 'Feature',
                properties: {
                    type: 'proposedBuildingSingle',
                    height: tallest.height,
                    rotation: 0,
                    footprintMode: 'polygon',
                    ...(floors ? { floors: Math.round(floors) } : {}),
                    ...(modelUrl ? { modelUrl } : {})
                },
                geometry: { type: 'Polygon', coordinates: clone(merged[0]) }
            }
        };
    }

    // The Freeform editor context for the merged building (the shape proposal-editor-adapters.js
    // proposalBuildingContext reads), keeping only what a Freeform building has.
    function freeformContext(buildings, options = {}) {
        const list = clone(Array.isArray(buildings) ? buildings : []);
        const tallest = list.reduce((max, feature) => Math.max(max, Number(feature?.properties?.height) || 0), 0);
        return {
            parcelIds: [],
            blockName: options.blockName || null,
            parameters: { typology: 'single', height: tallest || DEFAULT_HEIGHT_M, rotation: 0, footprintMode: 'polygon' },
            buildingFeature: clone(list[0] || null),
            buildings: list,
            blockMassing: null,
            ineligibleParcels: [],
            groundSurface: null,
            groundBoundary: null,
            takeWholeParcels: false
        };
    }

    // Whether this record can be converted to a Freeform building: a Block or Row rule, or a Detached
    // rule on exactly one parcel.
    function convertsToFreeform(record) {
        const typology = ruleTypologyOf(record);
        if (CONVERTIBLE_TYPOLOGIES.includes(typology)) return true;
        if (typology !== 'parcelBased') return false;
        const parcels = new Set((Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : []).map(String));
        const houses = Array.isArray(record.geometry?.buildings) ? record.geometry.buildings.length : 0;
        return parcels.size === 1 && houses <= 1;
    }

    // The draft patch that turns a rule draft into a Freeform draft standing on `site`. A Freeform
    // building is a free placement (proposal-editor-adapters.js), so the site is bound again by the
    // server when it is saved; saving follows the ordinary edit rule (proposals/lineage.js
    // editsInPlace): one's own local record in place, a published one as a counterproposal.
    function freeformDraftPatch(draft, { building, site } = {}) {
        if (!site || !['Polygon', 'MultiPolygon'].includes(site.type)) {
            throw new Error('A Freeform building needs a polygon site.');
        }
        if (!building || !building.geometry) throw new Error('There is no building to keep.');
        const frozen = [building];
        const blockName = draft?.editorPayload?.context?.blockName || null;
        return {
            adapterKey: 'single',
            goal: 'single',
            editorPayload: {
                typology: 'single',
                context: freeformContext(frozen, { blockName }),
                placement: { free: true, site: clone(site), bindingStatus: 'pending' }
            },
            fields: { site: clone(site), selectedParcelIds: [], cadastreParcelIds: [], binding: null }
        };
    }

    // The parcels a dropped outline stands on: those with at least `minShare` of their own area
    // inside it, largest share first. ops: { intersectionArea(a, b) -> m², area(a) -> m² }.
    // parcels: [{ id, feature }].
    function parcelsMostlyInside(outline, parcels, ops, options = {}) {
        if (!outline || !ops || typeof ops.intersectionArea !== 'function' || typeof ops.area !== 'function') return [];
        const minShare = Number.isFinite(options.minShare) ? options.minShare : MOSTLY_INSIDE_SHARE;
        const hits = [];
        (Array.isArray(parcels) ? parcels : []).forEach(entry => {
            if (!entry || !entry.feature || entry.id === undefined || entry.id === null) return;
            const own = Number(ops.area(entry.feature)) || 0;
            if (!(own > 0)) return;
            const inside = Number(ops.intersectionArea(outline, entry.feature)) || 0;
            const share = inside / own;
            if (share >= minShare) hits.push({ id: String(entry.id), share });
        });
        hits.sort((a, b) => b.share - a.share || a.id.localeCompare(b.id));
        return hits.map(hit => hit.id);
    }

    return {
        RULE_TYPOLOGIES,
        CONVERTIBLE_TYPOLOGIES,
        MOSTLY_INSIDE_SHARE,
        ruleTypologyOf,
        convertsToFreeform,
        mergedBuilding,
        freeformContext,
        freeformDraftPatch,
        parcelsMostlyInside
    };
});
