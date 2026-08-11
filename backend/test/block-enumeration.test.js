// Every block on the map, where a block is the ground enclosed by roads.
//
// The button-driven detection calls a block complete when all its parcels are fully inside the
// VIEWPORT, which makes the answer depend on where the map is framed — fine for something you are
// looking at, useless as the basis for a batch. Here completeness is a property of the block: how
// much of its outline runs along a road. These tests pin that rule on a small synthetic town, in
// metres, with no map and no clipping.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enumerateBlocks } = require('../../frontend/js/proposals/block-enumeration.js');

// Axis-aligned rectangle as a closed ring of metric coordinates.
const rect = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const parcel = (id, rings, extra = {}) => ({
    id,
    rings,
    areaM2: Math.abs((rings[0][1][0] - rings[0][0][0]) * (rings[0][2][1] - rings[0][1][1])),
    isCorridor: false,
    populated: false,
    ...extra
});

// A 100 × 100 block of two parcels, ringed by four 10 m roads.
function town(extra = []) {
    return [
        parcel('P-1', rect(0, 0, 50, 100)),
        parcel('P-2', rect(50, 0, 100, 100)),
        parcel('R-S', rect(-10, -10, 110, 0), { isCorridor: true }),
        parcel('R-N', rect(-10, 100, 110, 110), { isCorridor: true }),
        parcel('R-W', rect(-10, 0, 0, 100), { isCorridor: true }),
        parcel('R-E', rect(100, 0, 110, 100), { isCorridor: true }),
        ...extra
    ];
}

describe('blocks are the ground enclosed by roads', () => {
    it('finds one block of both parcels, and calls it enclosed', () => {
        const { blocks } = enumerateBlocks(town());

        expect(blocks).toHaveLength(1);
        expect(blocks[0].parcelIds).toEqual(['P-1', 'P-2']);
        expect(blocks[0].areaM2).toBe(10000);
        // The outline is the 400 m ring, not the 600 m of both parcels' own perimeters: the
        // boundary they share is interior and counted from neither side.
        expect(blocks[0].outlineM).toBe(400);
        expect(blocks[0].enclosure).toBe(1);
        expect(blocks[0].enclosed).toBe(true);
    });

    it('does not let the flood fill cross a road', () => {
        // A second block on the far side of the eastern road. One road between them is the whole
        // difference between two blocks and one.
        const { blocks } = enumerateBlocks(town([
            parcel('Q-1', rect(110, 0, 160, 100)),
            parcel('R-E2', rect(160, 0, 170, 100), { isCorridor: true })
        ]));

        expect(blocks).toHaveLength(2);
        expect(blocks.map(block => block.parcelIds)).toEqual([['P-1', 'P-2'], ['Q-1']]);
    });

    it('refuses a block whose outline is not accounted for by roads', () => {
        // Take the northern road away: a quarter of the outline now faces nothing.
        const withoutNorth = town().filter(entry => entry.id !== 'R-N');
        const { blocks } = enumerateBlocks(withoutNorth);

        expect(blocks).toHaveLength(1);
        expect(blocks[0].enclosure).toBeCloseTo(0.75, 2);
        expect(blocks[0].enclosed).toBe(false);
    });

    it('tolerates a little missing contact — a junction corner is not an open side', () => {
        const { blocks } = enumerateBlocks(town(), { minEnclosure: 0.7 });
        expect(blocks[0].enclosed).toBe(true);

        const strict = enumerateBlocks(town().filter(entry => entry.id !== 'R-N'), { minEnclosure: 0.7 });
        expect(strict.blocks[0].enclosed).toBe(true);
    });

    it('marks a block populated when any of its parcels already carries a design', () => {
        const parcels = town();
        parcels.find(entry => entry.id === 'P-2').populated = true;

        const { blocks } = enumerateBlocks(parcels);

        expect(blocks[0].populated).toBe(true);
    });

    it('rejects a sliver as somewhere to put a building', () => {
        const sliver = [
            parcel('S-1', rect(0, 0, 4, 4)),
            parcel('R-S', rect(-10, -10, 20, 0), { isCorridor: true }),
            parcel('R-N', rect(-10, 4, 20, 14), { isCorridor: true }),
            parcel('R-W', rect(-10, 0, 0, 4), { isCorridor: true }),
            parcel('R-E', rect(4, 0, 14, 4), { isCorridor: true })
        ];
        const { blocks } = enumerateBlocks(sliver);

        expect(blocks[0].enclosure).toBe(1);
        expect(blocks[0].areaM2).toBe(16);
        expect(blocks[0].enclosed).toBe(false);
    });

    it('says nothing at all when there are no parcels', () => {
        expect(enumerateBlocks([]).blocks).toEqual([]);
        expect(enumerateBlocks(null).blocks).toEqual([]);
    });
});
