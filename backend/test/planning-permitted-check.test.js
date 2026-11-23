// The rule check of a design against the Permitted items under it (frontend/js/planning/permitted-check.js),
// on real Alatau general-plan records; the zone use vocabulary those records carry; and the merge of a
// zone that the cell feed returns clipped to each cell.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import * as turf from '@turf/turf';
import { createAlatauGenplanProvider, alatauGenplanSource, interpretZone, ALATAU_ADMTERR_ID } from '../planning/providers/alatau-genplan.js';

const require = createRequire(import.meta.url);
const checker = require('../../frontend/js/planning/permitted-check.js');
const scene = require('../../frontend/js/planning/scene.js');

// A ~150 m square zone near Alatau's centre, and the labels of the classes the checks use.
const ring = (west, south, size = 0.0015) => [[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]];
const ZONE_WEST = 77.02, ZONE_SOUTH = 43.61;
const zone = (id, functional, zoneRing = ring(ZONE_WEST, ZONE_SOUTH)) => ({ type: 'Feature', id: `gpzone.${id}`,
    geometry: { type: 'MultiPolygon', coordinates: [[zoneRing]] },
    properties: { object_id_i32: id, admterr_id: ALATAU_ADMTERR_ID, functional, name_usl: functional, implementation: 'Проектируемые', gpzone: 'Жилые зоны' } });
const HIGH = 'Территория многоэтажной застройки (6-12 этажей)';
const MID = 'Территория среднеэтажной застройки (4-5 и 6* этажей)';
const PARK = 'Территория парков, скверов и т.д. (зона кратковременного отдыха)';
const SCHOOL = 'Территория учреждений образования';

async function records(features, bbox = [77.01, 43.6, 77.03, 43.62]) {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ type: 'FeatureCollection', features }) }));
    const provider = createAlatauGenplanProvider(alatauGenplanSource, { fetchImpl });
    return (await provider.query(null, { bbox, limit: 200 })).items;
}
// A 20 m square building whose south-west corner is `at` [lng, lat].
const building = (id, at, heightM) => ({ id, heightM, footprint: turf.polygon([ring(at[0], at[1], 0.00018)]) });
const inside = [ZONE_WEST + 0.0005, ZONE_SOUTH + 0.0005];
const run = (items, buildings, site = null) => checker.check({ items, buildings, site, geometryOps: turf });

describe('Permitted rule check', () => {
    it('passes a building within its zone\'s storey class and fails one above it', async () => {
        const items = await records([zone(1, HIGH)]);
        const within = run(items, [building('a', inside, 30)]);
        expect(within.status).toBe('pass');
        expect(within.checks.find(check => check.rule === 'height')).toMatchObject({ status: 'pass', limit: 36, storeyLimit: 12, measured: 30 });
        const over = run(items, [building('a', inside, 40)]);
        expect(over.status).toBe('fail');
        expect(over.buildings).toEqual({ a: 'fail' });
        // A limit is kept when the design sits exactly on it.
        expect(run(items, [building('a', inside, 36)]).status).toBe('pass');
    });

    it('calls a height only the asterisked class reaches conditional, with the legend\'s condition', async () => {
        const items = await records([zone(2, MID)]);
        expect(items[0].metrics.conditional).toMatchObject({ heightM: 18, storeys: 6 });
        const between = run(items, [building('a', inside, 17)]);
        expect(between.status).toBe('conditional');
        expect(between.checks.find(check => check.rule === 'height')).toMatchObject({ limit: 15, conditionalLimit: 18 });
        expect(between.checks.find(check => check.rule === 'height').condition).toMatch(/6\*/);
        expect(run(items, [building('a', inside, 19)]).status).toBe('fail');
    });

    it('fails a building on land the plan keeps unbuilt and leaves zones set by another instrument unknown', async () => {
        const park = run(await records([zone(3, PARK)]), [building('a', inside, 9)]);
        expect(park.status).toBe('fail');
        expect(park.checks).toEqual([expect.objectContaining({ rule: 'use', status: 'fail', useKey: 'parks', treatment: 'prohibited' })]);
        const school = run(await records([zone(4, SCHOOL)]), [building('a', inside, 9)]);
        expect(school.status).toBe('unknown');
        expect(school.checks[0]).toMatchObject({ rule: 'use', status: 'unknown', treatment: 'instrument_handoff' });
    });

    it('checks a building against every zone it stands on, and not one it only touches', async () => {
        const east = ring(ZONE_WEST + 0.0015, ZONE_SOUTH);
        const items = await records([zone(5, HIGH), zone(6, PARK, east)]);
        // Straddling the shared edge: the park zone fails it even though the housing zone allows it.
        const straddle = run(items, [building('a', [ZONE_WEST + 0.0014, ZONE_SOUTH + 0.0005], 30)]);
        expect(straddle.status).toBe('fail');
        expect(new Set(straddle.checks.map(check => check.itemId))).toEqual(new Set(items.map(item => item.id)));
        // Flush against the edge from the west: only the housing zone counts.
        const flush = run(items, [building('a', [ZONE_WEST + 0.0015 - 0.00018, ZONE_SOUTH + 0.0005], 30)]);
        expect(flush.status).toBe('pass');
        expect(flush.checks.every(check => check.itemId === items[0].id)).toBe(true);
    });

    it('says nothing where no Permitted item lies under the design', async () => {
        const items = await records([zone(7, HIGH)]);
        expect(run(items, [building('a', [ZONE_WEST + 0.01, ZONE_SOUTH], 90)])).toEqual({ status: 'none', checks: [], buildings: { a: 'none' } });
        expect(run([], [building('a', inside, 90)]).status).toBe('none');
    });

    it('checks plot ratios and minimum lots a source records, in metric units', () => {
        const item = { id: 'x:1', role: 'permitted', title: 'District', assessment: { status: 'allowed' },
            site: turf.polygon([ring(ZONE_WEST, ZONE_SOUTH)]).geometry, metrics: {},
            constraints: [
                { quantity: 'coverage', value: 40, unit: 'percent', bound: 'maximum' },
                { quantity: 'floorAreaRatio', value: 1.2, unit: 'ratio', bound: 'maximum' },
                { quantity: 'lotArea', value: 5000, unit: 'sqft', bound: 'minimum' },
                { quantity: 'height', value: 35, unit: 'ft', bound: 'maximum' }] };
        const result = run([item], [building('a', inside, 12)], { plotAreaM2: 1000, footprintM2: 500, floorAreaM2: 1000 });
        const by = Object.fromEntries(result.checks.map(check => [check.rule, check]));
        expect(by.coverage).toMatchObject({ status: 'fail', measured: 50, limit: 40 });
        expect(by.floorAreaRatio).toMatchObject({ status: 'pass', measured: 1 });
        expect(by.lotArea.status).toBe('pass');
        expect(by.lotArea.limit).toBeCloseTo(464.5, 1);
        // 35 ft is 10.67 m: a 12 m building is over it.
        expect(by.height).toMatchObject({ status: 'fail' });
        expect(by.height.limit).toBeCloseTo(10.668, 3);
        expect(checker.summarize(result)[0].status).toBe('fail');
    });
});

describe('Zone use vocabulary', () => {
    const source = fs.readFileSync(new URL('../planning/providers/alatau-genplan.js', import.meta.url), 'utf8');
    const labels = [...source.matchAll(/^\s+'([^']+)': \{ key: /gm)].map(match => match[1]);
    const locales = ['en', 'hr', 'sr', 'ru', 'es', 'fr', 'pt', 'ar'].map(lang =>
        [lang, JSON.parse(fs.readFileSync(new URL(`../../frontend/i18n/${lang}.json`, import.meta.url), 'utf8'))]);
    const groups = new Set(['housing-low', 'housing-mid', 'housing-high', 'public', 'industry', 'transport', 'green', 'water', 'agriculture', 'reserve', 'restricted']);

    it('gives every Alatau zone class a use key and group that every locale names', () => {
        expect(labels.length).toBe(28);
        for (const label of labels) {
            const reading = interpretZone({ functional: label });
            expect(reading.useKey, label).toMatch(/^[a-z-]+$/);
            expect(groups.has(reading.useGroup), label).toBe(true);
            for (const [lang, strings] of locales) {
                expect(strings.planningViews.use[reading.useKey], `${lang} use ${reading.useKey}`).toBeTruthy();
                expect(strings.planningViews.useGroup[reading.useGroup], `${lang} group ${reading.useGroup}`).toBeTruthy();
            }
        }
    });

    it('has a legend swatch and a map colour for every group', () => {
        const css = fs.readFileSync(new URL('../../frontend/css/planning-views.css', import.meta.url), 'utf8');
        const tokens = fs.readFileSync(new URL('../../frontend/css/tokens.css', import.meta.url), 'utf8');
        for (const group of groups) {
            expect(css).toContain(`.planning-swatch--zone-${group} {`);
            expect(tokens).toContain(`--cb-planning-zone-${group}:`);
        }
    });

    it('records the use on each zone record', async () => {
        const [item] = await records([zone(8, HIGH)]);
        expect(item.use).toEqual({ key: 'residential-high', group: 'housing-high', label: 'Многоэтажная застройка', stage: 'planned' });
    });
});

describe('Cell answers of a clipped zone', () => {
    const piece = (west, east) => ({ id: 'z:1:area', geometry: turf.bboxClip(turf.polygon([ring(ZONE_WEST, ZONE_SOUTH)]), [west, 43, east, 44]).geometry });
    const answer = areas => ({ items: [{ id: 'z:1', role: 'permitted', areas }], summaries: [], unavailable: [] });
    const split = ZONE_WEST + 0.0007;

    it('keeps every cell\'s piece of a zone instead of the last one', () => {
        const merged = scene.mergeAnswers([answer([piece(77, split)]), answer([piece(split, 78)])]);
        expect(merged.items).toHaveLength(1);
        expect(merged.items[0].areas).toHaveLength(2);
        const total = merged.items[0].areas.reduce((sum, area) => sum + turf.area(area.geometry), 0);
        expect(total).toBeCloseTo(turf.area(turf.polygon([ring(ZONE_WEST, ZONE_SOUTH)])), -1);
    });

    it('keeps the pieces when a cell the zone\'s box reaches answers it with none', () => {
        // The zone service matches a cell by the zone's box, so a cell beside the zone lists it empty.
        for (const order of [[answer([piece(77, split)]), answer([])], [answer([]), answer([piece(77, split)])]]) {
            const merged = scene.mergeAnswers(order);
            expect(merged.items).toHaveLength(1);
            expect(merged.items[0].areas).toHaveLength(1);
        }
        expect(scene.mergeAnswers([answer([]), answer([])]).items[0].areas).toEqual([]);
    });

    it('joins the pieces when asked', () => {
        const joinAreas = areas => [{ ...areas[0], geometry: areas.slice(1).reduce((shape, area) => turf.union(shape, turf.feature(area.geometry)), turf.feature(areas[0].geometry)).geometry }];
        const merged = scene.mergeAnswers([answer([piece(77, split)]), answer([piece(split, 78)])], { joinAreas });
        expect(merged.items[0].areas).toHaveLength(1);
        expect(merged.items[0].areas[0].geometry.type).toBe('Polygon');
    });
});
