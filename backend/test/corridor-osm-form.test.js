// Tests for frontend/js/corridor-osm-form.js: the road record as an OSM document (roads.md §11).
// A cross-section round-trips through standard OSM tags exactly, a definition becomes ways sharing
// nodes and comes back as the same stretches, and the agreement guard catches a record whose cached
// fields were edited behind its form's back.
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

describe('agreement between a record and its form', () => {
    it('claims nothing for a record without a form, and agrees with the form it was given', () => {
        expect(form.osmFormAgreement(twoStretches())).toEqual({ ok: true, checked: false });
        const definition = form.withOsmForm(twoStretches());
        expect(definition.osm.elements.length).toBe(5);
        expect(form.osmFormAgreement(definition)).toEqual({ ok: true, checked: true });
    });

    it('refuses a record whose stretches, levels or cross-sections were edited behind the form', () => {
        const moved = form.withOsmForm(twoStretches());
        moved.points[1][1] = { lat: C.lat + 0.001, lng: C.lng };
        moved.segments = moved.points;
        expect(form.osmFormAgreement(moved)).toMatchObject({ ok: false, reason: 'stretch 2, point 2 differs' });

        const relaned = form.withOsmForm(twoStretches());
        relaned.segmentProfiles.s2 = strips(18);
        expect(form.osmFormAgreement(relaned)).toMatchObject({ ok: false, reason: 'stretch 2 cross-section differs' });

        const lowered = form.withOsmForm(twoStretches());
        lowered.points[0][1] = { ...B, level: -2 };
        lowered.segments = lowered.points;
        expect(form.osmFormAgreement(lowered)).toMatchObject({ ok: false, reason: 'stretch 1, point 2 level differs' });

        const split = form.withOsmForm(twoStretches());
        split.points = [[A, B]];
        split.segments = split.points;
        split.segmentIds = ['s1'];
        expect(form.osmFormAgreement(split).ok).toBe(false);
    });
});
