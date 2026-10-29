// Roads in a city that drives on the left (frontend/js/corridor-profile.js, corridor-osm-form.js,
// corridor-import.js, intent-design.js): OSM's lane tags read on that side of the centre line, the
// presets mirror, and the record says its side with OSM's own `driving_side=left`.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { appTurf as turf, intentDesign as builder } from '../agents/mcp-geometry.js';
import { cityDrivingSide } from '../scripts/lib/frontend-city-money.mjs';

const require = createRequire(import.meta.url);
const P = require('../../frontend/js/corridor-profile.js');
const form = require('../../frontend/js/corridor-osm-form.js');
const imports = require('../../frontend/js/corridor-import.js');

const driving = profile => profile.strips.filter(strip => strip.type === 'driving').map(strip => strip.direction);
const cycling = profile => profile.strips.filter(strip => strip.type === 'cycleway').map(strip => strip.direction);

describe('OSM lane tags on the left', () => {
    it('lays lanes:forward on the left of the centre line where traffic keeps left', () => {
        expect(driving(P.corridorProfileFromOsmTags({ highway: 'residential', lanes: '2' }, undefined, 'left'))).toEqual(['forward', 'backward']);
        expect(driving(P.corridorProfileFromOsmTags({ highway: 'residential', lanes: '2' }))).toEqual(['backward', 'forward']);
        const tags = { highway: 'primary', lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1', median: 'yes' };
        const left = P.corridorProfileFromOsmTags(tags, undefined, 'left');
        expect(left.strips.filter(strip => ['driving', 'median'].includes(strip.type)).map(strip => strip.direction || strip.type))
            .toEqual(['forward', 'forward', 'median', 'backward']);
        // A two-way street's cycle lanes ride with the traffic beside them.
        expect(cycling(P.corridorProfileFromOsmTags({ highway: 'residential', lanes: '2', 'cycleway:both': 'lane' }, undefined, 'left'))).toEqual(['forward', 'backward']);
    });

    it('round-trips every preset, mirrored for the left, through OSM tags read on the left', () => {
        for (const [total, strips] of Object.entries(P.CORRIDOR_PROFILE_PRESETS)) {
            const profile = P.corridorProfileForDrivingSide({ strips }, 'left');
            const tags = P.corridorProfileToOsmTags(profile, 'left');
            const back = P.corridorProfileFromOsmTags(tags, undefined, 'left');
            expect(back.strips.map(strip => strip.direction), `preset ${total}`).toEqual(P.normalizeCorridorProfile(profile).strips.map(strip => strip.direction));
            expect(Object.keys(tags).filter(key => key.endsWith(':oneway')), `preset ${total}`).toEqual([]);
        }
        expect(driving(P.corridorProfileFromLegacy(7.5, 1, false, 'left'))).toEqual(['forward', 'backward']);
    });
});

describe('the record carries its side', () => {
    const points = [{ lat: 53.48, lng: -2.24 }, { lat: 53.48, lng: -2.238 }];
    const view = side => ({ points: [points], segments: [points], profile: P.corridorProfileForDrivingSide({ strips: P.CORRIDOR_PROFILE_PRESETS[18].map(strip => ({ ...strip })) }, side), drivingSide: side });

    it('writes driving_side=left on its ways and reads the same lanes back', () => {
        const record = form.toRecord(view('left'));
        const ways = record.osm.elements.filter(element => element.type === 'way');
        expect(ways.every(way => way.tags.driving_side === 'left')).toBe(true);
        expect(ways.every(way => !way.tags['cb:lanes'])).toBe(true);
        const back = form.toView(record);
        expect(back.drivingSide).toBe('left');
        expect(driving(back.profile)).toEqual(['forward', 'backward']);
        expect(cycling(back.profile)).toEqual(['forward', 'backward']);
    });

    it('says nothing on a right-hand road, which reads back as right', () => {
        const record = form.toRecord(view('right'));
        expect(record.osm.elements.filter(element => element.type === 'way').some(way => 'driving_side' in way.tags)).toBe(false);
        expect(form.toView(record).drivingSide).toBe('right');
    });

    it('reads an imported OSM street of a city that keeps left on the left, and leaves a tagged way as it says', () => {
        const nodes = [{ type: 'node', id: 1, lat: 53.48, lon: -2.24 }, { type: 'node', id: 2, lat: 53.48, lon: -2.238 }];
        const parsed = tags => ({ form: { elements: [...nodes, { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', lanes: '2', ...tags } }] } });
        const [left] = imports.recordsFromImport(parsed({}), { drivingSide: 'left' });
        expect(driving(form.toView(left.roadProposal.definition).profile)).toEqual(['forward', 'backward']);
        const [right] = imports.recordsFromImport(parsed({}), {});
        expect(driving(form.toView(right.roadProposal.definition).profile)).toEqual(['backward', 'forward']);
    });
});

describe('agents draft roads on the city’s side', () => {
    it('reads the side from the city config', () => {
        expect(['manchester', 'london', 'mumbai', 'zagreb'].map(cityDrivingSide)).toEqual(['left', 'left', 'left', 'right']);
    });

    it('a preset road for a left-hand city keeps left, and an edit keeps the record’s side', () => {
        const intent = { kind: 'road', city: 'manchester', points: [[-2.24, 53.48], [-2.238, 53.48]], preset: '1+1 with cycle lanes', authoredAt: '2026-10-28T00:00:00.000Z' };
        const design = builder.build({ ...intent, drivingSide: 'left' }, { turf });
        const view = form.toView(design.roadProposal.definition);
        expect(view.drivingSide).toBe('left');
        expect(driving(view.profile)).toEqual(['forward', 'backward']);
        const edited = builder.modify(design, [{ type: 'set_profile', preset: '2+2' }], { turf });
        const after = form.toView(edited.roadProposal.definition);
        expect(after.drivingSide).toBe('left');
        expect(driving(after.profile)).toEqual(['forward', 'forward', 'backward', 'backward']);
    });
});
