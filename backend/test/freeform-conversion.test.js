// Leaving a rule's parcels (user decisions 2026-10-18, MEMORY.md): a Block or Row becomes ONE
// Freeform building — the union of its party-wall buildings, frozen from the stored massing at the
// maximum height the rule allows, never the example build-out — and a rule re-run elsewhere stands
// on the parcels mostly inside the dropped outline.
// frontend/js/proposals/freeform-conversion.js, with turf and the real urban-rule normaliser.
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.turf = turf;
const conversion = require('../../frontend/js/proposals/freeform-conversion.js');
const variation = require('../../frontend/js/urban-rule-variation.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');

const ops = { union: (a, b) => turf.union(a, b) };
const box = (west, south, east, north, properties = {}) => turf.polygon([[
    [west, south], [east, south], [east, north], [west, north], [west, south]
]], properties);
const D = 0.0001; // about 8 m east-west, 11 m north-south at Zagreb's latitude

describe('which records convert', () => {
    it('Block (any of its spellings) and Row convert; Freeform and others are not rules', () => {
        expect(conversion.convertsToFreeform({ goal: 'buildings', typologyType: 'block' })).toBe(true);
        expect(conversion.convertsToFreeform({ goal: 'buildings', buildingProposal: { typologyType: 'buildings' } })).toBe(true);
        expect(conversion.convertsToFreeform({ goal: 'urban-rule' })).toBe(true);
        expect(conversion.convertsToFreeform({ goal: 'buildings', typologyType: 'row' })).toBe(true);
        expect(conversion.ruleTypologyOf({ goal: 'buildings', typologyType: 'parcelBased' })).toBe('parcelBased');
        expect(conversion.convertsToFreeform({ goal: 'buildings', typologyType: 'parcelBased' })).toBe(false);
        // A Detached rule converts only on exactly one parcel: one house.
        const house = box(0, 0, D, D, { height: 9 });
        expect(conversion.convertsToFreeform({ goal: 'buildings', typologyType: 'parcelBased', cadastreParcelIds: ['HR-1'], geometry: { buildings: [house] } })).toBe(true);
        expect(conversion.convertsToFreeform({ goal: 'buildings', typologyType: 'parcelBased', cadastreParcelIds: ['HR-1', 'HR-2'], geometry: { buildings: [house, house] } })).toBe(false);
        expect(conversion.convertsToFreeform({ goal: 'single', typologyType: 'single' })).toBe(false);
        expect(conversion.convertsToFreeform({ goal: 'park', structureProposal: {} })).toBe(false);
    });
});

describe('mergedBuilding: a Block or Row becomes one Freeform building', () => {
    it('unions party-wall buildings into one footprint with their height', () => {
        const row = [box(0, 0, D, D, { height: 12 }), box(D, 0, 2 * D, D, { height: 12 }), box(2 * D, 0, 3 * D, D, { height: 12 })];
        const result = conversion.mergedBuilding(row, ops);
        expect(result.ok).toBe(true);
        expect(result.building.geometry.type).toBe('Polygon');
        expect(turf.area(result.building)).toBeCloseTo(turf.area(box(0, 0, 3 * D, D)), 0);
        expect(result.building.properties).toEqual({ type: 'proposedBuildingSingle', height: 12, rotation: 0, footprintMode: 'polygon' });
    });

    it('keeps a courtyard block\'s hole and drops every rule input, freezing the massing at the rule\'s maximum height', () => {
        const outer = [[0, 0], [4 * D, 0], [4 * D, 4 * D], [0, 4 * D], [0, 0]];
        const hole = [[D, D], [D, 3 * D], [3 * D, 3 * D], [3 * D, D], [D, D]];
        const rule = variation.normalizeBlockRule({ typology: 'block', kind: 'max', maxHeightM: 21, minHeightM: 7 });
        const massing = { type: 'Feature', properties: { height: 21, massing: true, urbanRule: rule, variationSeed: 42, setback: 3 }, geometry: { type: 'Polygon', coordinates: [outer, hole] } };
        // The map draws an example build-out lower than the rule allows; that is never what is frozen.
        expect(variation.realizeFeature(massing, { turf }).properties.height).toBeLessThan(21);

        const result = conversion.mergedBuilding([massing], ops);

        expect(result.ok).toBe(true);
        expect(result.building.geometry.coordinates).toHaveLength(2);
        expect(result.building.properties.height).toBe(21);
        ['urbanRule', 'variationSeed', 'massing', 'setback', 'minFootprint'].forEach(field =>
            expect(result.building.properties).not.toHaveProperty(field));
    });

    it('refuses buildings that do not touch: they cannot be one building', () => {
        const apart = [box(0, 0, D, D, { height: 9 }), box(3 * D, 0, 4 * D, D, { height: 9 })];
        expect(conversion.mergedBuilding(apart, ops)).toMatchObject({ ok: false, code: 'not-contiguous' });
        // A block split by gaps is stored as one MultiPolygon massing: the same refusal.
        const gapped = turf.multiPolygon([box(0, 0, D, D).geometry.coordinates, box(3 * D, 0, 4 * D, D).geometry.coordinates], { height: 9 });
        expect(conversion.mergedBuilding([gapped], ops)).toMatchObject({ ok: false, code: 'not-contiguous' });
    });

    it('takes the highest of parts of different heights: the most the rule allows', () => {
        const stepped = [box(0, 0, D, D, { height: 9, floors: 3 }), box(D, 0, 2 * D, D, { height: 15, floors: 5 }), box(2 * D, 0, 3 * D, D, { height: 12, floors: 4 })];
        const result = conversion.mergedBuilding(stepped, ops);
        expect(result.ok).toBe(true);
        expect(result.building.properties).toMatchObject({ height: 15, floors: 5 });
        expect(turf.area(result.building)).toBeCloseTo(turf.area(box(0, 0, 3 * D, D)), 0);
    });
});

describe('freeformDraftPatch: the draft becomes a Freeform free placement on its site', () => {
    it('re-types the draft and binds the building to the given site', () => {
        const building = conversion.mergedBuilding([box(0, 0, D, D, { height: 9 })], ops).building;
        const site = box(-D, -D, 2 * D, 2 * D).geometry;
        const patch = conversion.freeformDraftPatch({ editorPayload: { context: { blockName: 'Block 12' } } }, { building, site });
        expect(patch).toMatchObject({
            adapterKey: 'single',
            goal: 'single',
            editorPayload: { typology: 'single', placement: { free: true, site, bindingStatus: 'pending' } },
            fields: { site, selectedParcelIds: [], cadastreParcelIds: [], binding: null }
        });
        expect(patch.editorPayload.context.buildings).toEqual([building]);
        expect(patch.editorPayload.context).toMatchObject({ blockName: 'Block 12', blockMassing: null, ineligibleParcels: [], takeWholeParcels: false });
        expect(patch.editorPayload.context.parameters).toEqual({ typology: 'single', height: 9, rotation: 0, footprintMode: 'polygon' });
    });
});

describe('parcelsMostlyInside: the parcels a dropped outline stands on', () => {
    const geometryOps = { intersectionArea: planOrder.intersectionArea, area: feature => turf.area(feature) };
    it('takes the parcels with at least half of their own area inside, largest share first', () => {
        const outline = box(0, 0, 2 * D, D);
        const parcels = [
            { id: 'inside', feature: box(0.1 * D, 0.1 * D, 0.9 * D, 0.9 * D) },
            { id: 'mostly', feature: box(1.2 * D, 0, 2.6 * D, D) },
            { id: 'clipped', feature: box(1.8 * D, 0, 3.8 * D, D) },
            { id: 'outside', feature: box(5 * D, 0, 6 * D, D) }
        ];
        expect(conversion.parcelsMostlyInside(outline, parcels, geometryOps)).toEqual(['inside', 'mostly']);
    });
});
