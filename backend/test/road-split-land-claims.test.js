// A road stretch split off its source must not carry the source's land claims beyond its own anchors.
//
// Deleting a middle section of a road disconnects it, and the remainder becomes a fresh record via
// makeFreshRoadSnapshot. That record's cadastreParcelIds shrink to the land its footprint reaches,
// but ownerAcceptances / acceptedParcelIds / ownershipFlow were cloned whole from the source — so the
// load boundary rejected it ("ownerAcceptances.HR-335550-1791/69 contains live parcel id …") and the
// whole edit reverted: sections of an applied road could not be removed at all.
//
// Runs the real makeFreshRoadSnapshot of the loaded road-drawing.js (helpers/road-drawing-env.js)
// over a live fabric holding both parcels and the real authored-record.js.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { loadRoadDrawing, boxRing } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const authored = require('../../frontend/js/proposals/authored-record.js');

const KEPT = 'HR-335550-1813/8';
const DROPPED = 'HR-335550-1791/69';

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// The fabric holds both parcels; the stretch's footprint (STRETCH_LAND) reaches KEPT only.
function loadSnapshot() {
    env = loadRoadDrawing({
        parcels: [
            { id: KEPT, ring: boxRing(0, -20, 50, 20) },
            { id: DROPPED, ring: boxRing(200, -20, 250, 20) }
        ],
        globals: { ProposalAuthoredRecord: authored }
    });
    return env.api.makeFreshRoadSnapshot;
}
const STRETCH_LAND = { type: 'Polygon', coordinates: [boxRing(10, -5, 40, 5)] };

const source = () => ({
    proposalId: 'upu-borovje-ulice',
    title: 'UPU Borovje – ulična mreža',
    goal: 'road-track',
    cadastreParcelIds: [KEPT, DROPPED],
    acceptedParcelIds: [KEPT, DROPPED],
    ownerAcceptances: {
        [KEPT]: { accepted: true, owner: 'agent_city' },
        [DROPPED]: { accepted: true, owner: 'agent_city' }
    },
    ownershipFlow: [{ parcelId: KEPT, to: 'agent_city' }, { parcelId: DROPPED, to: 'agent_city' }],
    roadProposal: { definition: { width: 19, points: [] } }
});

describe('split-off road stretch land claims', () => {
    it('keeps only claims on the land the stretch still reaches, so the record loads', () => {
        const stretch = loadSnapshot()(source(), { width: 19, points: [[]], polygon: STRETCH_LAND },
            { sourceProposalId: 'upu-borovje-ulice' });

        expect(stretch.cadastreParcelIds).toEqual([KEPT]);
        expect(stretch.acceptedParcelIds).toEqual([KEPT]);
        expect(Object.keys(stretch.ownerAcceptances)).toEqual([KEPT]);
        expect(stretch.ownershipFlow.map(entry => entry.parcelId)).toEqual([KEPT]);
        expect(stretch.sourceProposalId).toBe('upu-borovje-ulice');
        expect(stretch.applied).toBe(false);
        // The exact check that rejected the split before.
        expect(authored.findNonCadastralReference(stretch)).toBeNull();
    });

    it('leaves the source record untouched', () => {
        const original = source();
        loadSnapshot()(original, { width: 19, points: [[]], polygon: STRETCH_LAND }, {});
        expect(Object.keys(original.ownerAcceptances)).toEqual([KEPT, DROPPED]);
    });
});
