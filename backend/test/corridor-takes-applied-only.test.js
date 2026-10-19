// A corridor take is a STANDING corridor. The resolved-scope rematerializer hands
// _appliedCorridorTakes the draft's whole record listing; treating an unapplied road in that
// listing as a take left its pieces cut into the fabric after unapply (Šibenik, 2026-09-03).
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const road = (id, applied) => ({
    proposalId: id,
    goal: 'road-track',
    applied,
    roadProposal: { definition: { points: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }]] } }
});

describe('_appliedCorridorTakes', () => {
    const previousWindow = globalThis.window;
    afterEach(() => {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    });

    it('ignores unapplied corridors even when the caller passes the whole store listing', () => {
        globalThis.window = {
            __planOrder: {
                footprintOf: () => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } })
            }
        };
        const takes = ProposalManager._appliedCorridorTakes([road('standing', true), road('unapplied', false), road('never', undefined)]);
        expect(takes.map(take => take.id)).toEqual(['standing']);
    });
});
