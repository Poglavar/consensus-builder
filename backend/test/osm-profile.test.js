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
    osmProfileForSegment,
    railTracksForRun,
    insertRailStrips
} = require(path.join(here, '../../frontend/js/osm-profile.js'));
const {
    corridorProfileFromOsmTags, corridorProfileWidth, corridorStandardWidth
} = require(path.join(here, '../../frontend/js/corridor-profile.js'));

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

    // Zagreb has no contraflow cycle lanes: a one-way street never carries one on the left of its
    // traffic. It matters on a DUAL CARRIAGEWAY, where each carriageway is its own one-way run and both
    // sit in one corridor — so the hunt for the `separate` cycleway reaches across the median, finds the
    // other carriageway's lane, and Ulica grada Vukovara ends up with four of them, two facing each
    // other down the middle of the road.
    describe('a one-way street carries no cycle lane against its traffic', () => {
        const median = side => [{ kind: 'cycleway', side, offset: 14, coverage: 1, taggedWidth: NaN }];

        it('drops the one matched across the median of a one-way carriageway', () => {
            const { tags, notes } = resolveSegmentTags(
                { highway: 'secondary', oneway: 'yes', 'cycleway:right': 'separate' },
                [...median('left'), { kind: 'cycleway', side: 'right', offset: 6, coverage: 1, taggedWidth: NaN }], 40);
            expect(tags['cycleway:right'], 'its own lane, on the right of its traffic').toBe('lane');
            expect(tags['cycleway:left'], 'the other carriageway\'s, across the median').toBe('no');
            expect(notes.some(note => note.includes('one-way'))).toBe(true);
        });

        // 66 of Vukovarska's ways say nothing about cycleways at all, so the invention happens with no
        // cycleway tag in sight — the case above still has `cycleway:right`, this one has nothing.
        it('drops it on a carriageway whose tags mention no cycleway at all', () => {
            const { tags } = resolveSegmentTags(
                { highway: 'secondary', oneway: 'yes' },
                [...median('left'), { kind: 'cycleway', side: 'right', offset: 6, coverage: 1, taggedWidth: NaN }], 40);
            expect(tags['cycleway:right']).toBe('lane');
            expect(tags['cycleway:left']).toBe('no');
        });

        // Gundulićeva really is one-way with a lane each side — `cycleway:both:lane=exclusive`,
        // `cycleway:right:oneway=no`. A blanket rule would have deleted a real bike lane, so the rule
        // only bites where OSM said NOTHING about that side.
        it('never overrides a lane OSM states outright for that side', () => {
            // `cycleway:both=lane` needs no rewriting, so it must survive UNTOUCHED — the check is
            // that nothing wrote a `cycleway:left=no` over the top of it.
            const both = resolveSegmentTags({ highway: 'tertiary', oneway: 'yes', 'cycleway:both': 'lane' }, [], 16);
            expect(both.tags['cycleway:both']).toBe('lane');
            expect(both.tags['cycleway:left']).not.toBe('no');
            expect(types(corridorProfileFromOsmTags(both.tags)).filter(t => t === 'cycleway')).toHaveLength(2);

            const separate = resolveSegmentTags({ highway: 'tertiary', oneway: 'yes', 'cycleway:both': 'separate' },
                [{ kind: 'cycleway', side: 'left', offset: 5, coverage: 1, taggedWidth: NaN },
                    { kind: 'cycleway', side: 'right', offset: 5, coverage: 1, taggedWidth: NaN }], 16);
            expect(separate.tags['cycleway:left']).toBe('lane');
            expect(separate.tags['cycleway:right']).toBe('lane');
        });

        // oneway=-1 means the traffic runs against the run, so the right of TRAVEL is the run's LEFT.
        // Getting this backwards would throw away the real lane and keep the median one.
        it('reads the sides from the traffic, not from the run, when the way is drawn backwards', () => {
            const { tags } = resolveSegmentTags(
                { highway: 'secondary', oneway: '-1', 'cycleway:left': 'separate' },
                [...median('right'), { kind: 'cycleway', side: 'left', offset: 6, coverage: 1, taggedWidth: NaN }], 40);
            expect(tags['cycleway:left']).toBe('lane');
            expect(tags['cycleway:right']).toBe('no');
        });

        it('leaves a two-way street with lanes on both sides alone', () => {
            const { tags } = resolveSegmentTags(
                { highway: 'residential', 'cycleway:both': 'separate' },
                [{ kind: 'cycleway', side: 'left', offset: 5, coverage: 1, taggedWidth: NaN },
                    { kind: 'cycleway', side: 'right', offset: 5, coverage: 1, taggedWidth: NaN }], 16);
            expect(tags['cycleway:left']).toBe('lane');
            expect(tags['cycleway:right']).toBe('lane');
        });

        it('can be switched off for a city that really has contraflow lanes', () => {
            const { tags } = resolveSegmentTags({ highway: 'secondary', oneway: 'yes' },
                median('left'), 20, { contraflowCycleLanes: true });
            expect(tags['cycleway:left']).toBe('lane');
        });
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

// ---------------------------------------------------------------------------
// The room on each side of the street.
//
// A cadastral road parcel is often one side of the street rather than the whole of it, so the caller
// measures the two sides apart. Anything mapped beside the street has to be sized against the kerb on
// ITS side; against half the total, both pavements come out the same width whatever the ground says.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The tram in the street, and the room on each side of it.
//
// Zagreb has 463 tramway ways and not one of them carries a highway tag, so until they were let past
// the highway gate above, every tram median in the city — Vukovarska, Savska, Ilica — came out as
// ordinary carriageway. Below: a tramway is MATCHED, matched ways are resolved into TRACKS, and a
// track is PLACED where it actually lies. Then the other thing measured per side: a pavement mapped
// as its own way, sized against the kerb on ITS side rather than against half the total.
// ---------------------------------------------------------------------------

// A run heading north, so its left is at negative x and a positive offset is to the west.
const tramRun = (length = 200) => [[0, 0], [0, length]];
const road = (offset, tags = {}, length = 200) => ({
    pointsXY: [[offset, 1], [offset, length - 1]],
    properties: { osm_id: `road${offset}`, highway_type: 'secondary', name: 'Test boulevard', tags }
});
// A tramway: no highway class at all, which is the whole difficulty.
const tram = (offset, options = {}) => ({
    pointsXY: [[offset, options.from ?? 1], [offset, options.to ?? 199]],
    properties: {
        osm_id: options.id || `tram${offset}`,
        highway_type: null,
        railway_type: 'tram',
        tags: { railway: 'tram', gauge: String(options.gauge || 1000) }
    }
});

describe('matching a tramway to a run', () => {
    it('matches one, though it has no highway class to be matched by', () => {
        const match = matchWaysToRun(tramRun(), [road(0), tram(-3), tram(3)]);
        expect(match.rails.length, 'a tramway with no highway tag was skipped entirely').toBe(2);
        expect(match.rails.every(rail => rail.gauge === 1000)).toBe(true);
    });

    it('never lets one be the carrier while a road covers the run', () => {
        const match = matchWaysToRun(tramRun(), [road(0), tram(-3)]);
        expect(match.carriers.length).toBe(1);
        expect(match.carriers[0].highway).toBe('secondary');
    });

    // The offsets place the track, so they are signed — and taken at every station, including the
    // ones a flank's "must be clear of the carriageway" rule would throw away. A tram down the middle
    // of the street is exactly the case that rule rejects.
    it('measures them signed, and does not lose the one running down the middle', () => {
        const match = matchWaysToRun(tramRun(), [road(0), tram(1.2), tram(-1.2)]);
        expect(match.rails.length, 'a central track is inside flankMinOffset and must survive it').toBe(2);
        const offsets = match.rails.map(rail => rail.offset).sort((a, b) => a - b);
        expect(offsets[0]).toBeCloseTo(-1.2, 1);
        expect(offsets[1]).toBeCloseTo(1.2, 1);
    });

    // Every street a tram line CROSSES used to get that tram as a lane of its own. Nothing tested a
    // rail's direction: a carrier is scored on alignment and a flank on staying to one side, but a
    // rail was taken on distance alone. Real case: the Branimirova tram sits at 87 degrees to Ulica
    // Petra i Tome Erdodyja and covered 62% of its stations, so it was drawn straight down it.
    it('does not take a tramway that CROSSES the street for one running down it', () => {
        const crossing = {
            pointsXY: [[-40, 100], [40, 100]],   // dead across a run heading north
            properties: { osm_id: 'crossing', highway_type: null, railway_type: 'tram', tags: { railway: 'tram' } }
        };
        const match = matchWaysToRun(tramRun(), [road(0), crossing]);
        expect(match.rails, 'a tram at 90 degrees is not a lane of this street').toEqual([]);
    });

    // ...but a real line is never dead straight, so the test cannot be "exactly parallel".
    it('still takes one that runs along the street at a slight angle', () => {
        const drifting = {
            pointsXY: [[-3, 1], [-1, 199]],      // about 0.6 degrees off, as a mapped track really is
            properties: { osm_id: 'drifting', highway_type: null, railway_type: 'tram', tags: { railway: 'tram' } }
        };
        const match = matchWaysToRun(tramRun(), [road(0), drifting]);
        expect(match.rails.length).toBe(1);
    });

    it('leaves the ordinary flanks alone — a pavement is still a pavement', () => {
        const match = matchWaysToRun(tramRun(), [
            road(0),
            tram(-3),
            { pointsXY: [[7, 1], [7, 199]], properties: { highway_type: 'footway', tags: { footway: 'sidewalk' } } }
        ]);
        expect(match.flanks.map(flank => flank.kind)).toEqual(['sidewalk']);
        expect(match.rails.length).toBe(1);
    });
});

describe('resolving matched ways into tracks', () => {
    // The case that decides whether this works at all on real data: OSM splits a tramway at every
    // junction, so one track along a 200 m run is three ways covering a third of it each. Counting
    // ways would count the track three times; asking any one way to cover half the run would find
    // no track at all.
    it('reads one track split into three ways as ONE track', () => {
        const pieces = [
            tram(-3, { id: 'a', from: 0, to: 66 }),
            tram(-3, { id: 'b', from: 66, to: 133 }),
            tram(-3, { id: 'c', from: 133, to: 199 })
        ];
        const match = matchWaysToRun(tramRun(), [road(0), ...pieces]);
        expect(match.rails.length, 'three ways matched').toBe(3);
        const tracks = railTracksForRun(match.rails);
        expect(tracks.length, 'but they are one track').toBe(1);
        // A run heading north has its left to the west, so a way at x = -3 is 3 m to its LEFT.
        expect(tracks[0].offset).toBeCloseTo(3, 0);
    });

    it('reads a double track as two', () => {
        const match = matchWaysToRun(tramRun(), [road(0), tram(-2), tram(-5)]);
        const tracks = railTracksForRun(match.rails);
        expect(tracks.length).toBe(2);
        // Left to right, so the section can be built by walking them in order.
        expect(tracks[0].offset).toBeGreaterThan(tracks[1].offset);
    });

    it('ignores a tramway that merely brushes the run', () => {
        const crossing = { ...tram(-4, { from: 90, to: 100 }) };
        const match = matchWaysToRun(tramRun(), [road(0), crossing]);
        expect(railTracksForRun(match.rails)).toEqual([]);
    });

    // The fan of connecting curves at a tram junction: a handful of ways at slightly different
    // offsets, all covering the SAME short stretch of the run. Adding their coverages together made a
    // third track appear down the middle of Savska cesta and Draškovićeva; the stretch they cover
    // between them is what counts, and it is the one stretch they all sit on.
    it('does not build a track out of junction curves that all cover the same stretch', () => {
        const curves = [
            tram(-6, { id: 'curve-a', from: 0, to: 60 }),
            tram(-7.2, { id: 'curve-b', from: 4, to: 64 }),
            tram(-7.8, { id: 'curve-c', from: 8, to: 68 })
        ];
        const match = matchWaysToRun(tramRun(), [road(0), ...curves]);
        expect(match.rails.length, 'all three were matched').toBe(3);
        // Each covers about a third; summed that clears the bar, unioned it does not.
        expect(match.rails.reduce((total, rail) => total + rail.coverage, 0)).toBeGreaterThan(0.5);
        expect(railTracksForRun(match.rails)).toEqual([]);
    });

    it('does not invent a track where there is no tram', () => {
        const match = matchWaysToRun(tramRun(), [road(0)]);
        expect(match.rails).toEqual([]);
        expect(railTracksForRun(match.rails)).toEqual([]);
    });

    // A track has to lie IN the street. The only bound was flankMaxOffset, and 25 m is a question
    // about neighbours, not lanes — so the trams on the square next door, 11 and 14 m off the
    // centreline of the 12 m Ulica Marka Stančića, were drawn as two of its lanes.
    it('will not put a track outside the street it is meant to be a lane of', () => {
        const match = matchWaysToRun(tramRun(), [road(0), tram(-11), tram(-14)]);
        expect(match.rails.length, 'both were matched by the geometry').toBe(2);
        expect(railTracksForRun(match.rails, { availableWidth: 12 }),
            'a 12 m street reaches 6 m either side; neither track is in it').toEqual([]);
        // The same pair on a boulevard wide enough to hold them is a real reservation.
        expect(railTracksForRun(match.rails, { availableWidth: 40 })).toHaveLength(2);
    });

    // The section is drawn on the shifted centreline, so the bound has to be asked in that frame or a
    // track on the near side of an off-centre street is thrown away for being on the far side.
    it('measures that against the shifted centreline, where the section is actually drawn', () => {
        const match = matchWaysToRun(tramRun(), [road(0), tram(-9)]);
        expect(railTracksForRun(match.rails, { availableWidth: 12 })).toEqual([]);
        expect(railTracksForRun(match.rails, { availableWidth: 12, sectionShift: 5 }),
            'shifted 5 m, the track is 4 m off the section centre and inside it').toHaveLength(1);
    });

    // One junction curve running alongside for most of a short segment used to clear the old 50% bar
    // and add a phantom third track to Ulica kneza Branimira. A real track's cluster unions to nearly
    // the whole run however many ways it is split into, so a high bar costs it nothing.
    it('will not build a track from one way that runs alongside only part of the segment', () => {
        const partial = tram(-6, { id: 'curve', from: 0, to: 130 });   // 65% of the run
        const match = matchWaysToRun(tramRun(), [road(0), partial]);
        expect(match.rails[0].coverage).toBeGreaterThan(0.5);
        expect(match.rails[0].coverage).toBeLessThan(0.8);
        expect(railTracksForRun(match.rails)).toEqual([]);
    });
});

describe('putting the tracks in the section', () => {
    const boulevard = () => ({
        strips: [
            { type: 'sidewalk', width: 3 },
            { type: 'driving', width: 3.25 },
            { type: 'driving', width: 3.25 },
            { type: 'driving', width: 3.25 },
            { type: 'sidewalk', width: 3 }
        ]
    });

    it('puts a central pair between the carriageways, not at the kerb', () => {
        const out = insertRailStrips(boulevard(), [{ offset: 2.4, gauge: 1000 }, { offset: -2.4, gauge: 1000 }]);
        expect(types(out)).toEqual([
            'sidewalk', 'driving', 'rail', 'driving', 'rail', 'driving', 'sidewalk'
        ]);
    });

    it('puts a side-running pair on the side it runs', () => {
        const out = insertRailStrips(boulevard(), [{ offset: -6.2, gauge: 1000 }, { offset: -8.9, gauge: 1000 }]);
        const laid = types(out);
        expect(laid.filter(type => type === 'rail').length).toBe(2);
        // Right of every traffic lane, which is the side the offsets say.
        expect(laid.lastIndexOf('driving')).toBeLessThan(laid.indexOf('rail'));
    });

    // The painter draws a street in the middle of the corridor it measured, not on the line OSM drew.
    // A track placed without allowing for that is out by the whole shift — a lane and a half.
    it('places against the line the section will be DRAWN on', () => {
        const tracks = [{ offset: 2.4, gauge: 1000 }, { offset: -2.4, gauge: 1000 }];
        const straight = types(insertRailStrips(boulevard(), tracks, { sectionShift: 0 }));
        const shifted = types(insertRailStrips(boulevard(), tracks, { sectionShift: -5 }));
        expect(shifted).not.toEqual(straight);
        // Shifting the section to the right moves the tracks leftwards within it.
        expect(shifted.indexOf('rail')).toBeLessThan(straight.indexOf('rail'));
    });

    it('leaves a dedicated tram line alone — it is already all rails', () => {
        const track = { strips: [{ type: 'rail', width: 2.75 }, { type: 'rail', width: 2.75 }] };
        expect(insertRailStrips(track, [{ offset: 0, gauge: 1000 }]).strips.length).toBe(2);
    });

    // A track's width comes from corridor-profile.js when it is loaded and from a constant here when
    // it is not, so the two have to agree or a painted tram lane and an edited one differ by a lane.
    it('uses the same width for a metre-gauge track as the cross-section editor does', () => {
        const out = insertRailStrips(
            { strips: [{ type: 'driving', width: 3 }, { type: 'driving', width: 3 }] },
            [{ offset: 0, gauge: 1000 }]
        );
        const rail = out.strips.find(strip => strip.type === 'rail');
        expect(rail.width).toBe(corridorStandardWidth('rail', 1000));
        expect(rail.gauge).toBe(1000);
    });
});

describe('a boulevard with a tram, end to end', () => {
    const boulevardWays = () => [
        road(0, { highway: 'secondary', lanes: '3', oneway: 'yes', 'sidewalk:both': 'separate' }),
        tram(-8, { id: 'tram-a' }),
        tram(-11, { id: 'tram-b' })
    ];

    it('gives the street its rails, and the section still sums to exactly the width asked for', () => {
        const out = osmProfileForSegment({
            runXY: tramRun(), ways: boulevardWays(), availableWidth: 30,
            profileFromTags: corridorProfileFromOsmTags
        });
        expect(out).toBeTruthy();
        expect(out.tracks, 'the two tramways are one track each').toBe(2);
        expect(types(out.profile).filter(type => type === 'rail').length).toBe(2);
        expect(corridorProfileWidth(out.profile)).toBeCloseTo(out.width, 3);
        expect(out.notes.some(note => note.startsWith('tram:'))).toBe(true);
    });

    // The rails are part of the street's width, not a decoration over it: leave them out and the
    // metres they occupy are handed to the traffic instead.
    it('counts the rails as part of the street rather than widening the traffic lanes', () => {
        const withTram = osmProfileForSegment({
            runXY: tramRun(), ways: boulevardWays(), availableWidth: 30,
            profileFromTags: corridorProfileFromOsmTags, options: { preferNominal: true }
        });
        const without = osmProfileForSegment({
            runXY: tramRun(), ways: [boulevardWays()[0]], availableWidth: 30,
            profileFromTags: corridorProfileFromOsmTags, options: { preferNominal: true }
        });
        expect(withTram.width).toBeGreaterThan(without.width);
        expect(withTram.width - without.width).toBeCloseTo(2 * corridorStandardWidth('rail', 1000), 1);
    });

    it('says so when the tags claim embedded rails no tramway can be found for', () => {
        const out = osmProfileForSegment({
            runXY: tramRun(),
            ways: [road(0, { highway: 'secondary', lanes: '2', 'embedded_rails': 'tram' })],
            availableWidth: 20,
            profileFromTags: corridorProfileFromOsmTags
        });
        expect(out.tracks).toBe(0);
        expect(out.notes.some(note => note.includes('no tramway runs along this'))).toBe(true);
    });
});

describe('a pavement is measured against the room on its own side', () => {
    // A footway 5 m off the centreline, on a corridor that is 6 m wide one side and 14 m the other —
    // the ordinary shape of a cadastral road parcel that covers one side of the street.
    const separateTags = { highway: 'residential', lanes: '2', 'sidewalk:both': 'separate' };
    const footway = (offset) => ({
        pointsXY: [[offset, 1], [offset, 199]],
        properties: { highway_type: 'footway', tags: { footway: 'sidewalk' } }
    });

    // 14 m of corridor, 6 m of it left of the line and 8 m right. Kept under the 6 m a pavement is
    // capped at, so what is being read here is the measurement and not the clamp.
    const resolve = (options, total = 14) => {
        const match = matchWaysToRun(tramRun(), [road(0, separateTags), footway(5), footway(-5)]);
        return resolveSegmentTags(separateTags, match.flanks, total, options).tags;
    };

    it('sizes the two pavements differently when the two sides are different', () => {
        const tags = resolve({ leftHalf: 6, rightHalf: 8 });
        const left = Number(tags['sidewalk:left:width']);
        const right = Number(tags['sidewalk:right:width']);
        expect(left).toBeCloseTo(2 * (6 - 5), 1);      // 1 m of pavement outside the footway
        expect(right).toBeCloseTo(2 * (8 - 5), 1);
        expect(left).not.toBeCloseTo(right, 1);
    });

    it('falls back to half the total when the caller measured only one number', () => {
        const tags = resolve({});
        expect(Number(tags['sidewalk:left:width'])).toBeCloseTo(Number(tags['sidewalk:right:width']), 3);
        expect(Number(tags['sidewalk:left:width'])).toBeCloseTo(2 * (7 - 5), 1);
    });

    // A footway further out than the kerb on that side cannot be measuring that side's pavement, and
    // a negative width would be nonsense: it falls back to the default rather than to an absurdity.
    it('does not read a pavement wider than the side it is on', () => {
        const tags = resolve({ leftHalf: 3, rightHalf: 8 });
        expect(Number(tags['sidewalk:left:width'])).toBe(2);    // the default, not 2 x (3 - 5)
        expect(Number(tags['sidewalk:right:width'])).toBeCloseTo(6, 1);
    });
});
