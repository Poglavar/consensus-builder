// Detect block at Zagreb centre froze the page for over a minute and then threw
// "RangeError: Set maximum size exceeded". Two things were wrong at the source:
//
//   * parcel adjacency de-duplicated compared segment pairs in a Set holding EVERY pair it looked
//     at, and a Set cannot hold more than 2^24 entries;
//   * Detect block computed adjacency for its whole search area before flooding, and after three
//     widenings that area held ~80,000 parcels — for a block of a few dozen.
//
// Coordinates are METRES, as in the caller.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adjacency = require('../../frontend/js/parcels/parcel-adjacency.js');
const topology = require('../../frontend/js/parcels/block-topology.js');

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const parcel = (id, ...rings) => ({ id, rings });
const keyOf = pair => [pair.a, pair.b].sort().join('~');
const summary = pairs => pairs.map(pair => `${keyOf(pair)}=${pair.sharedM.toFixed(6)}`).sort();

// A square of side `size` centred on (cx, cy), turned by `angle`.
function rotatedSquare(id, cx, cy, size, angle) {
    const h = size / 2;
    const corners = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return parcel(id, corners.map(([x, y]) => [cx + (x * cos) - (y * sin), cy + (x * sin) + (y * cos)]));
}

describe('segment pairs are counted once without remembering every pair', () => {
    it('compares more than 2^24 segment pairs without a RangeError', () => {
        // 1,500 squares, each turned a little further, filed in ONE candidate cell: 6,000
        // segments and ~18 million pairs, more than a Set can hold. Two of them share an edge.
        const parcels = [];
        for (let i = 0; i < 1500; i += 1) {
            parcels.push(rotatedSquare(`P${i}`, (i % 40) * 30, Math.floor(i / 40) * 30, 10, 0.2 + (i * 0.001)));
        }
        parcels.push(parcel('EAST', rect(1205, -5, 1215, 5)));
        parcels.push(parcel('WEST', rect(1195, -5, 1205, 5)));
        expect(adjacency.segmentsOf(parcels).length ** 2 / 2).toBeGreaterThan(2 ** 24);

        const pairs = adjacency.neighborPairs(parcels, { candidateCellM: 1e7 });
        expect(pairs.map(keyOf)).toEqual(['EAST~WEST']);
        expect(pairs[0].sharedM).toBeCloseTo(10, 6);
    }, 60000);

    it('measures the same lengths whatever the cell size, so no pair is counted twice or lost', () => {
        const parcels = [
            parcel('A', rect(0, 0, 10, 60)),
            parcel('B', rect(10, 0, 20, 24)),
            parcel('C', rect(10, 24, 20, 60)),
            parcel('D', [[20, 0], [20, 13], [20, 37], [20, 60], [33, 60], [33, 0], [20, 0]])
        ];
        const reference = summary(adjacency.neighborPairs(parcels));
        expect(reference).toEqual(['A~B=24.000000', 'A~C=36.000000', 'B~C=10.000000', 'B~D=24.000000', 'C~D=36.000000']);
        [1, 3, 7, 1000].forEach(candidateCellM => {
            expect(summary(adjacency.neighborPairs(parcels, { candidateCellM }))).toEqual(reference);
        });
    });

    it('with focusId, returns exactly the focused parcel’s pairs', () => {
        const parcels = [
            parcel('A', rect(0, 0, 10, 10)),
            parcel('B', rect(10, 0, 20, 4)),
            parcel('C', rect(10, 4, 20, 10)),
            parcel('D', rect(20, 0, 30, 10))
        ];
        const all = summary(adjacency.neighborPairs(parcels));
        const focused = summary(adjacency.neighborPairs(parcels, { focusId: 'B' }));
        expect(focused).toEqual(all.filter(entry => entry.split('=')[0].split('~').includes('B')));
        expect(focused).toEqual(['A~B=4.000000', 'B~C=10.000000', 'B~D=4.000000']);
    });
});

// A city of 4x4-parcel blocks (10 m parcels) separated by 10 m road strips, with a simple
// spatial lookup standing in for the live fabric's queryBounds.
function city(blocksPerSide) {
    const parcels = new Map();
    const roads = new Map();
    const pitch = 50; // 40 m of block + 10 m of road
    for (let bx = 0; bx < blocksPerSide; bx += 1) {
        for (let by = 0; by < blocksPerSide; by += 1) {
            const x0 = bx * pitch;
            const y0 = by * pitch;
            for (let i = 0; i < 4; i += 1) {
                for (let j = 0; j < 4; j += 1) {
                    const id = `B${bx}.${by}-${i}${j}`;
                    parcels.set(id, parcel(id, rect(x0 + (i * 10), y0 + (j * 10), x0 + ((i + 1) * 10), y0 + ((j + 1) * 10))));
                }
            }
            roads.set(`R${bx}.${by}e`, parcel(`R${bx}.${by}e`, rect(x0 + 40, y0, x0 + 50, y0 + 50)));
            roads.set(`R${bx}.${by}n`, parcel(`R${bx}.${by}n`, rect(x0, y0 + 40, x0 + 40, y0 + 50)));
        }
    }
    const boundsOf = entry => {
        const xs = entry.rings[0].map(point => point[0]);
        const ys = entry.rings[0].map(point => point[1]);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const touching = (map, box, pad) => Array.from(map.values()).filter(entry => {
        const b = boundsOf(entry);
        return b[0] <= box[2] + pad && b[2] >= box[0] - pad && b[1] <= box[3] + pad && b[3] >= box[1] - pad;
    });
    const calls = [];
    const nearby = id => {
        calls.push(id);
        const target = parcels.get(id);
        const box = boundsOf(target);
        return {
            parcel: target,
            parcels: touching(parcels, box, 1).filter(entry => entry.id !== id),
            barriers: touching(roads, box, 1)
        };
    };
    return { parcels, roads, nearby, calls };
}

describe('a block grows from its seed, parcel by parcel', () => {
    it('finds the 16 parcels of the seed’s block and measures only them', () => {
        const ground = city(12); // 2,304 parcels
        const graph = topology.createNeighborGraph(ground.nearby);
        const inside = [];
        const grown = topology.growBlock({
            seedId: 'B5.5-11',
            neighborsOf: id => graph.neighborsOf(id).map(neighbour => neighbour.id),
            isInside: id => { inside.push(id); return true; }
        });
        expect(grown.isValid).toBe(true);
        expect(grown.ids.slice().sort()).toEqual(Array.from(ground.parcels.keys()).filter(id => id.startsWith('B5.5-')).sort());
        // The work follows the block: each member's surroundings are looked up once, nothing else.
        expect(ground.calls.slice().sort()).toEqual(grown.ids.slice().sort());
        expect(new Set(inside).size).toBe(16);
    });

    it('gives each parcel the same neighbours as adjacency over the whole ground', () => {
        const ground = city(2);
        const graph = topology.createNeighborGraph(ground.nearby);
        const whole = topology.neighborPairs(Array.from(ground.parcels.values()), Array.from(ground.roads.values()));
        const fromGraph = [];
        ground.parcels.forEach((_, id) => graph.neighborsOf(id).forEach(neighbour => {
            if (id < neighbour.id) fromGraph.push({ a: id, b: neighbour.id, sharedM: neighbour.sharedM });
        }));
        expect(summary(fromGraph)).toEqual(summary(whole));
        expect(whole.length).toBe(4 * 24); // 24 shared edges in each 4x4 block
    });

    it('stops at the first member that runs out of known ground, and names it', () => {
        const ground = city(3);
        const graph = topology.createNeighborGraph(ground.nearby);
        const neighborsOf = id => graph.neighborsOf(id).map(neighbour => neighbour.id);
        const grown = topology.growBlock({ seedId: 'B1.1-00', neighborsOf, isInside: id => id !== 'B1.1-33' });
        expect(grown.isValid).toBe(false);
        expect(grown.invalidId).toBe('B1.1-33');
        expect(grown.invalidReason).toBe('not_fully_visible');

        const seedOutside = topology.growBlock({ seedId: 'B1.1-00', neighborsOf, isInside: () => false });
        expect(seedOutside).toMatchObject({ isValid: false, invalidId: 'B1.1-00', invalidReason: 'start_not_fully_visible', ids: [] });
    });

    it('does not cross a road laid over a shared boundary', () => {
        const parcels = new Map([
            ['W', parcel('W', rect(0, 0, 10, 10))],
            ['E', parcel('E', rect(10, 0, 20, 10))]
        ]);
        const road = parcel('ROAD', rect(9, -1, 11, 11));
        const graph = topology.createNeighborGraph(id => ({
            parcel: parcels.get(id),
            parcels: Array.from(parcels.values()),
            barriers: [road]
        }));
        expect(graph.neighborsOf('W')).toEqual([]);
    });
});

describe('the corridor barrier index', () => {
    // The index answers from a grid of boundary edges; it must agree with the plain definition:
    // inside a barrier (even/odd over all rings, boundary included) or within clearance of one.
    const reference = (barriers, x, y, clearanceM) => barriers.some(barrier =>
        topology.barrierContains(barrier, x, y)
        || (clearanceM > 0 && topology.barrierBoundaryDistance(barrier, x, y) <= clearanceM));

    it('agrees with the definition on every point of a grid around roads with holes and jagged edges', () => {
        const zigzag = [];
        for (let i = 0; i <= 40; i += 1) zigzag.push([i * 2.5, 30 + ((i % 2) * 1.7)]);
        for (let i = 40; i >= 0; i -= 1) zigzag.push([i * 2.5, 38 + ((i % 3) * 0.9)]);
        zigzag.push(zigzag[0]);
        const barriers = [
            parcel('SQUARE-WITH-HOLE', rect(0, 0, 20, 20), rect(5, 5, 15, 15)),
            parcel('ZIGZAG', zigzag),
            parcel('DIAGONAL', [[40, 0], [70, 25], [72, 23], [42, -2], [40, 0]])
        ];
        [0, 0.5, 1.3].forEach(barrierClearanceM => {
            const index = topology.createBarrierIndex(barriers, { barrierClearanceM });
            let disagreements = 0;
            let insideCount = 0;
            for (let x = -3; x <= 103; x += 0.37) {
                for (let y = -4; y <= 45; y += 0.41) {
                    const expected = reference(barriers, x, y, barrierClearanceM);
                    if (expected) insideCount += 1;
                    if (index.contains(x, y) !== expected) disagreements += 1;
                }
            }
            expect(disagreements, `clearance ${barrierClearanceM}`).toBe(0);
            expect(insideCount).toBeGreaterThan(1000);
        });
    });

    it('counts a point exactly on a boundary as inside, even with no clearance', () => {
        const index = topology.createBarrierIndex([parcel('ROAD', rect(0, 0, 10, 10))], { barrierClearanceM: 0 });
        expect(index.contains(10, 5)).toBe(true);
        expect(index.contains(10.001, 5)).toBe(false);
    });
});

describe('the bounds index a flood fill looks its neighbours up in', () => {
    it('returns exactly the boxes a linear scan finds, for boxes of every size', () => {
        const entries = [];
        let seed = 7;
        const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < 2000; i += 1) {
            const x = random() * 0.05;
            const y = random() * 0.05;
            const w = random() < 0.05 ? random() * 0.02 : random() * 0.0004; // a few long roads
            const h = random() * 0.0004;
            entries.push({ id: `E${i}`, bounds: [x, y, x + w, y + h] });
        }
        const index = topology.createBoundsIndex(entries, 0.001);
        const scan = box => entries.filter(({ bounds: b }) => b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1])
            .map(entry => entry.id).sort();
        for (let i = 0; i < 300; i += 1) {
            const x = random() * 0.05;
            const y = random() * 0.05;
            const size = random() < 0.1 ? 0.01 : random() * 0.0005;
            const box = [x, y, x + size, y + size];
            expect(index.query(box).map(entry => entry.id).sort()).toEqual(scan(box));
        }
        // Boxes that only touch count as intersecting, as in the fabric's own bounds query.
        expect(topology.createBoundsIndex([{ id: 'A', bounds: [0, 0, 1, 1] }], 0.5).query([1, 1, 2, 2]).map(e => e.id)).toEqual(['A']);
    });
});
