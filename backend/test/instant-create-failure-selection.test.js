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

function loadInstantCreate({ lands, reason = 'The live fabric could not be validated.', throws = false, replacement = false }) {
    const draft = {
        id: 'draft-park',
        goal: 'park',
        adapterKey: 'park',
        proposalType: 'Park',
        fields: {
            name: 'Park whole block',
            description: 'Park whole block',
            offer: 100,
            selectedParcelIds: ['HR-330264-574', 'HR-330264-576', 'HR-330264-575', 'HR-330264-5940']
        },
        validation: { valid: true, errors: [] }
    };
    const proposal = {
        proposalId: 'local-park',
        goal: 'park',
        title: draft.fields.name,
        cadastreParcelIds: draft.fields.selectedParcelIds.slice(),
        applied: false
    };
    if (replacement) proposal.sourceProposalId = 'source-lake';
    const selectAndHighlightProposal = vi.fn();
    const showStyledAlert = vi.fn();
    const showEphemeralMessage = vi.fn();

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
    const ProposalManager = {
        _commitReplacementSupersession: vi.fn(),
        deriveForNewProposal: vi.fn(async () => {
            if (throws) throw new Error(reason || 'derive exploded');
            proposal.applied = lands;
            return lands ? { applied: true } : null;
        }),
        _refreshUIAfterProposalChange: vi.fn(),
        getLastApplyFailure: vi.fn(() => reason || null),
        getLastApplyFailureInfo: vi.fn(() => reason ? { message: reason, code: 'test-failure' } : null)
    };
    install('ProposalManager', ProposalManager);
    install('isProposalApplied', value => value.applied === true);
    install('selectAndHighlightProposal', selectAndHighlightProposal);
    install('showStyledAlert', showStyledAlert);
    install('showEphemeralMessage', showEphemeralMessage);
    install('updateShowProposalsButton', vi.fn());
    install('beginApplyIndicator', vi.fn());
    install('endApplyIndicator', vi.fn());

    delete require.cache[shellPath];
    require(shellPath);
    return { selectAndHighlightProposal, showStyledAlert, showEphemeralMessage, proposal, ProposalManager };
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
        expect(authored.fields.selectedParcelIds).toEqual([
            'HR-330264-574#live-a',
            'HR-330264-574#live-b'
        ]);
        expect(authored.editorPayload.structureProposal).not.toHaveProperty('selectedParcelIds');
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
        const { selectAndHighlightProposal, showStyledAlert, showEphemeralMessage, ProposalManager } = loadInstantCreate({ lands: false, replacement: true });

        const releaseEditorSeededMultiSelection = vi.fn();
        install('releaseEditorSeededMultiSelection', releaseEditorSeededMultiSelection);

        await globalThis.instantCreateProposalFromDraft('draft-park');

        expect(showStyledAlert).toHaveBeenCalledOnce();
        expect(showStyledAlert.mock.calls[0][0]).toContain('The live fabric could not be validated.');
        expect(showEphemeralMessage).not.toHaveBeenCalledWith('Geometry updated.', expect.anything(), 'success');
        expect(ProposalManager._commitReplacementSupersession).not.toHaveBeenCalled();
        expect(selectAndHighlightProposal).not.toHaveBeenCalled();
        expect(releaseEditorSeededMultiSelection).not.toHaveBeenCalled();
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

    it('shows a thrown placement reason and keeps replacement edits without a success toast', async () => {
        const { showStyledAlert, showEphemeralMessage, proposal, ProposalManager } = loadInstantCreate({
            lands: false, throws: true, replacement: true, reason: 'Lake geometry could not be derived.'
        });

        const result = await globalThis.instantCreateProposalFromDraft('draft-park');

        expect(result).toBe(proposal.proposalId);
        expect(showStyledAlert.mock.calls[0][0]).toContain('Lake geometry could not be derived.');
        expect(showEphemeralMessage).not.toHaveBeenCalledWith('Geometry updated.', expect.anything(), 'success');
        expect(ProposalManager._commitReplacementSupersession).not.toHaveBeenCalled();
    });

    it('announces a geometry edit only after replacement geometry lands', async () => {
        const { showStyledAlert, showEphemeralMessage, ProposalManager } = loadInstantCreate({ lands: true, replacement: true });

        await globalThis.instantCreateProposalFromDraft('draft-park');

        expect(showStyledAlert).not.toHaveBeenCalled();
        expect(showEphemeralMessage).toHaveBeenCalledWith('Geometry updated.', 4000, 'success');
        expect(ProposalManager._commitReplacementSupersession).not.toHaveBeenCalled();
    });

    it('releases the editor-seeded multi-select once the structure lands', async () => {
        // One-click structures have no design session to disarm the selection they seeded; the
        // selection tray used to stay on with nothing selected after a park was created.
        const { selectAndHighlightProposal } = loadInstantCreate({ lands: true });
        const releaseEditorSeededMultiSelection = vi.fn();
        install('releaseEditorSeededMultiSelection', releaseEditorSeededMultiSelection);

        await globalThis.instantCreateProposalFromDraft('draft-park');

        expect(releaseEditorSeededMultiSelection).toHaveBeenCalledOnce();
        expect(releaseEditorSeededMultiSelection.mock.invocationCallOrder[0])
            .toBeLessThan(selectAndHighlightProposal.mock.invocationCallOrder[0]);
    });
});
