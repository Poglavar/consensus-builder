// Relative rule terms (frontend/js/planning/rule-terms.js): the existing context of a parcel, each
// term, unknown inputs staying unknown (a display-default height must never become a limit), and
// the NPPF 2026 policy L2(1)(d)(iii) as configured in planning-sources.json, checked on a design.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const terms = require('../../frontend/js/planning/rule-terms.js');
const streetWidth = require('../../frontend/js/planning/street-width.js');
const checker = require('../../frontend/js/planning/permitted-check.js');
const config = require('../../frontend/data/planning-sources.json');

// A 20 m × 30 m parcel (600 m²) with one 10 m × 10 m house on it, in a local metre frame near London.
const M = 1 / 111320, LAT = 51.5465, COS = Math.cos(LAT * Math.PI / 180);
const rect = (x, y, w, h) => turf.polygon([[[x * M / COS, LAT + y * M], [(x + w) * M / COS, LAT + y * M], [(x + w) * M / COS, LAT + (y + h) * M], [x * M / COS, LAT + (y + h) * M], [x * M / COS, LAT + y * M]]]);
const parcel = rect(0, 0, 20, 30);
const house = (heightSource, height = 7.5, id = 'h1', at = [2, 2]) => ({ ...rect(at[0], at[1], 10, 10), id, properties: { height, height_source: heightSource } });
const context = (buildings, extra = {}) => terms.existingContext({ parcel, buildings, geometryOps: turf, ...extra });

describe('Existing context', () => {
    it('measures footprint and natural ground on the parcel, and keeps a known height', () => {
        const known = context([house('measured')]);
        expect(known.parcelAreaM2).toBeCloseTo(600, -1);
        expect(known.footprintM2).toBeCloseTo(100, 0);
        expect(known.naturalGroundM2).toBeCloseTo(500, -1);
        expect(known.heightM).toBe(7.5);
        expect(known.buildings[0]).toMatchObject({ known: true, source: 'measured' });
    });
    it('a defaulted height is unknown, never the default number', () => {
        // OpenStreetMap buildings without a height or levels tag get a display height ("estimated").
        const defaulted = context([house('estimated', 10)]);
        expect(defaulted.buildings[0]).toMatchObject({ known: false, heightM: null, source: 'estimated' });
        expect(defaulted.heightM).toBeNull();
        const plusOne = terms.evaluate({ of: 'existingHeight', add: 1, addUnit: 'storeys' }, defaulted, { storeyHeightM: 3 });
        expect(plusOne).toEqual({ value: null, known: false, reason: 'existing-height-unknown' });
        // One defaulted building among known ones still leaves the parcel's height unknown.
        expect(context([house('measured'), house('estimated', 10, 'h2', [8, 15])]).heightM).toBeNull();
        // A footprint entry without height or levels (as /buildings/under answers) is unknown too.
        expect(terms.buildingHeight({ id: 'x', geometry: null, height_m: null, floors: null })).toMatchObject({ known: false, heightM: null });
        expect(terms.buildingHeight({ id: 'x', geometry: null, height_m: null, floors: 4 })).toMatchObject({ known: true, source: 'levels' });
    });
    it('no building source answer leaves every term about buildings unknown; an empty parcel is a known zero', () => {
        const unread = context(null);
        expect(unread.footprintM2).toBeNull();
        expect(terms.evaluate({ of: 'existingFootprint', times: 2 }, unread)).toMatchObject({ known: false, reason: 'existing-buildings-unknown' });
        const empty = context([]);
        expect(empty.footprintM2).toBe(0);
        expect(empty.heightM).toBe(0);
    });
});

describe('Relative terms', () => {
    const known = context([house('measured', 7.5)], {
        street: { widthM: 12, source: 'street-width' },
        neighbours: [9, 12, 15, 6].map((height, i) => ({ id: `n${i}`, properties: { height, height_source: 'measured' } }))
    });
    it('existing height + N storeys', () => {
        expect(terms.evaluate({ of: 'existingHeight', add: 2, addUnit: 'storeys' }, known, { storeyHeightM: 3 }).value).toBe(13.5);
        expect(terms.evaluate({ of: 'existingHeight', add: 1, addUnit: 'storeys' }, known).reason).toBe('storey-height-unknown');
    });
    it('k × existing footprint and a share of the existing natural ground', () => {
        expect(terms.evaluate({ of: 'existingFootprint', times: 2 }, known).value).toBeCloseTo(200, 0);
        expect(terms.evaluate({ of: 'existingNaturalGround', times: 0.5 }, known).value).toBeCloseTo(250, -1);
        expect(terms.evaluate({ of: 'parcelArea', times: 0.4 }, known).value).toBeCloseTo(240, -1);
    });
    it('height from the street width, (width + add) × times', () => {
        expect(terms.evaluate({ of: 'streetWidth', times: 2.5 }, known).value).toBe(30);
        expect(terms.evaluate({ of: 'streetWidth', add: 3, times: 2.5 }, known).value).toBe(37.5);
        expect(terms.evaluate({ of: 'streetWidth', times: 2.5 }, context([])).reason).toBe('street-width-unknown');
    });
    it('precedent over the street\'s neighbours: max, median and the share taller than a height', () => {
        expect(terms.evaluate({ of: 'neighbourHeight', aggregate: 'max' }, known).value).toBe(15);
        expect(terms.evaluate({ of: 'neighbourHeight', aggregate: 'median' }, known).value).toBe(10.5);
        expect(terms.evaluate({ of: 'neighbourHeight', aggregate: 'share-above', aboveM: 10 }, known).value).toBe(0.5);
        const oneDefault = context([], { neighbours: [{ properties: { height: 30, height_source: 'measured' } }, { properties: { height: 10, height_source: 'estimated' } }] });
        expect(terms.evaluate({ of: 'neighbourHeight', aggregate: 'max' }, oneDefault)).toMatchObject({ known: false, reason: 'neighbour-height-unknown' });
    });
    it('resolves constraints: a term gives a derived value, a condition gates it, an unknown input stays unknown', () => {
        const constraints = [
            { quantity: 'height', bound: 'maximum', unit: 'm', term: { of: 'neighbourHeight', aggregate: 'max' },
                when: { of: 'neighbourHeight', aggregate: 'share-above', aboveM: 10, atLeast: 0.5 } },
            { quantity: 'storeys', bound: 'maximum', unit: 'count', value: 4, evidence: 'literal' }
        ];
        expect(terms.resolve(constraints, known)).toEqual([
            expect.objectContaining({ quantity: 'height', value: 15, evidence: 'derived' }), constraints[1]]);
        const shorterStreet = { ...known, neighbours: known.neighbours.map(n => ({ ...n, heightM: 6 })) };
        expect(terms.resolve(constraints, shorterStreet).map(c => c.quantity)).toEqual(['storeys']);
        const unknownStreet = context([house('measured')], { neighbours: [{ properties: { height: 20, height_source: 'estimated' } }] });
        expect(terms.resolve(constraints, unknownStreet)[0]).toMatchObject({ value: null, evidence: 'unknown', unknownReason: 'neighbour-height-unknown' });
    });
    it('the Permitted check reports a relative height limit over an unknown height as unknown', () => {
        const item = { id: 'p', role: 'permitted', areas: [{ geometry: parcel.geometry }], assessment: { status: 'allowed' },
            constraints: [{ quantity: 'height', bound: 'maximum', unit: 'm', term: { of: 'existingHeight', add: 1, addUnit: 'storeys' } }] };
        const design = { id: 'd', heightM: 12, footprint: rect(3, 3, 8, 8) };
        const unknown = checker.check({ items: [item], buildings: [design], context: context([house('estimated', 10)]), storeyHeightM: 3, geometryOps: turf });
        expect(unknown.checks.find(entry => entry.rule === 'height')).toMatchObject({ status: 'unknown', limit: null, unknownReason: 'existing-height-unknown' });
        const known7 = checker.check({ items: [item], buildings: [design], context: context([house('measured', 7.5)]), storeyHeightM: 3, geometryOps: turf });
        expect(known7.checks.find(entry => entry.rule === 'height')).toMatchObject({ status: 'fail', limit: 10.5, measured: 12 });
    });
});

describe('Street setting: width in front and neighbours along the same street', () => {
    const street = (name, y, id) => ({ type: 'Feature', properties: { name, osm_id: id, highway: 'residential' },
        geometry: { type: 'LineString', coordinates: [[-60 * M / COS, LAT + y * M], [80 * M / COS, LAT + y * M]] } });
    // Parcel A faces Test Road (y = 0) from y = 5; a lot across the road starts at y = -5: 10 m wide.
    const A = { ...rect(0, 5, 20, 30), id: 'A' }, across = { ...rect(0, -35, 20, 30), id: 'X' };
    const B = { ...rect(20, 5, 20, 30), id: 'B' }, C = { ...rect(-20, 5, 20, 30), id: 'C' }, D = { ...rect(0, 40, 20, 30), id: 'D' };
    const streets = [street('Test Road', 0, 1), street('Back Lane', 75, 2)];
    const building = (lot, heightM, source) => ({ id: `in-${lot.id}`, geometry: rect(lot.id === 'B' ? 24 : lot.id === 'C' ? -16 : 4, lot.id === 'D' ? 50 : 15, 10, 10).geometry, height_m: source === 'measured' ? heightM : null, floors: null });
    it('measures the street width and keeps only the buildings facing the same street', () => {
        const buildings = [building(B, 12, 'measured'), building(C, null, 'none'), building(D, 30, 'measured')];
        const setting = streetWidth.streetSetting({ parcel: A, streets, parcels: [A, across, B, C, D], buildings, turf });
        expect(setting.street).toMatchObject({ name: 'Test Road', source: 'street-width' });
        expect(setting.street.widthM).toBeCloseTo(10, 0);
        expect(setting.neighbours.map(record => record.id).sort()).toEqual(['in-B', 'in-C']);
        // C's house has no height: the street's precedent is unknown, not the default.
        const known = context([], setting);
        expect(terms.evaluate({ of: 'neighbourHeight', aggregate: 'max' }, known)).toMatchObject({ known: false, reason: 'neighbour-height-unknown' });
        expect(terms.evaluate({ of: 'streetWidth', times: 2 }, known).value).toBeCloseTo(20, 0);
        const surveyed = streetWidth.streetSetting({ parcel: A, streets, parcels: [A, across, B, C, D], buildings: [building(B, 12, 'measured'), { ...building(C), height_m: 9 }], turf });
        expect(terms.evaluate({ of: 'neighbourHeight', aggregate: 'max' }, context([], surveyed)).value).toBe(12);
    });
    it('no facing street or no building source leaves the inputs unknown', () => {
        expect(streetWidth.streetSetting({ parcel: A, streets: [], parcels: [A, B], buildings: [], turf })).toMatchObject({ street: null, neighbours: null });
        expect(streetWidth.streetSetting({ parcel: A, streets, parcels: [A, B], buildings: null, turf }).neighbours).toBeNull();
    });
});

describe('NPPF 2026 L2(1)(d)(iii) on a residential curtilage', () => {
    const policy = config.ruleSets.find(ruleSet => ruleSet.id === 'gb-eng-planning').policies.find(entry => entry.id === 'nppf-2026-l2-1-d-iii');
    const item = { id: 'curtilage', role: 'permitted', areas: [{ geometry: parcel.geometry }], assessment: { status: 'allowed' }, constraints: policy.constraints };
    const run = (footprints, existing) => {
        const buildings = footprints.map((footprint, i) => ({ id: `b${i}`, heightM: 6, footprint }));
        const footprintM2 = footprints.reduce((sum, footprint) => sum + turf.area(footprint), 0);
        return checker.check({ items: [item], buildings, site: { plotAreaM2: turf.area(parcel), footprintM2 }, context: existing, geometryOps: turf });
    };
    it('is sourced from the 2026 Framework text', () => {
        expect(policy.text).toContain('not occupy more than twice the footprint of all the existing buildings on the site');
        expect(policy.text).toContain('retain at least 50% of the non-developed area');
        expect(policy.url).toMatch(/^https:\/\/www\.gov\.uk\/guidance\/national-planning-policy-framework-chapter-12/);
    });
    it('within twice the footprint and half the free ground: passes; beyond: only without harm to character', () => {
        const existing = context([house('estimated')]);
        // The house plus a 9 m × 9 m addition: 181 m² ≤ 200 m²; free ground 419 m² ≥ 250 m².
        const within = run([rect(2, 2, 10, 10), rect(2, 15, 9, 9)], existing);
        expect(within.checks.find(entry => entry.rule === 'footprintArea')).toMatchObject({ status: 'pass' });
        expect(within.checks.find(entry => entry.rule === 'naturalGround')).toMatchObject({ status: 'pass' });
        // 100 + 160 = 260 m² > 200 m²; free ground 340 m² still ≥ 250 m².
        const beyond = run([rect(2, 2, 10, 10), rect(2, 14, 16, 10)], existing);
        expect(beyond.checks.find(entry => entry.rule === 'footprintArea')).toMatchObject({ status: 'conditional', conditionCode: 'no-harm-to-character' });
        expect(beyond.status).toBe('conditional');
    });
    it('without a building survey both limits are unknown', () => {
        const result = run([rect(2, 2, 10, 10)], context(null));
        expect(result.checks.filter(entry => ['footprintArea', 'naturalGround'].includes(entry.rule)).map(entry => entry.status)).toEqual(['unknown', 'unknown']);
    });
});
