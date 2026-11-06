// A building's Use (building-use.js): the presets, the words that name them, their storeys, the
// city models' function codes, the set_use intent the editor and MCP share, and the building's Access
// (point cores or a corridor for its suggested layout) with its set_access intent.
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

describe("a city model's function code", () => {
    it('maps the German LoD2 models\' ALKIS codes onto the six uses, bare or with the building class', () => {
        // Codes as Cologne, Berlin, Hamburg, Stuttgart and Dresden tiles carry them.
        const codes = { '31001_1010': 'residential', '31001_1000': 'residential', '31001_1100': 'mixed', '31001_1120': 'residential-shops',
            '31001_1122': 'mixed', '31001_1123': 'residential-shops', '31001_2000': 'office', '31001_2020': 'office', '31001_2071': 'office',
            '31001_2112': 'industrial', '31001_2310': 'mixed', '31001_2463': 'industrial', '31001_2523': 'industrial', '31001_3010': 'public',
            '31001_3021': 'public', '31001_3065': 'public', '31001_3211': 'public', '1010': 'residential', '3051': 'public' };
        for (const [code, expected] of Object.entries(codes)) expect(use.fromCityModel(code), code).toBe(expected);
    });
    it('states no use for an unknown or other building, a holiday house, or a structure that is no building', () => {
        expect(['31001_9998', '31001_9999', '31001_1313', '51009_1610', '53001_1800', '12345', 'Gebäude'].map(code => use.fromCityModel(code)))
            .toEqual([null, null, null, null, null, null, null]);
        expect(use.fromCityModel(null, null)).toBeNull();
    });
    it('reads a word as a preset, and the usage when the function names none', () => {
        expect(use.fromCityModel('residential')).toBe('residential');
        expect(use.fromCityModel('Offices')).toBe('office');
        expect(use.fromCityModel('31001_9998', '31001_2020')).toBe('office');
        expect(use.fromCityModel(undefined, 'school')).toBe('public');
    });
});

describe("a rule design's use", () => {
    const variation = require('../../frontend/js/urban-rule-variation.js');
    it('is the rule\'s alone, whatever the building carries, and sets every storey', () => {
        expect(use.statedUse({ urbanRule: { typology: 'row', use: 'office' } })).toBe('office');
        // An older agent draft carries a per-building use; the rule's Use still decides.
        expect(use.statedUse({ use: 'public', urbanRule: { use: 'office' } })).toBe('office');
        expect(use.statedUse({ use: 'public', urbanRule: { typology: 'block' } })).toBe(null);
        expect(use.statedUse({ use: 'public' })).toBe('public');
        expect(use.storeyUsesOf({ urbanRule: { typology: 'block', use: 'mixed' } }, 3)).toEqual(['shop', 'office', 'residential']);
        expect(use.storeyUsesOf({ urbanRule: { typology: 'block', use: 'office' } }, 6)).toEqual(new Array(6).fill('office'));
    });
    it('rides the rule\'s extras: a new Row or Detached rule is housing, a Block automatic', () => {
        expect(variation.normalizeRuleExtras({ use: 'Offices', roof: 'pitched' })).toEqual({ roof: 'pitched', use: 'office' });
        expect(variation.normalizeRuleExtras({ use: '' })).toEqual({});
        expect(variation.normalizeBlockRule({ use: 'industrial' }).use).toBe('industrial');
        expect(variation.normalizeParcelRule({ use: 'residential-shops' }).use).toBe('residential-shops');
        expect([variation.defaultRuleExtras('block'), variation.defaultRuleExtras('row'), variation.defaultRuleExtras('parcelBased')])
            .toEqual([{}, { use: 'residential' }, { use: 'residential' }]);
    });
    it('carries a stated Access on the rule\'s extras and leaves automatic unwritten', () => {
        expect(variation.normalizeRuleExtras({ use: 'housing', access: 'Corridor' })).toEqual({ use: 'residential', access: 'corridor' });
        expect(variation.normalizeRuleExtras({ access: 'auto' })).toEqual({});
        expect(variation.normalizeRuleExtras({ access: 'gallery' })).toEqual({});
        expect(variation.normalizeBlockRule({ access: 'point' }).access).toBe('point');
        expect(variation.normalizeParcelRule({ access: 'corridor' }).access).toBe('corridor');
        expect(variation.normalizeBlockRule({}).access).toBeUndefined();
    });
});

describe('building access', () => {
    it('reads point, corridor or auto, and states only point or corridor', () => {
        expect(['point', ' Corridor ', 'AUTO', 'gallery', '', null, 3].map(use.normalizeAccess)).toEqual(['point', 'corridor', 'auto', null, null, null, null]);
        expect(use.statedAccess({ access: 'corridor' })).toBe('corridor');
        expect(use.statedAccess({ access: 'auto' })).toBe(null);
        // A rule building\'s Access is its rule\'s, as its use is.
        expect(use.statedAccess({ access: 'corridor', urbanRule: { typology: 'row', access: 'point' } })).toBe('point');
        expect(use.statedAccess({ access: 'corridor', urbanRule: { typology: 'row' } })).toBe(null);
    });
    it('lets the view override the building, and the building the depth rule', () => {
        expect(use.layoutAccess('corridor', { access: 'point' })).toEqual({ access: 'corridor', basis: 'view' });
        expect(use.layoutAccess('auto', { access: 'point' })).toEqual({ access: 'point', basis: 'design' });
        expect(use.layoutAccess(undefined, { urbanRule: { access: 'corridor' } })).toEqual({ access: 'corridor', basis: 'design' });
        expect(use.layoutAccess('auto', {})).toEqual({ access: 'auto', basis: 'depth' });
        expect(use.layoutAccess('sideways', null)).toEqual({ access: 'auto', basis: 'depth' });
    });
});

describe("OpenStreetMap's building tag", () => {
    it('maps building=* values (and Overture class and subtype words) onto the six uses', () => {
        const tags = { apartments: 'residential', house: 'residential', terrace: 'residential', detached: 'residential',
            retail: 'office', commercial: 'office', office: 'office', warehouse: 'industrial', industrial: 'industrial',
            school: 'public', hospital: 'public', church: 'public', civic: 'public', education: 'public', ' Apartments ': 'residential' };
        for (const [tag, expected] of Object.entries(tags)) expect(use.fromOsmBuilding(tag), tag).toBe(expected);
    });
    it('states no use for building=yes, outbuildings, or no tag', () => {
        expect(['yes', 'garage', 'shed', 'roof', 'barn', 'outbuilding', '', null, undefined].map(tag => use.fromOsmBuilding(tag)))
            .toEqual([null, null, null, null, null, null, null, null, null]);
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

describe('the set_access intent', () => {
    const record = () => ({ goal: 'single', buildingProposal: {}, geometry: { buildings: [{ type: 'Feature', properties: { height: 9 }, geometry: turf.polygon([[[16, 45.8], [16.0002, 45.8], [16.0002, 45.8002], [16, 45.8002], [16, 45.8]]]).geometry }] } });
    it('stores point or corridor on a Freeform building, clears it with auto, and refuses anything else', () => {
        const edited = record();
        intents.buildings(edited, { type: 'set_access', value: 'corridor' }, turf);
        expect(edited.geometry.buildings[0].properties.access).toBe('corridor');
        expect(use.layoutAccess('auto', edited.geometry.buildings[0].properties)).toEqual({ access: 'corridor', basis: 'design' });
        intents.buildings(edited, { type: 'set_access', value: 'auto' }, turf);
        expect('access' in edited.geometry.buildings[0].properties).toBe(false);
        expect(edited.geometry.buildings[0].properties.height).toBe(9);
        expect(() => intents.buildings(record(), { type: 'set_access', value: 'gallery' }, turf)).toThrow(/auto, point, corridor/);
    });
});
