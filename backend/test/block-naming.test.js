// What a block is called.
//
// Not after a parcel. A block is usually several parcels, so picking one of them is arbitrary — and
// the id of a parcel one of our own roads has cut carries a piece hash, which is how `#p1gynggs`
// ended up on the end of a name. A block has an identity of its own, the ground it encloses, and the
// name is read off that: `Block 4237-K7QM` — the area, and a code standing for that outline.
//
// It is DERIVED, not stamped or drawn: re-deriving the same block must give the same name, or a
// re-run quietly mints a second name for ground that already has one. That property is most of what
// is pinned here, including the accidents it must survive — the order the flood fill walked, which
// vertex a ring starts at, and which way round it winds.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');

// Metric rings (x east, y north), which is what collectParcels hands the namer.
const rect = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const parcel = (id, rings) => ({ id, rings });
const block = (parcelIds, areaM2) => ({ parcelIds, parcelCount: parcelIds.length, areaM2 });

// One 100 × 50 block of two parcels.
const WEST = parcel('HR-330264-5939#west', rect(0, 0, 50, 50));
const EAST = parcel('HR-330264-5939#east', rect(50, 0, 100, 50));
const byId = new Map([[WEST.id, WEST], [EAST.id, EAST]]);
const THE_BLOCK = block([WEST.id, EAST.id], 5000);

let batch;

beforeEach(() => {
    globalThis.turf = turf;
    globalThis.proposalStorage = { getAllProposals: () => [] };
    globalThis.__parcelArrangement = arrangement;
    batch = require('../../frontend/js/block-batch.js');
});

afterEach(() => {
    delete globalThis.turf;
    delete globalThis.proposalStorage;
    delete globalThis.__parcelArrangement;
});

describe('a block is named after itself', () => {
    it('reads as the area and a code for the outline', () => {
        expect(batch.blockBaseName(THE_BLOCK, byId)).toMatch(/^Block 5000-[2-9A-HJ-NP-Z]{4}$/);
    });

    it('mentions no parcel, and so can carry no piece hash', () => {
        const name = batch.blockBaseName(THE_BLOCK, byId);

        expect(name).not.toMatch(/#/);
        expect(name).not.toContain('5939');
        expect(name).not.toContain('HR-330264');
    });

    it('uses an alphabet that survives being read aloud', () => {
        // 0/O and 1/I/L are the pairs that get mistyped.
        const codes = new Set();
        for (let i = 0; i < 200; i += 1) {
            codes.add(batch.blockCode(`outline-${i}`));
        }
        expect(codes.size).toBeGreaterThan(150);
        codes.forEach(code => expect(code).not.toMatch(/[01OIL]/));
    });
});

describe('the same block gets the same name', () => {
    it('does not depend on the order the flood fill walked its parcels', () => {
        const forwards = batch.blockBaseName(block([WEST.id, EAST.id], 5000), byId);
        const backwards = batch.blockBaseName(block([EAST.id, WEST.id], 5000), byId);

        expect(backwards).toBe(forwards);
    });

    it('does not depend on where a ring starts or which way it winds', () => {
        // The same square, rotated to a different first vertex and wound the other way.
        const rotated = parcel(WEST.id, [[[50, 0], [50, 50], [0, 50], [0, 0], [50, 0]]]);
        const shuffled = new Map([[rotated.id, rotated], [EAST.id, EAST]]);

        expect(batch.blockBaseName(THE_BLOCK, shuffled)).toBe(batch.blockBaseName(THE_BLOCK, byId));
    });

    it('shrugs off drift below a centimetre', () => {
        const drifted = parcel(WEST.id, [[[0, 0], [50.000004, 0], [50, 50], [0, 50], [0, 0]]]);
        const nudged = new Map([[drifted.id, drifted], [EAST.id, EAST]]);

        expect(batch.blockBaseName(THE_BLOCK, nudged)).toBe(batch.blockBaseName(THE_BLOCK, byId));
    });

    it('is a different name for different ground', () => {
        const bigger = parcel(EAST.id, rect(50, 0, 140, 50));
        const other = new Map([[WEST.id, WEST], [bigger.id, bigger]]);

        // Move a road, take a parcel out, and it is a different block — which should say so.
        expect(batch.blockBaseName(block([WEST.id, EAST.id], 7000), other))
            .not.toBe(batch.blockBaseName(THE_BLOCK, byId));
    });
});

describe('a name an earlier run already used', () => {
    it('is stepped around rather than duplicated', () => {
        const first = batch.blockBaseName(THE_BLOCK, byId);
        const blocks = [block([WEST.id, EAST.id], 5000)];

        batch.nameBlocks(blocks, byId, new Set([first]));

        expect(blocks[0].name).toBe(`${first} (2)`);
    });

    it('leaves the plain name alone when nothing has claimed it', () => {
        const blocks = [block([WEST.id, EAST.id], 5000)];

        batch.nameBlocks(blocks, byId, new Set());

        expect(blocks[0].name).toBe(batch.blockBaseName(THE_BLOCK, byId));
    });
});
