// A road stretch split off its source must not carry the source's land claims beyond its own anchors.
//
// Deleting a middle section of a road disconnects it, and the remainder becomes a fresh record via
// makeFreshRoadSnapshot. That record's cadastreParcelIds shrink to the land its footprint reaches,
// but ownerAcceptances / acceptedParcelIds / ownershipFlow were cloned whole from the source — so the
// load boundary rejected it ("ownerAcceptances.HR-335550-1791/69 contains live parcel id …") and the
// whole edit reverted: sections of an applied road could not be removed at all.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authored = require('../../frontend/js/proposals/authored-record.js');
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const roadSource = read('../../frontend/js/road-drawing.js');

function lift(name) {
    const start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
}

const KEPT = 'HR-335550-1813/8';
const DROPPED = 'HR-335550-1791/69';

// makeFreshRoadSnapshot with its fabric lookups stubbed: the stretch's footprint reaches KEPT only.
function loadSnapshot() {
    // eslint-disable-next-line no-new-func
    return new Function(
        'window', 'collectParcelsIntersectingFootprint', 'baseRoadParentHints', 'setProposalApplied',
        `${lift('cloneRoadValue')}; ${lift('writeRoadDefinition')}; ${lift('stripRoadDerivedFields')};
         ${lift('makeFreshRoadSnapshot')}; return makeFreshRoadSnapshot;`
    )(
        { ProposalAuthoredRecord: authored },
        () => [KEPT],
        ids => ids.slice(),
        (record, applied) => { record.applied = applied; }
    );
}

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
        const stretch = loadSnapshot()(source(), { width: 19, points: [[]], polygon: { type: 'Polygon' } },
            { sourceProposalId: 'upu-borovje-ulice' });

        expect(stretch.cadastreParcelIds).toEqual([KEPT]);
        expect(stretch.acceptedParcelIds).toEqual([KEPT]);
        expect(Object.keys(stretch.ownerAcceptances)).toEqual([KEPT]);
        expect(stretch.ownershipFlow.map(entry => entry.parcelId)).toEqual([KEPT]);
        // The exact check that rejected the split before.
        expect(authored.findNonCadastralReference(stretch)).toBeNull();
    });

    it('leaves the source record untouched', () => {
        const original = source();
        loadSnapshot()(original, { width: 19, points: [[]], polygon: { type: 'Polygon' } }, {});
        expect(Object.keys(original.ownerAcceptances)).toEqual([KEPT, DROPPED]);
    });
});
