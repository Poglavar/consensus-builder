// The OSM -> cross-section translator for one adopted street segment.
//
// Two of the streets below are real: their geometry and their tags come straight out of the osm_road
// table for Zagreb's Donji Grad (backend/test/fixtures/osm-donji-grad.json), so the Zagreb conventions
// under test — sidewalks mapped as their own ways, bays parked half on the kerb — are the ones the
// translator will actually meet rather than ones invented here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
    matchWaysToRun,
    mergeTagsAlongRun,
    reverseOsmTagSides,
    resolveSegmentTags,
    fitProfileToWidth,
    orientForRightHandTraffic,
    osmProfileForSegment
} = require(path.join(here, '../../frontend/js/osm-profile.js'));
const { corridorProfileFromOsmTags, corridorProfileWidth } = require(path.join(here, '../../frontend/js/corridor-profile.js'));

const DONJI_GRAD = JSON.parse(readFileSync(path.join(here, 'fixtures/osm-donji-grad.json'), 'utf8'));

const close = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance;
const types = profile => profile.strips.map(strip => strip.type);
const widths = profile => profile.strips.map(strip => strip.width);
const street = block => DONJI_GRAD[block].ways.find(way => way.osm_id === DONJI_GRAD[block].streetId);
const ways = block => DONJI_GRAD[block].ways;

// A straight run and a way beside it, for the geometric tests that want exact numbers.
const straightRun = (length = 100) => [[0, 0], [0, length]];
const parallelWay = (offset, highway, tags = {}, length = 100) => ({
    pointsXY: [[offset, 2], [offset, length - 2]],
    properties: { highway_type: highway, tags }
});

describe('matchWaysToRun', () => {
    it('takes the driveable way the run lies on as the carrier, not the pavement beside it', () => {
        const match = matchWaysToRun(straightRun(), [
            parallelWay(6, 'footway', { footway: 'sidewalk' }),
            parallelWay(0.2, 'residential', { highway: 'residential' }),
            parallelWay(-6, 'footway', { footway: 'sidewalk' })
        ]);
        expect(match.carriers.length).toBe(1);
        expect(match.carriers[0].highway).toBe('residential');
        expect(match.flanks.map(flank => flank.side).sort()).toEqual(['left', 'right']);
        expect(match.flanks.every(flank => flank.kind === 'sidewalk')).toBe(true);
    });

    // x east, y north: a run heading north has its left to the west, i.e. at negative x.
    it('reads the side in the run\'s own frame, and the offset as the distance between centrelines', () => {
        const match = matchWaysToRun(straightRun(), [parallelWay(-7, 'footway', { footway: 'sidewalk' })]);
        expect(match.flanks.length).toBe(1);
        expect(match.flanks[0].side).toBe('left');
        expect(close(match.flanks[0].offset, 7, 0.05)).toBe(true);
    });

    it('notices when the run traverses its way backwards, which is what mirrors left and right', () => {
        const way = { pointsXY: [[0, 100], [0, 0]], properties: { highway_type: 'residential', tags: {} } };
        expect(matchWaysToRun(straightRun(), [way]).reversed).toBe(true);
        expect(matchWaysToRun([[0, 100], [0, 0]], [way]).reversed).toBe(false);
    });

    it('ignores a way that merely crosses the run', () => {
        const crossing = { pointsXY: [[-30, 50], [30, 50]], properties: { highway_type: 'footway', tags: {} } };
        const match = matchWaysToRun(straightRun(), [parallelWay(0.2, 'residential'), crossing]);
        expect(match.flanks.length).toBe(0);
    });

    it('takes a run with no driveable way as the footway it is', () => {
        const match = matchWaysToRun(straightRun(), [parallelWay(0.2, 'footway', { footway: 'sidewalk' })]);
        expect(match.carriers.length).toBe(1);
        expect(match.carriers[0].highway).toBe('footway');
    });

    // Which ways describe a segment is a question about the SEGMENT'S OWN AREA, not about a fixed
    // distance: 25 m drags in the parallel street beside a narrow lane and misses the pavement of a
    // boulevard. Given the segment's polygon, that is the test for a flank.
    it('counts as a flank only what lies inside the segment\'s own corridor', () => {
        const run = straightRun();
        const pavement = parallelWay(10, 'footway', { footway: 'sidewalk' });
        const ways = [parallelWay(0.2, 'residential'), pavement];
        // No polygon: the fixed reach lets in anything within 25 m.
        expect(matchWaysToRun(run, ways).flanks.length).toBe(1);

        // A narrow corridor, +-3 m: the pavement 10 m out belongs to something else.
        const narrow = [[-3, -10], [-3, 110], [3, 110], [3, -10], [-3, -10]];
        expect(matchWaysToRun(run, ways, { polygonXY: narrow }).flanks.length).toBe(0);

        // A wide one takes it back.
        const wide = [[-14, -10], [-14, 110], [14, 110], [14, -10], [-14, -10]];
        expect(matchWaysToRun(run, ways, { polygonXY: wide }).flanks.length).toBe(1);
    });

    // Never the carrier, though: a segment is MADE of its carrier, and a polygon drawn from a
    // mis-measured corridor would otherwise reject the very way the section comes from.
    it('never lets the polygon reject the way the segment is made of', () => {
        const run = straightRun();
        const ways = [parallelWay(0.2, 'residential')];
        const silly = [[100, 100], [100, 110], [110, 110], [110, 100], [100, 100]];
        expect(matchWaysToRun(run, ways, { polygonXY: silly }).carriers.length).toBe(1);
    });

    it('finds both of Gundulićeva\'s separately mapped pavements, one each side', () => {
        const match = matchWaysToRun(street('gundulic').pointsXY, ways('gundulic'));
        expect(match.carriers.map(carrier => carrier.way.osm_id)).toEqual([DONJI_GRAD.gundulic.streetId]);
        const sides = Object.fromEntries(match.flanks.map(flank => [flank.side, flank.offset]));
        expect(Object.keys(sides).sort()).toEqual(['left', 'right']);
        // The street is not centred in its corridor: 7.1 m to the western pavement, 5.8 m to the eastern.
        expect(sides.left > sides.right).toBe(true);
        expect(sides.left > 5 && sides.left < 9).toBe(true);
        expect(sides.right > 4 && sides.right < 8).toBe(true);
    });
});

describe('mergeTagsAlongRun', () => {
    it('takes, for each key, the value covering most of the run', () => {
        const tags = mergeTagsAlongRun([
            { coverage: 0.7, highway: 'residential', tags: { lanes: '2', surface: 'asphalt' } },
            { coverage: 0.3, highway: 'residential', tags: { lanes: '4' } }
        ]);
        expect(tags.lanes).toBe('2');
        expect(tags.surface).toBe('asphalt');
        expect(tags.highway).toBe('residential');
    });

    it('lets a key set by only one way through', () => {
        const tags = mergeTagsAlongRun([
            { coverage: 0.6, highway: 'residential', tags: {} },
            { coverage: 0.4, highway: 'residential', tags: { 'parking:right': 'lane' } }
        ]);
        expect(tags['parking:right']).toBe('lane');
    });
});

describe('reverseOsmTagSides', () => {
    it('swaps the sides, the direction of travel and the per-direction lane counts', () => {
        const flipped = reverseOsmTagSides({
            'sidewalk:left': 'yes', 'parking:right:orientation': 'diagonal', sidewalk: 'left',
            oneway: 'yes', 'lanes:forward': '3', 'lanes:backward': '1', lanes: '4'
        });
        expect(flipped['sidewalk:right']).toBe('yes');
        expect(flipped['sidewalk:left']).toBe(undefined);
        expect(flipped['parking:left:orientation']).toBe('diagonal');
        expect(flipped.sidewalk).toBe('right');
        expect(flipped.oneway).toBe('-1');
        expect(flipped['lanes:forward']).toBe('1');
        expect(flipped['lanes:backward']).toBe('3');
        expect(flipped.lanes).toBe('4');
    });

    it('leaves a key that merely contains the word alone', () => {
        expect(reverseOsmTagSides({ 'turn:lanes': 'left|through' })['turn:lanes']).toBe('left|through');
    });
});

// The heart of it: what Zagreb's tagging means on the ground.
describe('resolveSegmentTags', () => {
    it('measures a separately mapped pavement from how far off the centreline it runs', () => {
        // 16 m of corridor, so 8 m to the kerb line; a pavement centred 6.5 m out is 3 m of pavement.
        const flanks = [{ kind: 'sidewalk', side: 'left', offset: 6.5, coverage: 1, taggedWidth: NaN }];
        const { tags } = resolveSegmentTags({ highway: 'residential', 'sidewalk:both': 'separate' }, flanks, 16);
        expect(tags['sidewalk:left']).toBe('yes');
        expect(close(Number(tags['sidewalk:left:width']), 3)).toBe(true);
        // Nothing matched on the right: still a pavement, just at the default width.
        expect(tags['sidewalk:right']).toBe('yes');
        expect(close(Number(tags['sidewalk:right:width']), 2)).toBe(true);
    });

    it('keeps sidewalk=no meaning no sidewalk', () => {
        const { tags } = resolveSegmentTags({ highway: 'residential', 'sidewalk:both': 'no' }, [], 12);
        expect(tags['sidewalk:left']).toBe('no');
        expect(tags['sidewalk:right']).toBe('no');
    });

    it('drops a shared_lane cycleway, which is paint rather than a strip', () => {
        const { tags, notes } = resolveSegmentTags({ highway: 'residential', 'cycleway:both': 'shared_lane' }, [], 12);
        expect(tags['cycleway:left']).toBe('no');
        expect(tags['cycleway:right']).toBe('no');
        expect(notes.some(note => note.includes('shared_lane'))).toBe(true);
    });

    it('believes a separate cycleway only when one was found running beside the segment', () => {
        const withPath = resolveSegmentTags({ highway: 'residential', 'cycleway:both': 'separate' },
            [{ kind: 'cycleway', side: 'right', offset: 5, coverage: 1, taggedWidth: NaN }], 14);
        expect(withPath.tags['cycleway:right']).toBe('lane');
        expect(withPath.tags['cycleway:left']).toBe('no');
    });

    it('takes a kerb bay out of the pavement rather than out of the carriageway', () => {
        const flanks = [{ kind: 'sidewalk', side: 'left', offset: 4, coverage: 1, taggedWidth: NaN }];
        const onKerb = resolveSegmentTags({ highway: 'residential', 'parking:left': 'on_kerb', 'sidewalk:both': 'separate' }, flanks, 16);
        // Pavement measures 2 x (8 - 4) = 8 m, capped at 6, then gives the whole 2.5 m bay back.
        expect(close(Number(onKerb.tags['sidewalk:left:width']), 3.5)).toBe(true);
        expect(onKerb.tags['parking:left']).toBe('lane');
        expect(close(Number(onKerb.tags['parking:left:width']), 2.5)).toBe(true);

        const halfOn = resolveSegmentTags({ highway: 'residential', 'parking:left': 'half_on_kerb', 'sidewalk:both': 'separate' }, flanks, 16);
        expect(close(Number(halfOn.tags['sidewalk:left:width']), 4.75)).toBe(true);

        // A bay in the carriageway leaves the pavement alone.
        const inLane = resolveSegmentTags({ highway: 'residential', 'parking:left': 'lane', 'sidewalk:both': 'separate' }, flanks, 16);
        expect(close(Number(inLane.tags['sidewalk:left:width']), 6)).toBe(true);
    });

    it('sizes the bay by its orientation — a perpendicular bay is a car long', () => {
        const { tags } = resolveSegmentTags({
            highway: 'residential', 'parking:left': 'lane', 'parking:left:orientation': 'perpendicular'
        }, [], 20);
        expect(close(Number(tags['parking:left:width']), 5)).toBe(true);
    });

    it('never lets a tagged way width overrule the corridor the kerbs measure', () => {
        const { tags } = resolveSegmentTags({ highway: 'residential', width: '6' }, [], 18);
        expect(tags.width).toBe(undefined);
    });
});

describe('fitProfileToWidth', () => {
    const base = () => ({
        strips: [
            { type: 'sidewalk', width: 2 },
            { type: 'driving', width: 3, direction: 'backward' },
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'sidewalk', width: 2 }
        ]
    });

    it('always totals exactly the width it is given', () => {
        [4, 6, 7.5, 10, 12.4, 16, 25, 40].forEach(width => {
            const fitted = fitProfileToWidth(base(), width);
            expect(close(corridorProfileWidth(fitted), width, 0.002), `${width} m`).toBe(true);
        });
    });

    it('widens the lanes to a real lane first, then parks, then pays the rest to the pavements', () => {
        const fitted = fitProfileToWidth(base(), 16);
        expect(types(fitted)).toEqual(['sidewalk', 'parking', 'driving', 'driving', 'parking', 'sidewalk']);
        expect(fitted.strips.filter(strip => strip.type === 'driving').every(strip => strip.width === 3.5)).toBe(true);
        expect(close(corridorProfileWidth(fitted), 16)).toBe(true);
    });

    it('never makes a traffic lane wider than a traffic lane', () => {
        [12, 18, 25, 40].forEach(width => {
            const fitted = fitProfileToWidth(base(), width);
            fitted.strips.filter(strip => strip.type === 'driving')
                .forEach(strip => expect(strip.width <= 3.5 + 0.001, `${width} m -> ${strip.width} m lane`).toBe(true));
        });
    });

    // Found by running the translator over all 348 Donji Grad segments: a street tagged with no
    // pavement had nowhere to put the corridor's spare metres, and the carriageway took them — one
    // 18 m corridor came out as a single 13 m traffic lane.
    it('gives a street with no pavement one rather than a thirteen-metre traffic lane', () => {
        const bare = { strips: [{ type: 'driving', width: 2.75, direction: 'forward' }] };
        const fitted = fitProfileToWidth(bare, 18);
        expect(fitted.strips.filter(strip => strip.type === 'driving').every(strip => strip.width <= 3.5)).toBe(true);
        expect(fitted.strips.filter(strip => strip.type === 'sidewalk').length).toBe(2);
        expect(close(corridorProfileWidth(fitted), 18, 0.002)).toBe(true);
    });

    it('leaves a hand\'s width of slack in the carriageway rather than calling it a pavement', () => {
        const bare = { strips: [{ type: 'driving', width: 3, direction: 'forward' }] };
        const fitted = fitProfileToWidth(bare, 3.4);
        expect(types(fitted)).toEqual(['driving']);
    });

    it('does not invent parking on a street that says it has none', () => {
        const fitted = fitProfileToWidth(base(), 16, { allowParking: false });
        expect(types(fitted).includes('parking')).toBe(false);
        expect(close(corridorProfileWidth(fitted), 16)).toBe(true);
    });

    it('narrows the pavements before touching anything else', () => {
        const fitted = fitProfileToWidth(base(), 9);
        expect(types(fitted)).toEqual(['sidewalk', 'driving', 'driving', 'sidewalk']);
        expect(close(fitted.strips[0].width, 1.5)).toBe(true);
        expect(fitted.strips[1].width).toBe(3);
    });

    it('drops the furniture, then narrows the lanes, on a corridor too tight for both', () => {
        const rich = {
            strips: [
                { type: 'sidewalk', width: 2 }, { type: 'cycleway', width: 1.5, direction: 'backward' },
                { type: 'parking', width: 2.5 }, { type: 'driving', width: 3, direction: 'backward' },
                { type: 'driving', width: 3, direction: 'forward' }, { type: 'parking', width: 2.5 },
                { type: 'cycleway', width: 1.5, direction: 'forward' }, { type: 'sidewalk', width: 2 }
            ]
        };
        expect(types(fitFor(rich, 14))).toEqual(['sidewalk', 'cycleway', 'driving', 'driving', 'cycleway', 'sidewalk']);
        expect(types(fitFor(rich, 8))).toEqual(['sidewalk', 'driving', 'driving', 'sidewalk']);
        expect(close(corridorProfileWidth(fitFor(rich, 8)), 8)).toBe(true);
    });

    function fitFor(profile, width) {
        return fitProfileToWidth(profile, width);
    }

    it('gives a corridor narrower than one lane entirely to the carriageway', () => {
        const fitted = fitProfileToWidth(base(), 2.2);
        expect(types(fitted)).toEqual(['driving']);
        expect(close(corridorProfileWidth(fitted), 2.2)).toBe(true);
    });

    it('refuses a width that is not one', () => {
        expect(fitProfileToWidth(base(), 0)).toBe(null);
        expect(fitProfileToWidth(base(), NaN)).toBe(null);
    });
});

describe('orientForRightHandTraffic', () => {
    it('puts the forward lanes on the right half, where right-hand traffic drives', () => {
        const oriented = orientForRightHandTraffic({
            strips: [
                { type: 'driving', width: 3, direction: 'forward' },
                { type: 'driving', width: 3, direction: 'backward' }
            ]
        });
        expect(oriented.strips.map(strip => strip.direction)).toEqual(['backward', 'forward']);
    });

    it('leaves a one-way street one-way', () => {
        const oriented = orientForRightHandTraffic({
            strips: [
                { type: 'driving', width: 3, direction: 'forward' },
                { type: 'driving', width: 3, direction: 'forward' }
            ]
        });
        expect(oriented.strips.every(strip => strip.direction === 'forward')).toBe(true);
    });

    it('points a cycle lane the way the traffic beside it goes', () => {
        const oriented = orientForRightHandTraffic({
            strips: [
                { type: 'cycleway', width: 1.5, direction: 'forward' },
                { type: 'driving', width: 3, direction: 'forward' },
                { type: 'driving', width: 3, direction: 'backward' },
                { type: 'cycleway', width: 1.5, direction: 'backward' }
            ]
        });
        expect(oriented.strips.map(strip => strip.direction)).toEqual(['backward', 'backward', 'forward', 'forward']);
    });
});

describe('osmProfileForSegment on real Donji Grad streets', () => {
    const translate = (block, width, options) => osmProfileForSegment({
        runXY: street(block).pointsXY,
        ways: ways(block),
        availableWidth: width,
        options,
        profileFromTags: corridorProfileFromOsmTags
    });

    it('gives Gundulićeva the section it has: two lanes, a cycle lane each side, a pavement each side', () => {
        const result = translate('gundulic', 16);
        expect(result.source).toBe('osm-tags');
        expect(result.name).toBe('Gundulićeva ulica');
        expect(types(result.profile)).toEqual(['sidewalk', 'cycleway', 'driving', 'driving', 'cycleway', 'sidewalk']);
        expect(close(corridorProfileWidth(result.profile), 16, 0.002)).toBe(true);
        // One-way, so both lanes run the same way.
        expect(result.profile.strips.filter(strip => strip.type === 'driving')
            .every(strip => strip.direction === 'forward')).toBe(true);
        // The two pavements were MEASURED, and the street is not centred in its corridor.
        const pavements = result.profile.strips.filter(strip => strip.type === 'sidewalk').map(strip => strip.width);
        expect(pavements[0]).not.toBe(pavements[1]);
        expect(result.notes.some(note => note.startsWith('sidewalk'))).toBe(true);
    });

    it('gives Prilaz Gjure Deželića its perpendicular bays, one of them half on the pavement', () => {
        const result = translate('dezelica', 20);
        expect(types(result.profile)).toEqual([
            'sidewalk', 'parking_perpendicular', 'driving', 'driving', 'parking_perpendicular', 'sidewalk'
        ]);
        expect(close(corridorProfileWidth(result.profile), 20, 0.002)).toBe(true);
        // A perpendicular bay is a car long, not a car wide.
        result.profile.strips.filter(strip => strip.type === 'parking')
            .forEach(strip => expect(close(strip.width, 5)).toBe(true));
        expect(result.notes.some(note => note.includes('half_on_kerb'))).toBe(true);
        // cycleway:left=separate with no cycleway way beside it must not become a strip.
        expect(types(result.profile).includes('cycleway')).toBe(false);
    });

    it('totals exactly the corridor it is given, at every width a Zagreb street comes in', () => {
        ['gundulic', 'dezelica'].forEach(block => {
            [6, 8, 10, 12, 14, 16, 18, 22, 28].forEach(width => {
                const result = translate(block, width);
                expect(close(corridorProfileWidth(result.profile), width, 0.002), `${block} @ ${width} m`).toBe(true);
                result.profile.strips.filter(strip => strip.type === 'driving').forEach(strip => {
                    expect(strip.width <= 3.5 + 0.001, `${block} @ ${width} m -> ${strip.width} m lane`).toBe(true);
                });
            });
        });
    });

    it('reads the same section whichever way round the run is traversed', () => {
        const forward = translate('gundulic', 16);
        const backward = osmProfileForSegment({
            runXY: street('gundulic').pointsXY.slice().reverse(),
            ways: ways('gundulic'),
            availableWidth: 16,
            profileFromTags: corridorProfileFromOsmTags
        });
        expect(backward.reversed).toBe(true);
        // Same street, so the same lanes — mirrored, because the run now looks the other way. The
        // widths are within a centimetre rather than identical: the stations land in different places
        // along a reversed run, so a measured pavement is re-measured from slightly different samples.
        expect(types(backward.profile)).toEqual(types(forward.profile).slice().reverse());
        widths(forward.profile).slice().reverse().forEach((width, index) => {
            expect(close(widths(backward.profile)[index], width, 0.01), `strip ${index}`).toBe(true);
        });
    });

    it('says nothing at all when no OSM way covers the run, so the caller can fall back', () => {
        expect(osmProfileForSegment({
            runXY: [[5000, 5000], [5000, 5100]],
            ways: ways('gundulic'),
            availableWidth: 12,
            profileFromTags: corridorProfileFromOsmTags
        })).toBe(null);
        expect(osmProfileForSegment({ runXY: straightRun(), ways: [], availableWidth: 12 })).toBe(null);
    });
});
