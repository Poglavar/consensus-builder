// Unit tests for the frontend's corridor cross-section model (pure geometry, no DOM or map).
// The invariant that matters: a profile's strips always sum to the corridor's total width, because the
// corridor footprint — and every proposal derived from it — depends on that total and nothing else.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    CORRIDOR_PROFILE_PRESETS,
    normalizeCorridorProfile,
    corridorProfileWidth,
    corridorProfileFromLegacy,
    corridorProfileOf,
    corridorStripSpans,
    withSidewalkWidth,
    withLaneWidth,
    withLaneType,
    withLaneInserted,
    withLaneRemoved,
    withLaneMoved,
    offsetPolylinePlanar,
    corridorStripRingPlanar,
    corridorProfileFromOsmTags,
    corridorProfileToOsmTags,
    corridorProfileFromOsmFeature,
    corridorLaneSeparators
} = require('../../frontend/js/corridor-profile.js');

const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) < tolerance;

describe('corridor profile presets', () => {
    it('each preset sums to the total width it is keyed by', () => {
        for (const [total, strips] of Object.entries(CORRIDOR_PROFILE_PRESETS)) {
            expect(close(corridorProfileWidth({ strips }), Number(total)), `preset ${total}`).toBe(true);
        }
    });

    it('every preset has a sidewalk on both sides', () => {
        for (const [total, strips] of Object.entries(CORRIDOR_PROFILE_PRESETS)) {
            expect(strips[0].type, `preset ${total} left`).toBe('sidewalk');
            expect(strips[strips.length - 1].type, `preset ${total} right`).toBe('sidewalk');
        }
    });
});

describe('normalizeCorridorProfile', () => {
    it('drops unknown strip types and non-positive widths', () => {
        const profile = normalizeCorridorProfile([
            { type: 'driving', width: 3 },
            { type: 'helipad', width: 5 },
            { type: 'sidewalk', width: 0 },
            { type: 'sidewalk', width: -1 }
        ]);
        expect(profile.strips).toEqual([{ type: 'driving', width: 3 }]);
    });

    it('returns null when nothing survives', () => {
        expect(normalizeCorridorProfile([{ type: 'helipad', width: 5 }])).toBe(null);
        expect(normalizeCorridorProfile(null)).toBe(null);
    });

    it('accepts both a bare array and a {strips} object', () => {
        const strips = [{ type: 'driving', width: 3 }];
        expect(normalizeCorridorProfile(strips)).toEqual({ strips });
        expect(normalizeCorridorProfile({ strips })).toEqual({ strips });
    });
});

describe('withSidewalkWidth', () => {
    it('keeps the total width fixed by taking the difference out of the lanes', () => {
        const profile = { strips: CORRIDOR_PROFILE_PRESETS[10].map(s => ({ ...s })) };
        const widened = withSidewalkWidth(profile, 2.5);
        expect(close(corridorProfileWidth(widened), 10)).toBe(true);
        expect(widened.strips.filter(s => s.type === 'sidewalk').every(s => s.width === 2.5)).toBe(true);
        // 10 - 2*2.5 = 5 metres of carriageway across two lanes
        expect(close(widened.strips.filter(s => s.type === 'driving').reduce((t, s) => t + s.width, 0), 5)).toBe(true);
    });

    it('narrowing the sidewalk gives the width back to the lanes', () => {
        const narrowed = withSidewalkWidth({ strips: CORRIDOR_PROFILE_PRESETS[10].map(s => ({ ...s })) }, 0.5);
        expect(close(corridorProfileWidth(narrowed), 10)).toBe(true);
        expect(close(narrowed.strips.filter(s => s.type === 'driving').reduce((t, s) => t + s.width, 0), 9)).toBe(true);
    });

    it('refuses a sidewalk that would squeeze the lanes below the minimum', () => {
        expect(withSidewalkWidth({ strips: CORRIDOR_PROFILE_PRESETS[10].map(s => ({ ...s })) }, 4)).toBe(null);
    });

    it('leaves profiles without sidewalks or without lanes alone', () => {
        const rail = { strips: [{ type: 'rail', width: 3 }] };
        expect(withSidewalkWidth(rail, 2)).toEqual(rail);
    });
});

describe('corridorProfileFromLegacy', () => {
    it('uses the preset when the width matches one, so an existing road keeps its footprint', () => {
        const profile = corridorProfileFromLegacy(18, null, false);
        expect(close(corridorProfileWidth(profile), 18)).toBe(true);
        expect(profile.strips.some(s => s.type === 'cycleway')).toBe(true);
    });

    it('applies a recorded sidewalk width to the preset without changing the total', () => {
        const profile = corridorProfileFromLegacy(10, 2, false);
        expect(close(corridorProfileWidth(profile), 10)).toBe(true);
        expect(profile.strips.filter(s => s.type === 'sidewalk').every(s => s.width === 2)).toBe(true);
    });

    it('synthesises two lanes for an off-preset width', () => {
        const profile = corridorProfileFromLegacy(9, 0, false);
        expect(profile.strips).toEqual([
            { type: 'driving', width: 4.5, direction: 'forward' },
            { type: 'driving', width: 4.5, direction: 'backward' }
        ]);
    });

    it('adds sidewalks to an off-preset width when they fit', () => {
        const profile = corridorProfileFromLegacy(9, 1.5, false);
        expect(close(corridorProfileWidth(profile), 9)).toBe(true);
        expect(profile.strips.map(s => s.type)).toEqual(['sidewalk', 'driving', 'driving', 'sidewalk']);
    });

    it('omits sidewalks that would leave less than 5 m of carriageway', () => {
        const profile = corridorProfileFromLegacy(7, 1.5, false);
        expect(profile.strips.map(s => s.type)).toEqual(['driving', 'driving']);
    });

    it('makes a track a single rail bed', () => {
        expect(corridorProfileFromLegacy(3, null, true)).toEqual({ strips: [{ type: 'rail', width: 3 }] });
    });

    it('rejects a nonsensical width', () => {
        expect(corridorProfileFromLegacy(0, 1, false)).toBe(null);
        expect(corridorProfileFromLegacy(NaN, 1, false)).toBe(null);
    });
});

describe('corridorProfileOf', () => {
    it('prefers a stored profile over the legacy width', () => {
        const definition = { width: 10, profile: { strips: [{ type: 'driving', width: 4 }] } };
        expect(corridorProfileOf(definition)).toEqual({ strips: [{ type: 'driving', width: 4 }] });
    });

    it('synthesises from width for corridors drawn before profiles existed', () => {
        const profile = corridorProfileOf({ width: 10, sidewalkWidth: 1.5 });
        expect(close(corridorProfileWidth(profile), 10)).toBe(true);
    });

    it('reads isTrack out of the definition metadata', () => {
        const profile = corridorProfileOf({ width: 3, metadata: { isTrack: true } });
        expect(profile.strips[0].type).toBe('rail');
    });
});

describe('corridorStripSpans', () => {
    it('lays the strips out from the left edge to the right edge, straddling the centerline', () => {
        const spans = corridorStripSpans({ strips: [
            { type: 'sidewalk', width: 1 }, { type: 'driving', width: 3 }, { type: 'driving', width: 3 }, { type: 'sidewalk', width: 1 }
        ] });
        expect(spans.map(s => [s.left, s.right])).toEqual([[4, 3], [3, 0], [0, -3], [-3, -4]]);
    });

    it('spans are contiguous and cover exactly the total width', () => {
        const spans = corridorStripSpans({ strips: CORRIDOR_PROFILE_PRESETS[26] });
        expect(close(spans[0].left, 13)).toBe(true);
        expect(close(spans[spans.length - 1].right, -13)).toBe(true);
        for (let i = 1; i < spans.length; i++) expect(close(spans[i].left, spans[i - 1].right)).toBe(true);
    });
});

describe('corridorLaneSeparators', () => {
    it('places a dashed separator on the shared boundary of same-direction traffic lanes', () => {
        expect(corridorLaneSeparators({ strips: [
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'driving', width: 3, direction: 'forward' }
        ] })).toEqual([{ offset: 0, kind: 'lane' }]);
    });

    it('uses a solid centerline where adjacent traffic lanes reverse direction', () => {
        expect(corridorLaneSeparators({ strips: [
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'driving', width: 3, direction: 'backward' }
        ] })).toEqual([{ offset: 0, kind: 'centerline' }]);
    });

    it('marks bus-lane boundaries as traffic-lane separators', () => {
        expect(corridorLaneSeparators({ strips: [
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'bus', width: 3, direction: 'forward' }
        ] })).toEqual([{ offset: 0, kind: 'lane' }]);
    });

    it('does not draw a traffic marking across a median or against roadside furniture', () => {
        expect(corridorLaneSeparators({ strips: [
            { type: 'sidewalk', width: 2 },
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'median', width: 2 },
            { type: 'driving', width: 3, direction: 'backward' },
            { type: 'parking', width: 2 }
        ] })).toEqual([]);
    });

    it('gives every preset the expected number and kind of markings', () => {
        const expected = {
            7.5: ['centerline'], 10: ['centerline'], 18: ['centerline'], 26: [],
            40: ['lane', 'lane'], 80: ['lane', 'lane', 'lane', 'lane']
        };
        for (const [width, kinds] of Object.entries(expected)) {
            const separators = corridorLaneSeparators({ strips: CORRIDOR_PROFILE_PRESETS[width] });
            expect(separators.map(separator => separator.kind), `preset ${width}`).toEqual(kinds);
        }
    });
});

// Shoelace area of a planar ring; negative means clockwise.
function ringArea(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
}

const pointsClose = (a, b) => close(a[0], b[0], 1e-9) && close(a[1], b[1], 1e-9);

describe('offsetPolylinePlanar', () => {
    // A straight line east along y=0. The left-hand normal points north (+y).
    it('offsets left for a positive distance and right for a negative one', () => {
        expect(offsetPolylinePlanar([[0, 0], [100, 0]], 3)).toEqual([[0, 3], [100, 3]]);
        expect(offsetPolylinePlanar([[0, 0], [100, 0]], -3)).toEqual([[0, -3], [100, -3]]);
    });

    // east, then north: a left turn, so the inside of the bend is the left (positive) side.
    const bent = [[0, 0], [100, 0], [100, 100]];

    it('mitres the inside of a turn, where the corridor quads overlap', () => {
        const offset = offsetPolylinePlanar(bent, 2);
        expect(offset.length).toBe(3); // no extra vertex: the joint is a single mitre point
        expect(pointsClose(offset[1], [98, 2])).toBe(true);
    });

    it('bevels the outside of a turn, matching the corridor outline', () => {
        const offset = offsetPolylinePlanar(bent, -2);
        expect(offset.length).toBe(4); // the joint is a bevel: two points, not a protruding mitre
        expect(pointsClose(offset[1], [100, -2])).toBe(true);
        expect(pointsClose(offset[2], [102, 0])).toBe(true);
    });

    it('a boundary lying on the centerline passes straight through the vertex', () => {
        expect(offsetPolylinePlanar(bent, 0)).toEqual(bent);
    });

    it('bevels instead of mitring when the line nearly doubles back', () => {
        const spike = [[0, 0], [100, 0], [0, 1]];
        const offset = offsetPolylinePlanar(spike, 2);
        expect(offset.length).toBe(4); // the joint became two points rather than a runaway mitre
        expect(offset.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    });

    it('skips zero-length edges instead of emitting NaN', () => {
        const offset = offsetPolylinePlanar([[0, 0], [0, 0], [100, 0]], 2);
        expect(offset).toEqual([[0, 2], [100, 2]]);
    });

    it('returns null for a line with no length at all', () => {
        expect(offsetPolylinePlanar([[5, 5], [5, 5]], 2)).toBe(null);
    });
});

describe('corridorStripRingPlanar', () => {
    const straight = [[0, 0], [100, 0]];

    it('walks the left boundary forward and the right boundary back', () => {
        expect(corridorStripRingPlanar(straight, 4, 3)).toEqual([[0, 4], [100, 4], [100, 3], [0, 3]]);
    });

    it('does not care which offset is given first', () => {
        expect(corridorStripRingPlanar(straight, 3, 4)).toEqual(corridorStripRingPlanar(straight, 4, 3));
    });

    it('handles a strip that straddles the centerline', () => {
        expect(corridorStripRingPlanar(straight, 1.5, -1.5)).toEqual([[0, 1.5], [100, 1.5], [100, -1.5], [0, -1.5]]);
    });

    it('a straight strip has exactly width x length area', () => {
        expect(close(ringArea(corridorStripRingPlanar(straight, 4, 1)), 300, 1e-6)).toBe(true);
    });

    it('adjacent strips share their boundary exactly, so they neither gap nor overlap', () => {
        const bent = [[0, 0], [100, 0], [100, 100]];
        // A shared offset produces one and the same boundary, whichever strip asks for it.
        const shared = offsetPolylinePlanar(bent, 3);
        const inner = corridorStripRingPlanar(bent, 3, 0);
        const outer = corridorStripRingPlanar(bent, 6, 3);
        expect(inner.slice(0, shared.length).every((p, i) => pointsClose(p, shared[i]))).toBe(true);
        expect(outer.slice(-shared.length).every((p, i) => pointsClose(p, [...shared].reverse()[i]))).toBe(true);
    });

    it('a bend loses no area to the joint: strips still tile their corridor', () => {
        const bent = [[0, 0], [100, 0], [100, 100]];
        const whole = ringArea(corridorStripRingPlanar(bent, 4, -4));
        const parts = ringArea(corridorStripRingPlanar(bent, 4, 0)) + ringArea(corridorStripRingPlanar(bent, 0, -4));
        expect(close(whole, parts, 1e-6)).toBe(true);
    });

    it('the outermost strip stays inside the corridor: its outer edge is bevelled, not mitred', () => {
        const bent = [[0, 0], [100, 0], [100, 100]];
        // Right side (-4) is the outside of this left turn, so it must not reach the mitre point 104,-4.
        const ring = corridorStripRingPlanar(bent, 0, -4);
        expect(ring.some(p => pointsClose(p, [104, -4]))).toBe(false);
        expect(ring.some(p => pointsClose(p, [100, -4]))).toBe(true);
        expect(ring.some(p => pointsClose(p, [104, 0]))).toBe(true);
    });

    it('rejects a degenerate strip', () => {
        expect(corridorStripRingPlanar(straight, 3, 3)).toBe(null);
        expect(corridorStripRingPlanar([[0, 0]], 3, 1)).toBe(null);
    });
});

// The OSM bridge. A road we propose and a road imported from OSM must reach the renderer as the same
// object, so the profile has to survive a trip out to way tags and back.
describe('corridorProfileFromOsmTags', () => {
    it('reads a fully tagged street into a cross-section that totals its width', () => {
        const profile = corridorProfileFromOsmTags({
            highway: 'secondary', width: '18', lanes: '2',
            'sidewalk:both': 'yes', 'sidewalk:both:width': '2',
            'cycleway:both': 'lane', 'cycleway:both:width': '1.5',
            'parking:both': 'lane', 'parking:both:width': '2'
        });
        expect(profile.strips.map(s => s.type)).toEqual([
            'sidewalk', 'cycleway', 'parking', 'driving', 'driving', 'parking', 'cycleway', 'sidewalk'
        ]);
        expect(close(corridorProfileWidth(profile), 18)).toBe(true);
        expect(profile.strips.filter(s => s.type === 'driving').map(s => s.direction)).toEqual(['forward', 'backward']);
    });

    // Only 9 of 5167 ways across central Zagreb carry a width tag, so this is the normal path.
    it('derives the width from the cross-section when the way has no width tag', () => {
        // residential: 2 lanes x 3 m
        expect(close(corridorProfileWidth(corridorProfileFromOsmTags({ highway: 'residential' })), 6)).toBe(true);
        // ...plus the furniture the tags describe, rather than being squeezed into a guessed total
        const withFurniture = corridorProfileFromOsmTags({ highway: 'residential', 'sidewalk:both': 'yes', 'parking:right': 'lane' });
        expect(close(corridorProfileWidth(withFurniture), 6 + 2 + 2 + 2.5)).toBe(true);
        expect(withFurniture.strips.map(s => s.type)).toEqual(['sidewalk', 'driving', 'driving', 'parking', 'sidewalk']);
    });

    it('gives a single lane to the classes that only ever have one', () => {
        expect(corridorProfileFromOsmTags({ highway: 'service' }).strips.filter(s => s.type === 'driving').length).toBe(1);
        expect(corridorProfileFromOsmTags({ highway: 'track' }).strips.filter(s => s.type === 'driving').length).toBe(1);
        expect(corridorProfileFromOsmTags({ highway: 'residential' }).strips.filter(s => s.type === 'driving').length).toBe(2);
    });

    it('gives a carriageway-free way its own single lane', () => {
        expect(corridorProfileFromOsmTags({ highway: 'footway' }).strips).toEqual([{ type: 'sidewalk', width: 2 }]);
        expect(corridorProfileFromOsmTags({ highway: 'pedestrian' }).strips).toEqual([{ type: 'sidewalk', width: 8 }]);
        expect(corridorProfileFromOsmTags({ highway: 'cycleway' }).strips).toEqual([{ type: 'cycleway', width: 2.5, direction: 'both' }]);
        expect(corridorProfileFromOsmTags({ highway: 'steps', width: '3' }).strips).toEqual([{ type: 'sidewalk', width: 3 }]);
    });

    it('a tagged width stays authoritative, with the driving lanes absorbing the furniture', () => {
        const profile = corridorProfileFromOsmTags({ highway: 'residential', width: '12', 'sidewalk:both': 'yes' });
        expect(close(corridorProfileWidth(profile), 12)).toBe(true);
        expect(close(profile.strips.filter(s => s.type === 'driving').reduce((t, s) => t + s.width, 0), 8)).toBe(true);
    });

    it('honours a bare sidewalk=left as a sidewalk on the left only', () => {
        const profile = corridorProfileFromOsmTags({ highway: 'residential', width: '10', sidewalk: 'left' });
        expect(profile.strips.map(s => s.type)).toEqual(['sidewalk', 'driving', 'driving']);
    });

    it('treats sidewalk=no and sidewalk=separate as absent', () => {
        ['no', 'separate', 'none'].forEach(value => {
            const profile = corridorProfileFromOsmTags({ highway: 'residential', width: '10', sidewalk: value });
            expect(profile.strips.every(s => s.type !== 'sidewalk'), value).toBe(true);
        });
    });

    it('reads per-side widths that differ', () => {
        const profile = corridorProfileFromOsmTags({
            highway: 'residential', width: '12', lanes: '2',
            'sidewalk:both': 'yes', 'sidewalk:left:width': '3', 'sidewalk:right:width': '1'
        });
        const sidewalks = profile.strips.filter(s => s.type === 'sidewalk');
        expect(sidewalks.map(s => s.width)).toEqual([3, 1]);
        expect(close(corridorProfileWidth(profile), 12)).toBe(true);
    });

    it('accepts the older parking:lane scheme as well as the current parking one', () => {
        const current = corridorProfileFromOsmTags({ highway: 'residential', width: '12', 'parking:both': 'lane' });
        const legacy = corridorProfileFromOsmTags({ highway: 'residential', width: '12', 'parking:lane:both': 'parallel' });
        expect(current.strips.map(s => s.type)).toEqual(legacy.strips.map(s => s.type));
    });

    it('makes every lane forward on a oneway, and every lane backward on oneway=-1', () => {
        const forward = corridorProfileFromOsmTags({ highway: 'residential', width: '7', lanes: '2', oneway: 'yes' });
        expect(forward.strips.every(s => s.direction === 'forward')).toBe(true);
        const backward = corridorProfileFromOsmTags({ highway: 'residential', width: '7', lanes: '2', oneway: '-1' });
        expect(backward.strips.every(s => s.direction === 'backward')).toBe(true);
    });

    it('splits the carriageway around a median', () => {
        const profile = corridorProfileFromOsmTags({
            highway: 'primary', width: '20', lanes: '4', median: 'yes', 'median:width': '4'
        });
        expect(profile.strips.map(s => s.type)).toEqual(['driving', 'driving', 'median', 'driving', 'driving']);
        expect(close(corridorProfileWidth(profile), 20)).toBe(true);
    });

    it('reads a railway as one lane per track', () => {
        const profile = corridorProfileFromOsmTags({ railway: 'rail', width: '9', tracks: '2' });
        expect(profile.strips.map(s => s.type)).toEqual(['rail', 'rail']);
        expect(close(corridorProfileWidth(profile), 9)).toBe(true);
    });

    it('refuses tags that describe more furniture than the way has room for', () => {
        expect(corridorProfileFromOsmTags({
            highway: 'residential', width: '6', lanes: '2',
            'sidewalk:both': 'yes', 'sidewalk:both:width': '2', 'parking:both': 'lane'
        })).toBe(null);
    });

    it('parses widths written with a unit or a comma', () => {
        const profile = corridorProfileFromOsmTags({ highway: 'residential', width: '10 m', lanes: '2' });
        expect(close(corridorProfileWidth(profile), 10)).toBe(true);
        expect(close(corridorProfileWidth(corridorProfileFromOsmTags({ highway: 'residential', width: '10,5' })), 10.5)).toBe(true);
    });
});

describe('corridorProfileToOsmTags', () => {
    it('round-trips every preset through OSM tags without losing a lane or a metre', () => {
        for (const [total, strips] of Object.entries(CORRIDOR_PROFILE_PRESETS)) {
            const profile = { strips };
            const tags = corridorProfileToOsmTags(profile);
            const back = corridorProfileFromOsmTags(tags);
            expect(back.strips.map(s => s.type), `preset ${total}`).toEqual(profile.strips.map(s => s.type));
            expect(close(corridorProfileWidth(back), Number(total)), `preset ${total} width`).toBe(true);
        }
    });

    it('emits the per-side schemes OSM actually uses', () => {
        const tags = corridorProfileToOsmTags({ strips: CORRIDOR_PROFILE_PRESETS[18] });
        expect(tags.lanes).toBe('2');
        expect(tags['sidewalk:both']).toBe('yes');
        expect(tags['sidewalk:both:width']).toBe('2');
        expect(tags['cycleway:both']).toBe('lane');
        expect(tags['parking:both']).toBe('lane');
        expect(tags.width).toBe('18');
    });

    it('collapses to one side when only one side has the lane', () => {
        const tags = corridorProfileToOsmTags({ strips: [
            { type: 'sidewalk', width: 2 },
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'driving', width: 3, direction: 'backward' }
        ] });
        expect(tags['sidewalk:left']).toBe('yes');
        expect(tags['sidewalk:both']).toBe(undefined);
    });

    it('writes per-side widths when the two sides differ', () => {
        const tags = corridorProfileToOsmTags({ strips: [
            { type: 'sidewalk', width: 3 },
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'driving', width: 3, direction: 'backward' },
            { type: 'sidewalk', width: 1 }
        ] });
        expect(tags['sidewalk:left:width']).toBe('3');
        expect(tags['sidewalk:right:width']).toBe('1');
    });

    it('marks a one-way street as oneway rather than splitting the lanes', () => {
        const tags = corridorProfileToOsmTags({ strips: [
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'driving', width: 3, direction: 'forward' }
        ] });
        expect(tags.oneway).toBe('yes');
        expect(tags['lanes:forward']).toBe(undefined);
    });

    it('describes a track as a railway', () => {
        expect(corridorProfileToOsmTags({ strips: [{ type: 'rail', width: 3 }] })).toEqual({ railway: 'rail', width: '3' });
    });

    it('refuses a profile with no carriageway to hang the tags on', () => {
        expect(corridorProfileToOsmTags({ strips: [{ type: 'sidewalk', width: 2 }] })).toBe(null);
    });
});

describe('corridorProfileFromOsmFeature', () => {
    it('reads the feature shape road-detection.js produces', () => {
        const feature = {
            type: 'Feature',
            properties: {
                id: 123, highway: 'residential', width: '12',
                osmTags: { highway: 'residential', width: '12', lanes: '2', 'sidewalk:both': 'yes' }
            },
            geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }
        };
        const profile = corridorProfileFromOsmFeature(feature);
        expect(profile.strips.map(s => s.type)).toEqual(['sidewalk', 'driving', 'driving', 'sidewalk']);
        expect(close(corridorProfileWidth(profile), 12)).toBe(true);
    });

    it('derives a width for an untagged way from its highway class', () => {
        const profile = corridorProfileFromOsmFeature({ properties: { highway: 'tertiary', osmTags: { highway: 'tertiary' } } });
        expect(close(corridorProfileWidth(profile), 6)).toBe(true); // 2 lanes x 3 m
    });
});

// Editing. The invariant under all of these: the total width never moves, because the total *is* the
// corridor's footprint, and the footprint is what every descendant proposal was derived from.
describe('profile edits preserve the total width', () => {
    const preset = () => ({ strips: CORRIDOR_PROFILE_PRESETS[18].map(s => ({ ...s })) });
    const TOTAL = 18;

    it('widening a sidewalk takes the metres from the traffic lanes', () => {
        const edited = withLaneWidth(preset(), 0, 3.5);
        expect(close(corridorProfileWidth(edited), TOTAL)).toBe(true);
        expect(edited.strips[0].width).toBe(3.5);
        expect(close(edited.strips.filter(s => s.type === 'driving').reduce((t, s) => t + s.width, 0), 7 - 1.5)).toBe(true);
    });

    it('narrowing a lane gives the metres back', () => {
        const edited = withLaneWidth(preset(), 2, 1);
        expect(close(corridorProfileWidth(edited), TOTAL)).toBe(true);
        expect(edited.strips[2].width).toBe(1);
    });

    it('a traffic lane cannot pay for its own widening', () => {
        const profile = preset();
        const drivingIndex = profile.strips.findIndex(s => s.type === 'driving');
        const edited = withLaneWidth(profile, drivingIndex, 4.5);
        expect(close(corridorProfileWidth(edited), TOTAL)).toBe(true);
        expect(edited.strips[drivingIndex].width).toBe(4.5);
        expect(close(edited.strips[drivingIndex + 1].width, 2.5)).toBe(true); // the other lane paid
    });

    it('refuses an edit the traffic lanes cannot absorb', () => {
        expect(withLaneWidth(preset(), 0, 7)).toBe(null); // would leave the lanes below 2.5 m each
        expect(withLaneWidth(preset(), 0, 0)).toBe(null);
        expect(withLaneWidth(preset(), 99, 2)).toBe(null);
    });

    it('refuses to narrow a traffic lane below the minimum', () => {
        const drivingIndex = preset().strips.findIndex(s => s.type === 'driving');
        expect(withLaneWidth(preset(), drivingIndex, 2)).toBe(null);
    });

    it('changing a lane type keeps its width, so the total cannot move', () => {
        const edited = withLaneType(preset(), 2, 'verge'); // parking becomes trees
        expect(close(corridorProfileWidth(edited), TOTAL)).toBe(true);
        expect(edited.strips[2]).toEqual({ type: 'verge', width: 2 });
    });

    it('a lane that becomes directional gains a direction', () => {
        const edited = withLaneType(preset(), 2, 'cycleway');
        expect(edited.strips[2].direction).toBe('forward');
    });

    it('rejects an unknown lane type rather than dropping the lane', () => {
        expect(withLaneType(preset(), 2, 'helipad')).toBe(null);
    });

    it('inserting a lane takes its width from the traffic lanes', () => {
        // The 18 m preset has a 7 m carriageway over two lanes, so a 2 m bus lane leaves 2.5 m each.
        const edited = withLaneInserted(preset(), 3, { type: 'bus', width: 2, direction: 'forward' });
        expect(close(corridorProfileWidth(edited), TOTAL)).toBe(true);
        expect(edited.strips[3]).toEqual({ type: 'bus', width: 2, direction: 'forward' });
        expect(close(edited.strips.filter(s => s.type === 'driving').reduce((t, s) => t + s.width, 0), 5)).toBe(true);
    });

    it('refuses to insert a lane there is no room for', () => {
        expect(withLaneInserted(preset(), 3, { type: 'bus', width: 2 })).toEqual(expect.anything());
        expect(withLaneInserted(preset(), 3, { type: 'bus', width: 2.5 })).toBe(null); // lanes would drop below 2.5 m each
        expect(withLaneInserted(preset(), 3, { type: 'bus', width: 3 })).toBe(null);
        expect(withLaneInserted(preset(), 3, { type: 'helipad', width: 1 })).toBe(null);
    });

    it('removing a lane hands its width back to the traffic lanes', () => {
        const edited = withLaneRemoved(preset(), 2); // drop the parking
        expect(close(corridorProfileWidth(edited), TOTAL)).toBe(true);
        expect(edited.strips.filter(s => s.type === 'parking').length).toBe(1);
        expect(close(edited.strips.filter(s => s.type === 'driving').reduce((t, s) => t + s.width, 0), 9)).toBe(true);
    });

    it('removing the last traffic lane widens the neighbours instead of failing', () => {
        const pedestrian = { strips: [{ type: 'sidewalk', width: 3 }, { type: 'driving', width: 3, direction: 'forward' }, { type: 'sidewalk', width: 3 }] };
        const edited = withLaneRemoved(pedestrian, 1);
        expect(close(corridorProfileWidth(edited), 9)).toBe(true);
        expect(edited.strips.map(s => s.type)).toEqual(['sidewalk', 'sidewalk']);
        expect(edited.strips.every(s => s.width === 4.5)).toBe(true);
    });

    it('refuses to remove the only lane', () => {
        expect(withLaneRemoved({ strips: [{ type: 'driving', width: 3 }] }, 0)).toBe(null);
    });

    it('reordering is a permutation, so nothing changes but the order', () => {
        const edited = withLaneMoved(preset(), 2, 1); // parking swaps with the cycle path
        expect(close(corridorProfileWidth(edited), TOTAL)).toBe(true);
        expect(edited.strips.slice(0, 3).map(s => s.type)).toEqual(['sidewalk', 'parking', 'cycleway']);
    });

    it('a hundred edits do not drift the total by a millimetre', () => {
        // Rounding each lane independently would lose a fraction of a millimetre per edit, and the total
        // is the footprint — it has to come back exact however long the user plays with the sliders.
        let profile = preset();
        for (let i = 0; i < 100; i++) {
            const width = 1 + (i % 5) * 0.37;
            const next = withLaneWidth(profile, 0, width);
            if (next) profile = next;
        }
        expect(corridorProfileWidth(profile)).toBe(TOTAL);
    });

    // OSM's per-side schemes record a lane's presence and width, never its position in the sequence:
    // `cycleway:left` and `verge:left` cannot say which is nearer the kerb. So an edited profile comes
    // back with its lanes and its total intact, reordered into the canonical outside-in order.
    it('an edited profile round-trips through OSM tags, up to the canonical per-side order', () => {
        const edited = withLaneType(withLaneWidth(preset(), 0, 2.5), 2, 'verge');
        const back = corridorProfileFromOsmTags(corridorProfileToOsmTags(edited));
        expect(corridorProfileWidth(back)).toBe(corridorProfileWidth(edited));
        expect(back.strips.map(s => s.type).sort()).toEqual(edited.strips.map(s => s.type).sort());
        expect(back.strips.map(s => s.type)).toEqual(
            ['sidewalk', 'verge', 'cycleway', 'driving', 'driving', 'parking', 'cycleway', 'sidewalk']
        );
    });

    it('reordering lanes within a side is the one edit OSM tags cannot carry', () => {
        const swapped = withLaneMoved(preset(), 2, 1); // parking outside the cycle path
        const back = corridorProfileFromOsmTags(corridorProfileToOsmTags(swapped));
        expect(close(corridorProfileWidth(back), TOTAL)).toBe(true);
        expect(back.strips.slice(0, 3).map(s => s.type)).toEqual(['sidewalk', 'cycleway', 'parking']);
    });
});
