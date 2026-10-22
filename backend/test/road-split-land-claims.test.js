// A road stretch split off its source must not carry the source's land claims beyond its own anchors.
//
// Deleting a middle section of a road disconnects it, and the remainder becomes a fresh record via
// makeFreshRoadSnapshot. That record's cadastreParcelIds shrink to the land its footprint reaches,
// but its ownershipFlow was cloned whole from the source — so the load boundary rejected it
// ("ownershipFlow[1].parcelId … contains live parcel id …") and the whole edit reverted: sections of
// an applied road could not be removed at all. (A design carries no acceptance tally since M2.)
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
    published: { cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq', publishedAt: '2026-10-21T10:00:00.000Z', apiBase: 'https://api.example.test' },
    ownershipFlow: [{ parcelId: KEPT, to: 'agent_city' }, { parcelId: DROPPED, to: 'agent_city' }],
    roadProposal: { definition: { width: 19, points: [] } }
});

describe('split-off road stretch land claims', () => {
    it('keeps only claims on the land the stretch still reaches, so the record loads', () => {
        const stretch = loadSnapshot()(source(), { width: 19, points: [[]], polygon: STRETCH_LAND },
            { sourceLocalProposalId: 'upu-borovje-ulice' });

        expect(stretch.cadastreParcelIds).toEqual([KEPT]);
        expect(stretch.ownershipFlow.map(entry => entry.parcelId)).toEqual([KEPT]);
        // A new record: none of the source's identity, its publication mark included (the only
        // published identity a design has, M3), and a CID link to the published source.
        expect(stretch).not.toHaveProperty('proposalId');
        expect(stretch).not.toHaveProperty('published');
        expect(stretch.origin).toEqual({ cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq' });
        // The published source is named by its CID, not by this browser's key for it.
        expect(stretch.proposalOrigin).toEqual({
            relation: 'revision', source: { kind: 'design', cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq' },
            title: 'UPU Borovje – ulična mreža'
        });
        expect(stretch.applied).toBe(false);
        // The exact check that rejected the split before.
        expect(authored.findNonCadastralReference(stretch)).toBeNull();
    });

    it('leaves the source record untouched', () => {
        const original = source();
        loadSnapshot()(original, { width: 19, points: [[]], polygon: STRETCH_LAND }, {});
        expect(original.ownershipFlow.map(entry => entry.parcelId)).toEqual([KEPT, DROPPED]);
        expect(original.published.cid).toBe('bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq');
    });
});
