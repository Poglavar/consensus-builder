// A failed one-click Park/Square/Lake is kept as a parked proposal, but it must not steal the
// parcel selection that authored it. Focusing the parked record selects its first parent; retrying
// then builds on only that fragment even though the user had selected a whole block.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shellPath = require.resolve('../../frontend/js/proposal-editor-shell.js');
const saved = new Map();

function install(name, value) {
    if (!saved.has(name)) {
        saved.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

function loadInstantCreate({ lands }) {
    const draft = {
        id: 'draft-park',
        goal: 'park',
        adapterKey: 'park',
        proposalType: 'Park',
        fields: {
            name: 'Park whole block',
            description: 'Park whole block',
            offer: 100,
            parentParcelIds: ['HR-330264-574', 'HR-330264-576', 'HR-330264-575', 'HR-330264-5940']
        },
        validation: { valid: true, errors: [] }
    };
    const proposal = {
        proposalId: 'local-park',
        goal: 'park',
        title: draft.fields.name,
        parentParcelIds: draft.fields.parentParcelIds.slice(),
        applied: false
    };
    const selectAndHighlightProposal = vi.fn();
    const showStyledAlert = vi.fn();

    install('proposalDraftStore', {
        getDraft: vi.fn(() => draft),
        validateDraft: vi.fn(() => draft),
        buildProposalFromDraft: vi.fn(() => proposal),
        consumeAfterPublish: vi.fn()
    });
    install('proposalStorage', {
        addProposal: vi.fn(() => proposal.proposalId),
        getProposal: vi.fn(() => proposal),
        save: vi.fn()
    });
    install('ProposalManager', {
        _commitReplacementSupersession: vi.fn(),
        deriveForNewProposal: vi.fn(async () => {
            proposal.applied = lands;
            return lands ? { applied: true } : null;
        }),
        _refreshUIAfterProposalChange: vi.fn(),
        getLastApplyFailure: vi.fn(() => 'The live fabric could not be validated.')
    });
    install('isProposalApplied', value => value.applied === true);
    install('selectAndHighlightProposal', selectAndHighlightProposal);
    install('showStyledAlert', showStyledAlert);
    install('updateShowProposalsButton', vi.fn());
    install('beginApplyIndicator', vi.fn());
    install('endApplyIndicator', vi.fn());

    delete require.cache[shellPath];
    require(shellPath);
    return { selectAndHighlightProposal, showStyledAlert, proposal };
}

beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    delete require.cache[shellPath];
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
    vi.restoreAllMocks();
});

describe('one-click structure creation focus', () => {
    it('authors the structure against the exact live ids returned by selection preparation', async () => {
        const createDraft = vi.fn(() => null);
        install('prepareProposalDraftParcelSelection', vi.fn(async () => ({
            ids: ['HR-330264-574#live-a', 'HR-330264-574#live-b'],
            layers: [{ feature: {} }, { feature: {} }],
            complete: true
        })));
        install('areParcelsContiguous', vi.fn(() => ({ contiguous: true })));
        install('buildGeometryFromParcels', vi.fn(() => ({
            type: 'Polygon',
            coordinates: [[[15.9, 43.7], [15.91, 43.7], [15.91, 43.71], [15.9, 43.7]]]
        })));
        install('proposalDraftStore', { createDraft });

        delete require.cache[shellPath];
        require(shellPath);
        await globalThis.instantCreateStructureFromSelection('park', [
            'HR-330264-574#live-a',
            'HR-330264-574#live-b'
        ]);

        expect(createDraft).toHaveBeenCalledOnce();
        const authored = createDraft.mock.calls[0][0];
        expect(authored.fields.parentParcelIds).toEqual([
            'HR-330264-574#live-a',
            'HR-330264-574#live-b'
        ]);
        expect(authored.editorPayload.structureProposal.parentParcelIds).toEqual(authored.fields.parentParcelIds);
    });

    it('refuses a disconnected live selection before building a proposal', async () => {
        const createDraft = vi.fn();
        const buildGeometryFromParcels = vi.fn();
        const showStyledAlert = vi.fn();
        install('prepareProposalDraftParcelSelection', vi.fn(async () => ({
            ids: ['west', 'east'],
            layers: [{ feature: { geometry: {} } }, { feature: { geometry: {} } }],
            complete: true
        })));
        install('areParcelsContiguous', vi.fn(() => ({ contiguous: false, components: 2 })));
        install('buildGeometryFromParcels', buildGeometryFromParcels);
        install('showStyledAlert', showStyledAlert);
        install('proposalDraftStore', { createDraft });

        delete require.cache[shellPath];
        require(shellPath);
        const result = await globalThis.instantCreateStructureFromSelection('square', ['west', 'east']);

        expect(result).toBeNull();
        expect(showStyledAlert).toHaveBeenCalledWith('The selected parcels must form one connected area.');
        expect(buildGeometryFromParcels).not.toHaveBeenCalled();
        expect(createDraft).not.toHaveBeenCalled();
    });

    it('refuses a union that still contains two polygon parts', async () => {
        const createDraft = vi.fn();
        const showStyledAlert = vi.fn();
        install('prepareProposalDraftParcelSelection', vi.fn(async () => ({
            ids: ['almost-touching-a', 'almost-touching-b'],
            layers: [{ feature: {} }, { feature: {} }],
            complete: true
        })));
        install('areParcelsContiguous', vi.fn(() => ({ contiguous: true, components: 2 })));
        install('buildGeometryFromParcels', vi.fn(() => ({
            type: 'MultiPolygon',
            coordinates: [
                [[[15.9, 43.7], [15.91, 43.7], [15.9, 43.7]]],
                [[[15.92, 43.7], [15.93, 43.7], [15.92, 43.7]]]
            ]
        })));
        install('showStyledAlert', showStyledAlert);
        install('proposalDraftStore', { createDraft });

        delete require.cache[shellPath];
        require(shellPath);
        const result = await globalThis.instantCreateStructureFromSelection('park', [
            'almost-touching-a',
            'almost-touching-b'
        ]);

        expect(result).toBeNull();
        expect(showStyledAlert).toHaveBeenCalledOnce();
        expect(createDraft).not.toHaveBeenCalled();
    });

    it('preserves the whole-block selection when placement is refused', async () => {
        const { selectAndHighlightProposal, showStyledAlert } = loadInstantCreate({ lands: false });

        await globalThis.instantCreateProposalFromDraft('draft-park');

        expect(showStyledAlert).toHaveBeenCalledOnce();
        expect(selectAndHighlightProposal).not.toHaveBeenCalled();
    });

    it('focuses a structure after it really lands', async () => {
        const { selectAndHighlightProposal, showStyledAlert, proposal } = loadInstantCreate({ lands: true });

        await globalThis.instantCreateProposalFromDraft('draft-park');

        expect(showStyledAlert).not.toHaveBeenCalled();
        expect(selectAndHighlightProposal).toHaveBeenCalledWith(
            proposal.proposalId,
            null,
            false,
            true
        );
    });
});
