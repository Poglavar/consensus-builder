// A building's Use (building-use.js): the presets, the words that name them, their storeys, and the
// set_use intent the editor and MCP share.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const use = require('../../frontend/js/building-use.js');
const intents = require('../../frontend/js/intent-editing.js');

describe('building use', () => {
    it('reads a preset, or a word that names one, and nothing else', () => {
        expect(['residential', 'Housing', 'offices', 'commercial', 'school', 'mixed use', 'warehouse', 'residential_shops'].map(use.normalize))
            .toEqual(['residential', 'residential', 'office', 'office', 'public', 'mixed', 'industrial', 'residential-shops']);
        expect([undefined, '', 'spaceport', 7].map(use.normalize)).toEqual([null, null, null, null]);
    });
    it('gives each storey its use, ground floor first, and the housing share that follows', () => {
        expect(use.storeyUses('residential-shops', 4)).toEqual(['shop', 'residential', 'residential', 'residential']);
        expect(use.storeyUses('mixed', 4)).toEqual(['shop', 'office', 'residential', 'residential']);
        expect(use.storeyUses('office', 2)).toEqual(['office', 'office']);
        expect([use.housingShare('mixed', 4), use.housingShare('residential', 3), use.housingShare('public', 3), use.housingShare(null, 3)])
            .toEqual([0.5, 1, 0, null]);
        expect(use.storeyUses('mixed', 1)).toEqual(['shop']);
    });
    it('lays out housing only, with shops on the ground floor where the use has them', () => {
        expect(use.layoutRules('residential')).toEqual({ groundFloorUse: 'residential' });
        expect(use.layoutRules('mixed')).toEqual({ groundFloorUse: 'commercial' });
        expect([use.layoutRules('office'), use.layoutRules('industrial'), use.layoutRules(null)]).toEqual([null, null, null]);
    });
});

describe('the set_use intent', () => {
    const record = () => ({ goal: 'single', buildingProposal: {}, geometry: { buildings: [{ type: 'Feature', properties: { height: 9 }, geometry: turf.polygon([[[16, 45.8], [16.0002, 45.8], [16.0002, 45.8002], [16, 45.8002], [16, 45.8]]]).geometry }] } });
    it('stores the preset a word names, and refuses a use the app does not know', () => {
        const edited = record();
        intents.buildings(edited, { type: 'set_use', value: 'Offices' }, turf);
        expect(edited.geometry.buildings[0].properties.use).toBe('office');
        expect(() => intents.buildings(record(), { type: 'set_use', value: 'spaceport' }, turf)).toThrow(/residential, residential-shops, mixed, office, public, industrial/);
    });
});
