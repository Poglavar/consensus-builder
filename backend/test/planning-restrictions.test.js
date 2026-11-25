// The restrictions stage of Permitted (frontend/js/planning/restrictions.js) over constraint
// sources (constraint-sources.js): effects from the rule set, paging and partial reads, listed
// buildings kept, the Permitted check's designation lines, and England end to end on a recorded
// planning.data.gov.uk answer around Highbury Fields, Islington (no live network).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const restrictions = require('../../frontend/js/planning/restrictions.js');
const sources = require('../../frontend/js/planning/constraint-sources.js');
const checker = require('../../frontend/js/planning/permitted-check.js');
const scene = require('../../frontend/js/planning/scene.js');
const config = require('../../frontend/data/planning-sources.json');
const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/gb-planning-data-islington.json', import.meta.url), 'utf8'));

const england = config.ruleSets.find(ruleSet => ruleSet.id === 'gb-eng-planning');
const source = config.constraintSources.find(entry => entry.id === england.constraintSourceId);
const square = (lng, lat, size) => turf.polygon([[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]]);
const area = (dataset, geometry, fields = {}, entity = Math.floor(Math.random() * 1e9)) => ({ id: `${source.id}:${entity}`, sourceId: source.id, dataset, entity,
    reference: fields.reference ?? String(entity), name: fields.name ?? dataset, geometry, organisation: { id: 1, name: 'Test Borough' },
    fields: { dataset, ...fields }, links: { record: `https://www.planning.data.gov.uk/entity/${entity}`, documentation: null } });
const read = areas => [{ ruleSet: england, source, areas, partial: false }];
const respond = body => ({ ok: true, status: 200, json: async () => body });

describe('Rule-set effects', () => {
    it('takes each dataset\'s effect from the rule set, matching source fields where it says', () => {
        const effect = (dataset, fields) => restrictions.classify({ dataset, fields }, england)?.effect ?? null;
        expect(effect('scheduled-monument')).toBe('prohibit');
        expect(effect('conservation-area')).toBe('restrict');
        expect(effect('article-4-direction-area')).toBe('restrict');
        expect(effect('green-belt')).toBe('note');
        expect(effect('flood-risk-zone', { 'flood-risk-level': '3' })).toBe('note');
        expect(effect('flood-risk-zone', { 'flood-risk-level': '2' })).toBeNull();
        expect(effect('brownfield-land')).toBeNull();
        // The same dataset under another rule set can do something else: the effect is the rule set's.
        expect(restrictions.classify({ dataset: 'green-belt', fields: {} }, { id: 'x', effects: [{ dataset: 'green-belt', effect: 'prohibit' }] }).effect).toBe('prohibit');
    });
});

describe('Constraint source reads', () => {
    const page = (n, next) => ({ type: 'FeatureCollection', links: next ? { next } : {}, count: 1, features: [
        { type: 'Feature', geometry: square(0, 51, 0.001).geometry, properties: { entity: n, dataset: 'conservation-area', name: `Area ${n}`, 'organisation-entity': 5, 'end-date': '' } }] });
    function pagedFetch(pages) {
        const asked = [];
        const fetch = async url => {
            asked.push(url);
            if (url.includes('/entity.json')) return respond({ entities: [{ entity: 5, name: 'Test Borough' }] });
            const offset = Number(new URL(url).searchParams.get('offset') || 0);
            const next = offset + 1 < pages ? `https://www.planning.data.gov.uk/entity.geojson?offset=${offset + 1}` : null;
            return respond(page(offset + 1, next));
        };
        return { fetch, asked };
    }
    it('follows the next page and reads every page within the cap', async () => {
        const { fetch, asked } = pagedFetch(3);
        const answer = await sources.readAreas({ ...source, maxPages: 4 }, { bbox: [0, 51, 0.01, 51.01], datasets: ['conservation-area'], fetch });
        expect(answer.areas.map(entry => entry.name)).toEqual(['Area 1', 'Area 2', 'Area 3']);
        expect(answer.partial).toBe(false);
        expect(asked.filter(url => url.includes('entity.geojson'))).toHaveLength(3);
        expect(answer.areas[0].organisation).toEqual({ id: 5, name: 'Test Borough' });
    });
    it('stops at the page cap and says the read is partial', async () => {
        const { fetch, asked } = pagedFetch(5);
        const answer = await sources.readAreas({ ...source, maxPages: 2 }, { bbox: [0, 51, 0.01, 51.01], datasets: ['conservation-area'], fetch });
        expect(answer.partial).toBe(true);
        expect(answer.areas).toHaveLength(2);
        expect(asked.filter(url => url.includes('entity.geojson'))).toHaveLength(2);
    });
    it('asks for the rule set\'s datasets, the box and the page size in one query', async () => {
        const { fetch, asked } = pagedFetch(1);
        await sources.readAreas(source, { bbox: [-0.1, 51.5, -0.09, 51.51], datasets: ['conservation-area', 'listed-building'], fetch });
        const url = new URL(asked[0]);
        expect(url.searchParams.getAll('dataset')).toEqual(['conservation-area', 'listed-building']);
        expect(url.searchParams.get('geometry')).toBe('POLYGON((-0.1 51.5,-0.09 51.5,-0.09 51.51,-0.1 51.51,-0.1 51.5))');
        expect(url.searchParams.get('limit')).toBe('500');
    });
    it('refuses a next page on another host and drops designations that have ended', async () => {
        const away = async () => respond({ ...page(1, 'https://elsewhere.example/entity.geojson?offset=1') });
        await expect(sources.readAreas(source, { bbox: [0, 51, 0.01, 51.01], datasets: ['conservation-area'], fetch: away })).rejects.toThrow(/elsewhere/);
        const ended = async url => url.includes('/entity.json') ? respond({ entities: [] }) : respond({ type: 'FeatureCollection', links: {}, features: [
            { type: 'Feature', geometry: square(0, 51, 0.001).geometry, properties: { entity: 1, dataset: 'conservation-area', 'end-date': '2020-01-01' } },
            { type: 'Feature', geometry: square(0, 51, 0.001).geometry, properties: { entity: 2, dataset: 'conservation-area', 'end-date': '' } }] });
        const answer = await sources.readAreas(source, { bbox: [0, 51, 0.01, 51.01], datasets: ['conservation-area'], fetch: ended, asOf: '2026-11-25' });
        expect(answer.areas.map(entry => entry.entity)).toEqual([2]);
    });
    it('keeps reads per view: a pan inside an answered box asks for nothing more', async () => {
        const { fetch, asked } = pagedFetch(1);
        const loader = sources.createLoader({ config, scene, fetch });
        await loader.load(['gb-eng-planning'], [-0.104, 51.546, -0.102, 51.547]);
        const count = asked.length;
        await loader.load(['gb-eng-planning'], [-0.1039, 51.5461, -0.1021, 51.5469]);
        expect(asked.length).toBe(count);
        // The map reads only what cuts the envelope.
        await loader.load(['gb-eng-planning'], [-0.104, 51.546, -0.102, 51.547], { effects: ['prohibit'] });
        expect(new URL(asked.at(-1).includes('entity.json') ? asked.at(-2) : asked.at(-1)).searchParams.getAll('dataset').sort())
            .toEqual(['listed-building', 'listed-building-outline', 'scheduled-monument']);
    });
});

describe('Listed buildings are kept', () => {
    const point = [-0.1030, 51.5466];
    const house = { type: 'Feature', id: 'osm:way/1', properties: { source: 'osm', height_source: 'estimated' }, geometry: square(-0.10305, 51.54655, 0.0001).geometry };
    it('a listed building given as a point takes the footprint of the building standing on it', () => {
        const { restrictions: list } = restrictions.restrictionsFor(read([area('listed-building', { type: 'Point', coordinates: point }, { reference: '1195631' })]),
            { buildings: [house], geometryOps: turf });
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ effect: 'prohibit', subject: 'existing-building', footprint: 'building', building: { id: 'osm:way/1', source: 'osm' } });
        expect(list[0].geometry).toEqual(house.geometry);
    });
    it('without a building there it stays a point whose footprint is unknown', () => {
        const { restrictions: list } = restrictions.restrictionsFor(read([area('listed-building', { type: 'Point', coordinates: point })]), { buildings: [], geometryOps: turf });
        expect(list[0]).toMatchObject({ footprint: 'unknown', geometry: { type: 'Point' } });
    });
    it('a point also published as an outline is read once, as the outline', () => {
        const outline = area('listed-building-outline', square(-0.1031, 51.5465, 0.0002).geometry, { 'listed-building': '1195631' });
        const { restrictions: list } = restrictions.restrictionsFor(read([outline, area('listed-building', { type: 'Point', coordinates: point }, { reference: '1195631' })]),
            { buildings: [house], geometryOps: turf });
        expect(list.map(entry => entry.dataset)).toEqual(['listed-building-outline']);
    });
    it('the envelope is cut around it, and a design over it fails while one beside it does not', () => {
        const parcel = square(-0.1032, 51.5464, 0.0005);
        const item = { id: 'p1', role: 'permitted', parcelEnvelope: true, constraints: [], assessment: { status: 'allowed' },
            volumes: [{ id: 'b', geometry: parcel.geometry, baseM: 0, topM: 12 }],
            configurations: [{ id: 'all', volumes: [{ id: 'all:bound', geometry: parcel.geometry, baseM: 0, topM: 12 }], metrics: { footprintM2: turf.area(parcel), floorAreaM2: 1000 } }] };
        const { restrictions: list } = restrictions.restrictionsFor(read([area('listed-building', { type: 'Point', coordinates: point })]), { buildings: [house], geometryOps: turf });
        const [cut] = restrictions.applyToItems([item], list, { geometryOps: turf });
        const houseM2 = turf.area(house);
        expect(turf.area(cut.volumes[0].geometry)).toBeCloseTo(turf.area(parcel) - houseM2, 0);
        expect(turf.booleanPointInPolygon(point, turf.feature(cut.volumes[0].geometry))).toBe(false);
        expect(cut.restrictions[0]).toMatchObject({ effect: 'prohibit', reasonCode: 'listed-building' });
        expect(cut.restrictions[0].cutM2).toBeCloseTo(houseM2, 0);
        expect(cut.configurations[0].metrics).toMatchObject({ floorAreaM2: null });
        const over = checker.check({ items: [cut], restrictions: list, buildings: [{ id: 'x', heightM: 9, footprint: square(-0.10306, 51.54654, 0.00012) }], geometryOps: turf });
        expect(over.checks.find(entry => entry.rule === 'restriction')).toMatchObject({ status: 'fail', reasonCode: 'listed-building', subject: 'existing-building' });
        expect(over.status).toBe('fail');
        const beside = checker.check({ items: [cut], restrictions: list, buildings: [{ id: 'y', heightM: 9, footprint: square(-0.10318, 51.54642, 0.0001) }], geometryOps: turf });
        expect(beside.checks.some(entry => entry.rule === 'restriction')).toBe(false);
    });
});

describe('Restrict and note keep the envelope', () => {
    const parcel = square(0, 51, 0.0005);
    const item = { id: 'z', role: 'permitted', areas: [{ geometry: parcel.geometry }], volumes: [], constraints: [], assessment: { status: 'allowed', meaning: 'zoning-area' } };
    const designated = (dataset, fields) => restrictions.restrictionsFor(read([area(dataset, square(-0.001, 50.999, 0.003).geometry, fields)]), { geometryOps: turf }).restrictions;
    it('a restriction attaches its requirement and the check is conditional on it', () => {
        const list = designated('article-4-direction-area');
        const [kept] = restrictions.applyToItems([item], list, { geometryOps: turf });
        expect(turf.area(kept.areas[0].geometry)).toBeCloseTo(turf.area(parcel), 3);
        expect(kept.restrictions).toEqual([expect.objectContaining({ effect: 'restrict', requirement: 'planning-permission' })]);
        expect(kept.restrictions[0].cutM2).toBeUndefined();
        const result = checker.check({ items: [kept], restrictions: list, buildings: [{ id: 'b', heightM: 6, footprint: square(0.0001, 51.0001, 0.0001) }], geometryOps: turf });
        expect(result.checks.find(entry => entry.rule === 'restriction')).toMatchObject({ status: 'conditional', requirement: 'planning-permission' });
        expect(result.status).toBe('conditional');
    });
    it('a note is a reason line and limits nothing', () => {
        const list = designated('green-belt');
        const [kept] = restrictions.applyToItems([item], list, { geometryOps: turf });
        expect(kept.areas[0].geometry).toEqual(parcel.geometry);
        const result = checker.check({ items: [kept], restrictions: list, buildings: [{ id: 'b', heightM: 6, footprint: square(0.0001, 51.0001, 0.0001) }], geometryOps: turf });
        expect(result.checks.find(entry => entry.rule === 'restriction')).toMatchObject({ status: 'note', reasonCode: 'green-belt' });
        expect(checker.worst(['pass', 'note'])).toBe('note');
        expect(checker.worst(['note', 'unknown'])).toBe('unknown');
    });
    it('a scheduled monument removes its land from a zone', () => {
        const list = restrictions.restrictionsFor(read([area('scheduled-monument', square(0, 51, 0.00025).geometry)]), { geometryOps: turf }).restrictions;
        const [cut] = restrictions.applyToItems([item], list, { geometryOps: turf });
        expect(turf.area(cut.areas[0].geometry)).toBeCloseTo(turf.area(parcel) * 0.75, -1);
    });
});

describe('England end to end (recorded planning.data.gov.uk answer)', () => {
    // Served from the recording: any URL not recorded fails the test instead of reaching the network.
    const replay = async url => {
        const answer = recorded.responses[url];
        if (!answer) throw new Error(`Not recorded: ${url}`);
        return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
    };
    // 1-4 Highbury Place is listed (list entry 1195631); a stand-in footprint around its point.
    const listedPoint = [-0.102773, 51.546773];
    const listedHouse = { type: 'Feature', id: 'osm:way/highbury-place', properties: { source: 'osm' }, geometry: square(listedPoint[0] - 0.00006, listedPoint[1] - 0.00004, 0.00012).geometry };
    async function place() {
        const loader = sources.createLoader({ config, scene, fetch: replay });
        const reads = await loader.load(['gb-eng-planning'], recorded.view);
        const { restrictions: list, partial } = restrictions.restrictionsFor(reads, { buildings: [listedHouse], geometryOps: turf });
        return { list, partial, items: restrictions.unknownBaseItems(list, [england]) };
    }
    it('51.5465, -0.1030 lies in Islington\'s Highbury Fields conservation area: the check says so, with its source', async () => {
        const { list, partial, items } = await place();
        expect(partial).toBe(false);
        const building = { id: 'new', heightM: 9, footprint: square(-0.10305, 51.54645, 0.0001) };
        const result = checker.check({ items, restrictions: list, baseRule: 'unknown', buildings: [building], geometryOps: turf });
        const lines = result.checks.filter(entry => entry.rule === 'restriction');
        expect(lines).toEqual([expect.objectContaining({ status: 'conditional', dataset: 'conservation-area', name: 'Highbury Fields',
            organisation: 'London Borough of Islington', requirement: 'design-scrutiny', sourceLabel: 'planning.data.gov.uk',
            links: expect.objectContaining({ record: 'https://www.planning.data.gov.uk/entity/44009002' }) })]);
        // No base rule is recorded in England: the check says it checked designations only.
        expect(result.checks.find(entry => entry.rule === 'base')).toMatchObject({ status: 'unknown' });
        expect(result.status).toBe('conditional');
    });
    it('the listed 1-4 Highbury Place is kept: it is prohibited land, and a design replacing it fails', async () => {
        const { list, items } = await place();
        const listed = items.find(item => item.restrictions[0].name === '1-4, HIGHBURY PLACE');
        expect(listed.assessment).toMatchObject({ status: 'prohibited', meaning: 'restriction', reasonCode: 'listed-building' });
        expect(listed.areas[0].geometry).toEqual(listedHouse.geometry);
        // Listed buildings with no footprint in the building source stay points, not invented shapes.
        expect(list.filter(entry => entry.dataset === 'listed-building' && entry.footprint === 'unknown')).toHaveLength(7);
        const replacing = { id: 'r', heightM: 15, footprint: turf.feature(listedHouse.geometry) };
        const result = checker.check({ items, restrictions: list, baseRule: 'unknown', buildings: [replacing], geometryOps: turf });
        expect(result.status).toBe('fail');
        expect(result.checks.filter(entry => entry.rule === 'restriction' && entry.status === 'fail').map(entry => entry.name)).toEqual(['1-4, HIGHBURY PLACE']);
        // The prohibited item gives no second, generic "not for building" line.
        expect(result.checks.some(entry => entry.rule === 'use')).toBe(false);
    });
    it('a read stopped at its page cap is reported as partial', async () => {
        const capped = { ...config, constraintSources: config.constraintSources.map(entry => ({ ...entry, maxPages: 1 })) };
        // Ten pages in all, so a read that ignored its cap would end, and end complete.
        const fetch = async url => {
            if (url.includes('/entity.json')) return respond({ entities: [] });
            const offset = Number(new URL(url).searchParams.get('offset') || 0);
            return respond({ type: 'FeatureCollection', features: [], links: offset < 4500 ? { next: `https://www.planning.data.gov.uk/entity.geojson?offset=${offset + 500}` } : {} });
        };
        const reads = await sources.createLoader({ config: capped, scene, fetch }).load(['gb-eng-planning'], recorded.view);
        const { partial } = restrictions.restrictionsFor(reads, { geometryOps: turf });
        expect(partial).toBe(true);
        const result = checker.check({ items: [], restrictions: [], restrictionsPartial: partial, baseRule: 'unknown',
            buildings: [{ id: 'b', heightM: 6, footprint: square(-0.1031, 51.5464, 0.0001) }], geometryOps: turf });
        expect(result.checks.find(entry => entry.rule === 'restrictionsPartial')).toMatchObject({ status: 'unknown' });
    });
});
