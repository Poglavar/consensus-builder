// Tests for frontend/js/corridor-osm-form.js: the road record as an OSM document (roads.md §11).
// A cross-section round-trips through standard OSM tags exactly, a definition becomes ways sharing
// nodes and comes back as the same stretches, and a definition is stored as its form alone
// (toRecord) and runs as the stretch fields decoded from it (toView).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const form = require('../../frontend/js/corridor-osm-form.js');
const P = require('../../frontend/js/corridor-profile.js');

const strips = key => ({ strips: P.CORRIDOR_PROFILE_PRESETS[key].map(lane => ({ ...lane })) });
const same = (a, b) => JSON.stringify(P.normalizeCorridorProfile(a)) === JSON.stringify(P.normalizeCorridorProfile(b));

describe('cross-section <-> OSM tags', () => {
    it('round-trips every preset exactly through standard tags, without the whole-list escape', () => {
        Object.keys(P.CORRIDOR_PROFILE_PRESETS).forEach(key => {
            const profile = strips(key);
            const tags = form.laneTagsOf(profile);
            expect(tags['cb:lanes'], `preset ${key}`).toBeUndefined();
            expect(same(form.profileFromLaneTags(tags), profile), `preset ${key}`).toBe(true);
            // Plain OSM reads the same street: lane count and total width are the standard keys.
            expect(tags.lanes).toBe(String(profile.strips.filter(lane => lane.type === 'driving').length));
            expect(Number(tags.width)).toBeCloseTo(P.corridorProfileWidth(profile), 3);
        });
    });

    it('keeps edits OSM can carry in standard keys: per-lane widths, a bus lane, a stone footway', () => {
        let profile = strips(26);
        profile = P.withLaneType(profile, 4, 'bus');
        profile = P.withLaneWidth(profile, 6, 4);
        profile = P.withLanePaving(profile, 0, 'paved');
        profile = P.withLaneTreeEvery(profile, 3, 4);
        const tags = form.laneTagsOf(profile);
        expect(tags['cb:lanes']).toBeUndefined();
        expect(tags['width:lanes']).toBe('3.25|4');
        expect(tags['bus:lanes']).toBe('designated|');
        expect(tags.lanes).toBe('2');
        expect(tags['lanes:backward']).toBe('1');
        expect(tags['sidewalk:left:surface']).toBe('paving_stones');
        expect(tags['cb:parking:left:tree_every']).toBe('4');
        expect(tags['cb:verge:left:landscape']).toBe('trees');
        expect(same(form.profileFromLaneTags(tags), profile)).toBe(true);
    });

    it('falls back to the whole lane list only for an order the per-side scheme cannot hold', () => {
        const profile = P.withLaneMoved(strips(26), 2, 0); // cycle lane outside the sidewalk
        const tags = form.laneTagsOf(profile);
        expect(tags['cb:lanes']).toMatch(/^cycleway:1\.5:backward\|sidewalk:3\|/);
        expect(same(form.profileFromLaneTags(tags), profile)).toBe(true);
        // The standard keys still describe the same street for everyone else.
        expect(tags['cycleway:both']).toBe('lane');
        expect(tags['sidewalk:both']).toBe('yes');
    });

    it('never loses the lane order: every permutation of a flank, and random lane lists, come back exactly', () => {
        // Every order of the four flank lanes of the 26 m preset on the left side (the right side mirrored).
        const permutations = items => (items.length <= 1 ? [items] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])));
        const base = strips(26).strips;
        const flank = base.slice(0, 4);
        const centre = base.slice(4, 7);
        permutations(flank).forEach(order => {
            const profile = { strips: [...order, ...centre, ...order.slice().reverse().map(lane => ({ ...lane, direction: lane.direction === 'backward' ? 'forward' : lane.direction }))] };
            const tags = form.laneTagsOf(profile);
            expect(same(form.profileFromLaneTags(tags), profile), order.map(lane => lane.type).join(',')).toBe(true);
        });

        // Random lane lists over every lane type, width, direction and attribute the editor can set.
        let seed = 20261015;
        const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
        const pick = list => list[Math.floor(random() * list.length)];
        const types = ['driving', 'bus', 'cycleway', 'sidewalk', 'verge', 'median', 'parking', 'parking_perpendicular', 'parking_angled'];
        for (let round = 0; round < 200; round += 1) {
            const count = 1 + Math.floor(random() * 9);
            const lanes = Array.from({ length: count }, () => {
                const type = pick(types);
                const lane = { type, width: Math.round((1 + random() * 4) * 100) / 100 };
                if (['driving', 'bus', 'cycleway'].includes(type)) lane.direction = pick(['forward', 'backward', 'both']);
                if (type === 'verge' || type === 'median') lane.landscape = pick(['grass', 'trees']);
                if (type.startsWith('parking') && random() < 0.5) lane.treeEvery = 1 + Math.floor(random() * 6);
                if (type === 'sidewalk' && random() < 0.5) lane.paving = pick(['asphalt', 'paved']);
                return lane;
            });
            const profile = P.normalizeCorridorProfile({ strips: lanes });
            const tags = form.laneTagsOf(profile);
            expect(same(form.profileFromLaneTags(tags), profile), JSON.stringify(lanes)).toBe(true);
        }
    });

    it('writes a track as railway with its gauge', () => {
        const track = P.corridorDefaultTrackProfile(1000);
        const tags = form.laneTagsOf(track);
        expect(tags.railway).toBe('rail');
        expect(tags.gauge).toBe('1000');
        expect(same(form.profileFromLaneTags(tags), track)).toBe(true);
    });
});

const A = { lat: 45.8001, lng: 15.9701 };
const B = { lat: 45.8004, lng: 15.9712, level: -1 };
const C = { lat: 45.8011, lng: 15.9716 };
const twoStretches = () => ({
    points: [[A, B], [B, C]],
    segments: [[A, B], [B, C]],
    segmentIds: ['s1', 's2'],
    profile: strips(26),
    segmentProfiles: { s2: strips(10) }
});

describe('definition <-> form', () => {
    it('writes one way per stretch, sharing the node where they meet, with the level on the node', () => {
        const osm = form.osmFormOf(twoStretches());
        const nodes = osm.elements.filter(element => element.type === 'node');
        const ways = osm.elements.filter(element => element.type === 'way');
        expect(osm.version).toBe(0.6);
        expect(nodes).toHaveLength(3);
        expect(ways).toHaveLength(2);
        expect(ways[0].nodes[1]).toBe(ways[1].nodes[0]);
        expect(nodes.find(node => node.id === ways[0].nodes[1]).tags).toEqual({ 'cb:level': '-1' });
        expect(ways[0].tags).toMatchObject({ highway: 'road', lanes: '2', width: '26', 'cb:segment': 's1' });
        expect(ways[1].tags).toMatchObject({ width: '10', 'cb:segment': 's2' });
        expect(nodes.every(node => node.id < 0) && ways.every(way => way.id < 0)).toBe(true);
    });

    it('reads the form back as the same stretches, cross-sections and levels', () => {
        const definition = twoStretches();
        const back = form.definitionFromOsmForm(form.osmFormOf(definition));
        expect(back.segmentIds).toEqual(['s1', 's2']);
        expect(back.points).toEqual([[A, B], [B, C]]);
        expect(same(back.profile, strips(26))).toBe(true);
        expect(same(back.segmentProfiles.s2, strips(10))).toBe(true);
        expect(back.width).toBe(26);
        expect(P.corridorSegmentEntries(back).map(entry => entry.profile)).toEqual(P.corridorSegmentEntries(definition).map(entry => entry.profile));
    });

    it('keeps a road adopted from OSM in its own class', () => {
        const osm = form.osmFormOf({ ...twoStretches(), metadata: { highway: 'tertiary' } });
        expect(osm.elements.filter(element => element.type === 'way').every(way => way.tags.highway === 'tertiary')).toBe(true);
    });
});

describe('record <-> view (step two: the form is stored, the stretch fields run)', () => {
    const VIEW = form.VIEW_FIELDS;

    it('stores a drawn road as its form alone and reads the same stretches back', () => {
        const view = { ...twoStretches(), tunnels: [{ edgeKey: 'k' }], junctions: [{ id: 'j1' }], metadata: { highway: 'residential' }, polygon: { type: 'Polygon', coordinates: [] } };
        const record = form.toRecord(view);
        expect(form.isRecord(record)).toBe(true);
        VIEW.forEach(field => expect(record[field], field).toBeUndefined());
        expect(record.osm.elements.filter(element => element.type === 'way')).toHaveLength(2);
        expect(record).toMatchObject({ tunnels: [{ edgeKey: 'k' }], junctions: [{ id: 'j1' }], metadata: { highway: 'residential' }, polygon: { type: 'Polygon' } });
        expect(record.osm.elements.find(element => element.type === 'way').tags.highway).toBe('residential');

        const back = form.toView(record);
        expect(back.osm).toBeUndefined();
        expect(back.points).toEqual([[A, B], [B, C]]); // the very numbers, not rounded
        expect(back.segments).toBe(back.points);
        expect(back.segmentIds).toEqual(['s1', 's2']);
        expect(same(back.profile, strips(26)) && same(back.segmentProfiles.s2, strips(10))).toBe(true);
        expect(back.width).toBeCloseTo(P.corridorProfileWidth(strips(26)), 3);
        expect(back).toMatchObject({ tunnels: [{ edgeKey: 'k' }], junctions: [{ id: 'j1' }], polygon: { type: 'Polygon' } });
    });

    it('is idempotent in both directions and leaves what is not a drawn road alone', () => {
        const record = form.toRecord(twoStretches());
        expect(form.toRecord(record)).toEqual(record);
        const view = form.toView(record);
        expect(form.toView(view)).toBe(view);
        const designation = { polygon: { type: 'Polygon', coordinates: [] }, kind: 'road', width: 12 };
        expect(form.toRecord(designation)).toEqual(designation);
        expect(form.toView(designation)).toBe(designation);
        expect(form.isRecord(designation)).toBe(false);
    });

    it('keeps a stretch without an id nameless, and names one only when its own cross-section needs a key', () => {
        const nameless = form.toView(form.toRecord({ points: [[A, B], [B, C]], segments: [[A, B], [B, C]], profile: strips(10) }));
        expect(nameless.segmentIds).toBeUndefined();
        expect(nameless.segmentProfiles).toBeUndefined();
        const elements = form.toRecord({ points: [[A, B], [B, C]], segments: [[A, B], [B, C]], segmentIds: [null, 'wide'], profile: strips(10), segmentProfiles: { wide: strips(26) } }).osm.elements;
        expect(elements.filter(element => element.type === 'way').map(way => way.tags['cb:segment'])).toEqual([undefined, 'wide']);
        const imported = form.definitionFromOsmForm({ elements: elements.map(element => (element.type === 'way' ? { ...element, tags: { ...element.tags, 'cb:segment': undefined } } : element)) });
        expect(imported.segmentIds).toEqual([null, 'way-2']);
        expect(same(imported.segmentProfiles['way-2'], strips(26))).toBe(true);
    });

    it('records a legacy width-only road through the cross-section it implies, at the millimetre', () => {
        const legacy = { points: [A, B, C], width: 12, sidewalkWidth: 2, metadata: { isTrack: false } };
        const view = form.toView(form.toRecord(legacy));
        expect(view.points).toEqual([[A, B, C]]);
        expect(same(view.profile, P.corridorProfileOf(legacy))).toBe(true);
        expect(view.sidewalkWidth).toBeUndefined();
        const odd = { ...twoStretches(), profile: { strips: [{ type: 'driving', width: 6.354701782356649, direction: 'both' }] }, segmentProfiles: {} };
        const back = form.toView(form.toRecord(odd));
        expect(back.profile.strips[0].width).toBe(6.355);
        expect(back.width).toBe(6.355);
    });

    it('carries a level and a measured height on the node, and reads both back', () => {
        const measured = { points: [[A, { ...B, elevationM: 112.4 }, C]], segments: [[A, { ...B, elevationM: 112.4 }, C]], profile: strips(10) };
        const record = form.toRecord(measured);
        const node = record.osm.elements.find(element => element.type === 'node' && element.tags && element.tags.ele);
        expect(node.tags).toEqual({ 'cb:level': '-1', ele: '112.4' });
        expect(form.toView(record).points[0][1]).toEqual({ ...B, elevationM: 112.4 });
    });

    it('refuses to record a road its form would read back differently', () => {
        // no cross-section at all says nothing the form contradicts: the road takes the class default
        const bare = form.toRecord({ points: [[A, B]], segments: [[A, B]] });
        expect(bare.osm.elements.find(element => element.type === 'way').tags.lanes).toBeUndefined();
        expect(form.toView(bare).profile.strips.length).toBeGreaterThan(0);
        expect(form.disagreement(twoStretches(), form.osmFormOf({ ...twoStretches(), segmentProfiles: { s2: strips(18) } }))).toBe('stretch 2 cross-section differs');
        expect(form.disagreement(twoStretches(), form.osmFormOf({ ...twoStretches(), points: [[A, { ...B, level: -2 }], [B, C]], segments: [[A, { ...B, level: -2 }], [B, C]] }))).toBe('stretch 1, point 2 level differs');
        expect(form.disagreement(twoStretches(), form.osmFormOf({ ...twoStretches(), points: [[A, B]], segments: [[A, B]], segmentIds: ['s1'] }))).toMatch(/stretches/);
        expect(form.disagreement(twoStretches(), form.osmFormOf(twoStretches()))).toBeNull();
    });
});
