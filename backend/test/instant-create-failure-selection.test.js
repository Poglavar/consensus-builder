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

function loadInstantCreate({ lands, reason = 'The live fabric could not be validated.', throws = false, replacement = false, publishedSource = null }) {
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
        getProposal: vi.fn(id => id === 'source-lake' && publishedSource ? publishedSource : proposal),
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
    install('isPublishedProposalRecord', require('../../frontend/js/proposal-supersession.js').isPublishedProposalRecord);
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
    it('reports draft validation failures and attempts to reopen the retained draft', async () => {
        const draft = { id: 'draft-retained', dirty: true };
        const error = new Error('local storage is unavailable');
        const showEphemeralMessage = vi.fn();
        const updateStatus = vi.fn();
        const openProposalDraftDesign = vi.fn(async () => true);
        install('proposalDraftStore', {
            getDraft: vi.fn(() => draft),
            resumeDraft: vi.fn(),
            validateDraft: vi.fn(() => { throw error; }),
            flush: vi.fn()
        });
        install('showEphemeralMessage', showEphemeralMessage);
        install('updateStatus', updateStatus);
        install('openProposalDraftDesign', openProposalDraftDesign);

        delete require.cache[shellPath];
        require(shellPath);
        globalThis.beginProposalDraftDesignSession(draft.id);

        expect(globalThis.finishProposalDraftDesignSession(draft.id)).toBeNull();
        await Promise.resolve();
        await Promise.resolve();
        expect(globalThis.activeProposalDesignDraftId).toBe(draft.id);
        expect(openProposalDraftDesign).toHaveBeenCalledWith(draft.id);
        expect(showEphemeralMessage).toHaveBeenCalledWith(
            expect.stringContaining('Your changes could not be saved (local storage is unavailable)'),
            7000,
            'error'
        );
        expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('local storage is unavailable'));
    });

    it('surfaces an unexpected async instant-create rejection and reopens its retained draft', async () => {
        const draft = {
            id: 'draft-async-failure',
            goal: 'park',
            adapterKey: 'park',
            proposalType: 'Park',
            fields: { name: 'Park', description: 'Park', offer: 1 }
        };
        const error = new Error('draft validation storage failed');
        const showEphemeralMessage = vi.fn();
        const updateStatus = vi.fn();
        const openProposalDraftDesign = vi.fn(async () => true);
        install('proposalDraftStore', {
            getDraft: vi.fn(() => draft),
            validateDraft: vi.fn(() => { throw error; })
        });
        install('showEphemeralMessage', showEphemeralMessage);
        install('updateStatus', updateStatus);
        install('openProposalDraftDesign', openProposalDraftDesign);

        delete require.cache[shellPath];
        require(shellPath);
        await expect(globalThis.instantCreateProposalFromDraft(draft.id)).resolves.toBeNull();
        await Promise.resolve();
        await Promise.resolve();

        expect(showEphemeralMessage).toHaveBeenCalledWith(
            'Your changes could not be saved (draft validation storage failed). Try again.',
            7000,
            'error'
        );
        expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('draft validation storage failed'));
        expect(openProposalDraftDesign).toHaveBeenCalledWith(draft.id);
    });

    it.each(['unexpected error', 'invalid draft'])('rearms commit-on-finish after an async %s so retry creates the object', async failureMode => {
        let draft = {
            id: 'draft-retry',
            goal: 'buildings',
            adapterKey: 'buildings',
            proposalType: 'Building',
            dirty: true,
            fields: { name: 'Building', description: 'Building', offer: 1, selectedParcelIds: [] },
            editorPayload: { typology: 'buildings' },
            previewGeometry: [],
            validation: { valid: true, errors: [] }
        };
        let validationCalls = 0;
        const proposal = { goal: 'buildings', applied: true, buildingProposal: { buildings: [] } };
        const addProposal = vi.fn(() => 'new-building');
        const deriveForNewProposal = vi.fn(async () => ({ applied: true }));
        const openProposalDraftDesign = vi.fn(async draftId => {
            globalThis.beginProposalDraftDesignSession(draftId);
            return true;
        });
        install('proposalDraftStore', {
            createDraft: vi.fn(() => draft),
            getDraft: vi.fn(() => draft),
            resumeDraft: vi.fn(),
            validateDraft: vi.fn(() => {
                validationCalls += 1;
                if (validationCalls === 2) {
                    if (failureMode === 'unexpected error') throw new Error('temporary validation failure');
                    return { ...draft, validation: { valid: false, errors: [{ message: 'temporary invalid draft' }] } };
                }
                return draft;
            }),
            flush: vi.fn(),
            buildProposalFromDraft: vi.fn(() => proposal),
            consumeAfterPublish: vi.fn(() => { draft = null; })
        });
        install('proposalStorage', {
            addProposal,
            getProposal: vi.fn(() => ({ ...proposal, proposalId: 'new-building', applied: true }))
        });
        install('ProposalManager', {
            deriveForNewProposal,
            _refreshUIAfterProposalChange: vi.fn()
        });
        install('isProposalApplied', value => value.applied === true);
        install('openProposalDraftDesign', openProposalDraftDesign);
        install('showEphemeralMessage', vi.fn());
        install('updateStatus', vi.fn());

        delete require.cache[shellPath];
        require(shellPath);
        await globalThis.startInstantSiteDesign('buildings', {
            site: { type: 'Polygon', coordinates: [[[1, 2], [2, 2], [1, 2]]] },
            toleranceM: 0,
            binding: null,
            selectionIds: []
        }, ['site:retry']);

        expect(globalThis.isProposalDesignCommitSession()).toBe(true);
        globalThis.finishProposalDraftDesignSession(draft.id);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(draft).toBeTruthy();
        expect(openProposalDraftDesign).toHaveBeenCalledTimes(2);
        expect(globalThis.isProposalDesignCommitSession()).toBe(true);
        expect(addProposal).not.toHaveBeenCalled();

        globalThis.finishProposalDraftDesignSession(draft.id);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(addProposal).toHaveBeenCalledOnce();
        expect(deriveForNewProposal).toHaveBeenCalledOnce();
        expect(draft).toBeNull();
        expect(globalThis.isProposalDesignCommitSession()).toBe(false);
    });

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

    it('reports missing structure geometry and a null site draft factory result', async () => {
        const showEphemeralMessage = vi.fn();
        const updateStatus = vi.fn();
        install('i18n', {
            t: key => ({
                'proposalDrafts.errors.structureGeometryFailed': 'Geometry could not be built from the selected parcels.',
                'proposalDrafts.design.draftCreateFailed': 'Could not save a local draft for this site design.'
            }[key] || key)
        });
        install('showEphemeralMessage', showEphemeralMessage);
        install('updateStatus', updateStatus);
        install('prepareProposalDraftParcelSelection', vi.fn(async () => ({
            ids: ['parcel-1'], layers: [{ feature: {} }], complete: true
        })));
        install('areParcelsContiguous', vi.fn(() => ({ contiguous: true })));
        install('buildGeometryFromParcels', vi.fn(() => null));
        install('proposalDraftStore', { createDraft: vi.fn(() => null) });

        delete require.cache[shellPath];
        require(shellPath);
        expect(await globalThis.instantCreateStructureFromSelection('park', ['parcel-1'])).toBeNull();
        expect(await globalThis.instantCreateStructureFromSite('square', {
            site: { type: 'Polygon', coordinates: [[[1, 2], [2, 2], [1, 2]]] },
            toleranceM: 0,
            binding: null
        })).toBeNull();

        expect(showEphemeralMessage).toHaveBeenNthCalledWith(
            1,
            'Your changes could not be saved (Geometry could not be built from the selected parcels). Try again.',
            7000,
            'error'
        );
        expect(showEphemeralMessage).toHaveBeenNthCalledWith(
            2,
            'Your changes could not be saved (Could not save a local draft for this site design). Try again.',
            7000,
            'error'
        );
        expect(updateStatus).toHaveBeenCalledTimes(2);
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

    it('derives a published-source geometry fork without releasing the applied source', async () => {
        const source = { proposalId: 'source-lake', goal: 'lake', lifecycleStatus: 'published', applied: true };
        const { proposal, ProposalManager } = loadInstantCreate({ lands: true, replacement: true, publishedSource: source });

        await globalThis.instantCreateProposalFromDraft('draft-park');

        expect(ProposalManager.deriveForNewProposal).toHaveBeenCalledWith(
            expect.objectContaining({ proposalId: proposal.proposalId }),
            { supersededIds: [] }
        );
        expect(source.applied).toBe(true);
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
