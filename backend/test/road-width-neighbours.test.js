// A street's room ends where the next street's begins.
//
// One cadastral road parcel routinely holds a whole boulevard. Ulica grada Vukovara's is both
// carriageways, the tram median and both pavements — about 60 m — and measured against the parcel
// alone EACH carriageway claimed the lot: 50 to 72 m. The cross-section then had to spend that width,
// which it did on 36-40 m "pavements" that covered the other carriageway and the buildings past it.
//
// So a ray that reaches another street's centreline stops half way, and the two split what lies
// between them. These tests pin that, and the ladder change that follows from it: a corridor with
// more room than a street needs puts the rest in a verge rather than in an ever-wider footway.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { measureAvailableWidth, neighbourSegments } = require(path.join(here, '../../frontend/js/road-segmentation.js'));
const { fitProfileToWidth } = require(path.join(here, '../../frontend/js/osm-profile.js'));
const { corridorProfileWidth } = require(path.join(here, '../../frontend/js/corridor-profile.js'));

// A 60 m wide, 400 m long road parcel — a boulevard's parcel, in metres.
const BOULEVARD = [[-30, -50], [30, -50], [30, 450], [-30, 450], [-30, -50]];
// Its two carriageways, 20 m apart, running up the middle.
const WEST = [[-10, 0], [-10, 200], [-10, 400]];
const EAST = [[10, 0], [10, 200], [10, 400]];

const close = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

describe('measuring a run that shares its parcel with another street', () => {
    it('claims the whole parcel when it is told of no neighbours', () => {
        const measured = measureAvailableWidth(WEST, [BOULEVARD]);
        // 20 m to its own kerb line, 40 m to the far one: the tighter side doubled is 40 m.
        expect(close(measured.fitWidth, 40)).toBe(true);
    });

    it('stops half way to the neighbour once it knows about it', () => {
        const measured = measureAvailableWidth(WEST, [BOULEVARD], { neighbours: [EAST] });
        // 20 m to its own kerb line; 20 m to the other centreline, of which it may have half. The
        // tighter side is now the 10 m towards its neighbour, so the run fits 20 m, not 40.
        expect(close(measured.fitWidth, 20)).toBe(true);
        expect(close(measured.width, 30)).toBe(true);   // 20 m of parcel + 10 m of shared ground
    });

    // The point of halving: what the two claim must fit in what is there, or they overlap.
    it('leaves the two carriageways fitting inside the parcel rather than overlapping', () => {
        const west = measureAvailableWidth(WEST, [BOULEVARD], { neighbours: [EAST] });
        const east = measureAvailableWidth(EAST, [BOULEVARD], { neighbours: [WEST] });
        const gap = 20;   // between the two centrelines
        expect(west.fitWidth / 2 + east.fitWidth / 2).toBeLessThanOrEqual(gap + 0.001);
    });

    it('is unaffected by a neighbour that is nowhere near', () => {
        const alone = measureAvailableWidth(WEST, [BOULEVARD]);
        const far = measureAvailableWidth(WEST, [BOULEVARD], { neighbours: [[[500, 0], [500, 400]]] });
        expect(close(far.fitWidth, alone.fitWidth, 0.001)).toBe(true);
    });

    it('ignores a neighbour list that holds nothing usable', () => {
        const alone = measureAvailableWidth(WEST, [BOULEVARD]);
        [[], [null], [[[0, 0]]]].forEach(neighbours => {
            expect(close(measureAvailableWidth(WEST, [BOULEVARD], { neighbours }).fitWidth, alone.fitWidth, 0.001)).toBe(true);
        });
    });
});

// Which centrelines count as a run's neighbours. It has to be read off the WHOLE network, not off the
// runs of one parcel: a street's neighbours are usually in other parcels, and at a junction they
// always are — which is why a run reaching one spread its pavement across everything meeting there.
describe('finding the streets around a run', () => {
    // runsInsideRings hands back clipped COPIES, so the run's own parent is a different object with
    // the same geometry and has to be recognised as itself.
    const parent = [[-10, -100], [-10, 0], [-10, 200], [-10, 500]];
    const clippedRun = [[-10, 0], [-10, 200]];

    it('does not mistake the run\'s own parent segment for a neighbour', () => {
        expect(neighbourSegments(clippedRun, [parent])).toEqual([]);
    });

    it('finds the street running beside it, in whatever parcel that street lives', () => {
        const found = neighbourSegments(clippedRun, [parent, EAST]);
        expect(found).toEqual([EAST]);
    });

    it('finds a street that merely crosses it — a junction bounds a run too', () => {
        const crossing = [[-60, 100], [60, 100]];
        expect(neighbourSegments(clippedRun, [parent, crossing])).toEqual([crossing]);
    });

    it('ignores what is too far away to bound anything', () => {
        expect(neighbourSegments(clippedRun, [[[900, 0], [900, 400]]])).toEqual([]);
    });

    it('survives rubbish in the network', () => {
        expect(neighbourSegments(clippedRun, [null, [], [[0, 0]], undefined])).toEqual([]);
        expect(neighbourSegments([[0, 0]], [EAST])).toEqual([]);
        expect(neighbourSegments(clippedRun, null)).toEqual([]);
    });

    // The whole point, end to end: the parent must be excluded or the run measures zero width.
    it('leaves a run measurable — excluding the parent, bounded by the neighbour', () => {
        const neighbours = neighbourSegments(WEST, [WEST.slice(), EAST]);
        const measured = measureAvailableWidth(WEST, [BOULEVARD], { neighbours });
        expect(measured).not.toBe(null);
        expect(close(measured.fitWidth, 20)).toBe(true);
    });
});

describe('a corridor with more room than the street needs', () => {
    const twoLane = () => ({
        strips: [
            { type: 'sidewalk', width: 2 },
            { type: 'driving', width: 3, direction: 'backward' },
            { type: 'driving', width: 3, direction: 'forward' },
            { type: 'sidewalk', width: 2 }
        ]
    });

    it('puts the leftover in a verge instead of an ever-wider pavement', () => {
        const fitted = fitProfileToWidth(twoLane(), 40);
        const widest = Math.max(...fitted.strips.filter(s => s.type === 'sidewalk').map(s => s.width));
        expect(widest).toBeLessThanOrEqual(6.001);
        expect(fitted.strips.filter(s => s.type === 'verge').length).toBe(2);
        expect(close(corridorProfileWidth(fitted), 40, 0.002)).toBe(true);
    });

    it('still totals the corridor exactly, at every width', () => {
        [8, 12, 16, 20, 26, 34, 40, 60].forEach(width => {
            const fitted = fitProfileToWidth(twoLane(), width);
            expect(close(corridorProfileWidth(fitted), width, 0.002), `${width} m`).toBe(true);
            fitted.strips.filter(s => s.type === 'driving')
                .forEach(s => expect(s.width, `${width} m`).toBeLessThanOrEqual(3.501));
        });
    });

    it('leaves an ordinary street alone — no verge where there is no room going spare', () => {
        expect(fitProfileToWidth(twoLane(), 12).strips.some(s => s.type === 'verge')).toBe(false);
        expect(fitProfileToWidth(twoLane(), 16).strips.some(s => s.type === 'verge')).toBe(false);
    });
});
