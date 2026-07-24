// Unit tests for ProposalManager's synthetic descendant-id composition, the uncut-remainder guard,
// and the apply-failure metadata store. All pure — no map, no DOM, no turf.
//
// These used to live in e2e/tests/proposal-synthetic-regressions.spec.ts and
// e2e/tests/proposals-dependency-failures.spec.ts, which booted Chromium to concatenate strings.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    ProposalManager,
    _reapplyAppliedProposal,
    _shouldSkipUncutRemainder,
    _shouldDrawLegacyRoadCenterline
} = require('../../frontend/js/proposal-manager.js');
const {
    _buildSyntheticToken,
    _composeSyntheticParcelId,
    _composeSyntheticParcelNumber
} = require('../../frontend/js/proposal-parcel-identity.js');

describe('synthetic descendant id composition', () => {
    it('strips an inherited synthetic suffix so ids never nest', () => {
        // A re-split of an already-split parcel must key off the CADASTRAL root, not the slice id.
        expect(_composeSyntheticParcelId('HR-335649-371/1#p-1ov46hnuoy5-10', 'p-21bi0202nac', 1))
            .toBe('HR-335649-371/1#p-21bi0202nac-1');
        expect(_composeSyntheticParcelNumber('371#p-1ov46hnuoy5-10', 'p-21bi0202nac', 1))
            .toBe('371#p-21bi0202nac-1');
    });

    it('composes straight from a clean root', () => {
        expect(_composeSyntheticParcelId('HR-335649-371/1', 'p-abc', 2)).toBe('HR-335649-371/1#p-abc-2');
        expect(_composeSyntheticParcelNumber('371', 'p-abc', 2)).toBe('371#p-abc-2');
    });

    it('defaults a missing or non-numeric index to 1', () => {
        expect(_composeSyntheticParcelId('HR-1', 'p-abc')).toBe('HR-1#p-abc-1');
        expect(_composeSyntheticParcelId('HR-1', 'p-abc', 0)).toBe('HR-1#p-abc-1');
    });

    it('drops the root prefix entirely when there is no usable root', () => {
        expect(_composeSyntheticParcelId(null, 'p-abc', 3)).toBe('p-abc-3');
        expect(_composeSyntheticParcelNumber('   ', 'p-abc', 3)).toBe('p-abc-3');
    });

    it('sanitises the token so it cannot collide with the # delimiter', () => {
        expect(_buildSyntheticToken('p-a#b c!')).toBe('p-abc');
        expect(_buildSyntheticToken('')).toBe('proposal');
        expect(_buildSyntheticToken('###')).toBe('proposal');
    });
});

describe('ProposalManager._assignSyntheticChildIdentities', () => {
    const featureWithSyntheticParent = () => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
        properties: {
            parentParcelId: 'HR-335649-371/1#p-1ov46hnuoy5-10',
            parentParcelNumber: '371#p-1ov46hnuoy5-10'
        }
    });

    it('assigns canonical ids derived from the cadastral root of a synthetic parent', () => {
        const feature = featureWithSyntheticParent();
        ProposalManager._assignSyntheticChildIdentities('p-21bi0202nac', [feature]);

        expect(feature.properties.parcelId).toBe('HR-335649-371/1#p-21bi0202nac-1');
        expect(feature.properties.BROJ_CESTICE).toBe('371#p-21bi0202nac-1');
        expect(feature.properties.rootParcelId).toBe('HR-335649-371/1');
        expect(feature.properties.rootParcelNumber).toBe('371');
    });

    it('numbers siblings of the same root 1..n', () => {
        const features = [featureWithSyntheticParent(), featureWithSyntheticParent()];
        ProposalManager._assignSyntheticChildIdentities('p-tok', features);

        expect(features.map(f => f.properties.parcelId)).toEqual([
            'HR-335649-371/1#p-tok-1',
            'HR-335649-371/1#p-tok-2'
        ]);
        expect(features.map(f => f.properties.syntheticIndex)).toEqual([1, 2]);
    });

    it('keeps a separate counter per root parcel', () => {
        const of = (rootId, rootNumber) => ({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
            properties: { rootParcelId: rootId, rootParcelNumber: rootNumber }
        });
        const features = [of('HR-1', '1'), of('HR-2', '2'), of('HR-1', '1')];
        ProposalManager._assignSyntheticChildIdentities('p-tok', features);

        expect(features.map(f => f.properties.parcelId)).toEqual([
            'HR-1#p-tok-1',
            'HR-2#p-tok-1',
            'HR-1#p-tok-2'
        ]);
    });

    it('is a no-op for a missing proposal id or a non-array', () => {
        const feature = featureWithSyntheticParent();
        ProposalManager._assignSyntheticChildIdentities('', [feature]);
        expect(feature.properties.parcelId).toBeUndefined();
        expect(() => ProposalManager._assignSyntheticChildIdentities('p-tok', null)).not.toThrow();
    });
});

describe('_shouldSkipUncutRemainder', () => {
    // A road corridor that misses a listed parent leaves turf.difference returning the WHOLE parent.
    // Without this guard that became a "ghost split" — a synthetic descendant with parent geometry.
    it('skips a piece that is (essentially) the whole parent', () => {
        expect(_shouldSkipUncutRemainder(1000, 1000)).toBe(true);
        expect(_shouldSkipUncutRemainder(1000, 999.95)).toBe(true);
    });

    it('keeps a real cut, even a small one on a large parcel', () => {
        // ~111 m² removed from a ~267,000 m² parcel: a genuine clip, not a no-intersection artefact.
        expect(_shouldSkipUncutRemainder(267277.4099292392, 267166.3595310262)).toBe(false);
    });

    it('scales its tolerance with the parent, so a ~1 m² cut on a small parcel is kept', () => {
        expect(_shouldSkipUncutRemainder(500, 499)).toBe(false);
    });
});

describe('_shouldDrawLegacyRoadCenterline', () => {
    it('keeps the compatibility centreline for a plain legacy road proposal', () => {
        expect(_shouldDrawLegacyRoadCenterline(
            { properties: { isRoad: true } },
            { roadProposal: { definition: { points: [[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]] } } }
        )).toBe(true);
    });

    it('does not draw a second centreline over a canonical corridor', () => {
        expect(_shouldDrawLegacyRoadCenterline(
            { properties: { isRoad: true, isCorridor: true } },
            { roadProposal: { definition: { metadata: { isCorridor: true } } } }
        )).toBe(false);
    });

    it('recognises a corridor from its definition when an old child feature omitted the flag', () => {
        expect(_shouldDrawLegacyRoadCenterline(
            { properties: { isRoad: true } },
            { roadProposal: { definition: { metadata: { isCorridor: true } } } }
        )).toBe(false);
    });
});

describe('applied structure rehydration', () => {
    it.each(['park', 'square', 'lake', 'station'])('reapplies a %s even though structures have no child parcels', async kind => {
        const original = ProposalManager._applyStructureProposal;
        const calls = [];
        ProposalManager._applyStructureProposal = async (proposalId, proposal) => {
            calls.push([proposalId, proposal]);
            return true;
        };
        const proposal = {
            proposalId: `p-${kind}`,
            goal: kind,
            applied: true,
            structureProposal: {
                kind,
                applied: true,
                parentParcelIds: [],
                childParcelIds: []
            }
        };

        try {
            await _reapplyAppliedProposal(proposal);
            expect(calls).toEqual([[`p-${kind}`, proposal]]);
        } finally {
            ProposalManager._applyStructureProposal = original;
        }
    });
});

describe('ProposalManager apply-failure metadata', () => {
    // A shared-plan retry must not depend on regex-matching translated human-facing text, so the
    // structured code/missingIds ride alongside the (already localised) message.
    const proposalId = 'dep-hr-test';
    const missingId = '371#p-1ov46hnuoy5-19';

    beforeEach(() => {
        ProposalManager._clearLastApplyFailure(proposalId);
    });

    it('stores the structured code and missing ids alongside the localised message', () => {
        const message = `Nije moguće primijeniti prijedlog zgrade, nedostaju prethodnici: ${missingId}`;
        ProposalManager._setLastApplyFailure(proposalId, {
            code: 'dependency-missing',
            message,
            missingIds: [missingId]
        });

        expect(ProposalManager.getLastApplyFailure(proposalId)).toBe(message);
        const info = ProposalManager.getLastApplyFailureInfo(proposalId);
        expect(info.code).toBe('dependency-missing');
        expect(info.missingIds).toEqual([missingId]);
        expect(info.message).toBe(message);
    });

    it('de-duplicates missing ids and coerces them to strings', () => {
        ProposalManager._setLastApplyFailure(proposalId, {
            code: 'dependency-missing',
            message: 'missing parents',
            missingIds: [missingId, missingId, 42, null]
        });
        expect(ProposalManager.getLastApplyFailureInfo(proposalId).missingIds).toEqual([missingId, '42']);
    });

    it('accepts a bare string failure and defaults the code to null', () => {
        ProposalManager._setLastApplyFailure(proposalId, 'something broke');
        const info = ProposalManager.getLastApplyFailureInfo(proposalId);
        expect(info.message).toBe('something broke');
        expect(info.code).toBeNull();
        expect(info.missingIds).toEqual([]);
    });

    it('records nothing for an empty failure, and clears on request', () => {
        ProposalManager._setLastApplyFailure(proposalId, null);
        expect(ProposalManager.getLastApplyFailure(proposalId)).toBeNull();

        ProposalManager._setLastApplyFailure(proposalId, { message: 'boom' });
        expect(ProposalManager.getLastApplyFailure(proposalId)).toBe('boom');
        ProposalManager._clearLastApplyFailure(proposalId);
        expect(ProposalManager.getLastApplyFailure(proposalId)).toBeNull();
        expect(ProposalManager.getLastApplyFailureInfo(proposalId)).toBeNull();
    });
});
