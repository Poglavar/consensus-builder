// What counts as "this ground is already built on".
//
// Applying a building proposal rewrites its parentParcelIds to the CADASTRAL BASE ids, so a design
// on one piece of a cut parcel comes back recorded against the whole parcel. Deciding occupancy by
// widening a candidate's id to its parent then makes the first block to claim any piece of a parcel
// disqualify every other block that parcel reaches into — which is how a batch of 41 blocks created
// 15 and skipped 26 as "already built on".
//
// So occupancy is decided by where the buildings ARE. These tests pin that on two pieces of one
// cadastral parcel, separated by a road, with a building on only one of them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

// Two pieces of parcel HR-101, the road that cut them apart lying between.
const box = (w, s, e, n, props) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]], props);
const PIECE_A = box(15.8800, 43.7300, 15.8810, 43.7310, { parcelId: 'HR-101#a' });
const PIECE_B = box(15.8820, 43.7300, 15.8830, 43.7310, { parcelId: 'HR-101#b' });
const BUILDING_ON_A = box(15.8803, 43.7303, 15.8807, 43.7307);

function appliedBlockOnPieceA() {
    return {
        applied: true,
        // Exactly what apply/buildings.js leaves behind: the piece id it was authored on is gone,
        // replaced by the cadastral base id.
        parentParcelIds: ['HR-101'],
        buildingProposal: { parentParcelIds: ['HR-101'] },
        geometry: { buildings: [BUILDING_ON_A] }
    };
}

let batch;

beforeEach(() => {
    globalThis.turf = turf;
    globalThis.proposalStorage = { getAllProposals: () => [] };
    batch = require('../../frontend/js/block-batch.js');
});

afterEach(() => {
    delete globalThis.turf;
    delete globalThis.proposalStorage;
});

describe('a block knows it is empty even when its cadastral parent is built on', () => {
    it('reads the piece that carries the building as occupied', () => {
        globalThis.proposalStorage = { getAllProposals: () => [appliedBlockOnPieceA()] };

        const occupied = batch.occupancy();

        expect(batch.isPopulated(PIECE_A, 'HR-101#a', occupied)).toBe(true);
    });

    it('leaves the piece across the road free', () => {
        globalThis.proposalStorage = { getAllProposals: () => [appliedBlockOnPieceA()] };

        const occupied = batch.occupancy();

        // The whole point: same cadastral parent, no building on it, so it is still somewhere to
        // put one. Widening 'HR-101#b' to 'HR-101' to compare would answer true here.
        expect(batch.isPopulated(PIECE_B, 'HR-101#b', occupied)).toBe(false);
    });

    it('still recognises a design recorded against the parcel it actually names', () => {
        // An uncut parcel: the base id IS the parcel's id, so the exact-id path carries it even
        // before any footprint is consulted.
        globalThis.proposalStorage = {
            getAllProposals: () => [{
                applied: true,
                parentParcelIds: ['HR-102'],
                buildingProposal: { parentParcelIds: ['HR-102'] },
                geometry: { buildings: [] }
            }]
        };

        const occupied = batch.occupancy();

        expect(batch.isPopulated(box(15.9, 43.7, 15.901, 43.701), 'HR-102', occupied)).toBe(true);
    });

    it('ignores a proposal that is not applied', () => {
        globalThis.proposalStorage = {
            getAllProposals: () => [{ ...appliedBlockOnPieceA(), applied: false }]
        };

        const occupied = batch.occupancy();

        expect(occupied.marks).toHaveLength(0);
        expect(batch.isPopulated(PIECE_A, 'HR-101#a', occupied)).toBe(false);
    });

    it('takes the mark from inside the footprint, not from its centre of gravity', () => {
        // A courtyard block's centroid is in the courtyard, and a U is worse. pointOnFeature keeps
        // the mark on the building, so the parcel it lands in is the parcel it stands on.
        const courtyard = turf.polygon([
            [[15.8800, 43.7300], [15.8810, 43.7300], [15.8810, 43.7310], [15.8800, 43.7310], [15.8800, 43.7300]],
            [[15.8802, 43.7302], [15.8802, 43.7308], [15.8808, 43.7308], [15.8808, 43.7302], [15.8802, 43.7302]]
        ]);
        globalThis.proposalStorage = {
            getAllProposals: () => [{
                applied: true,
                parentParcelIds: ['HR-101'],
                buildingProposal: { parentParcelIds: ['HR-101'] },
                geometry: { buildings: [courtyard] }
            }]
        };

        const occupied = batch.occupancy();

        expect(occupied.marks).toHaveLength(1);
        expect(turf.booleanPointInPolygon(occupied.marks[0], courtyard)).toBe(true);
    });
});
