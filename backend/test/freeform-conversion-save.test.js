// "Convert to freeform building" on a saved Block (proposal-editor-shell.js convertProposalToFreeform):
// the stored massing becomes one Freeform building in a draft that saves by the ordinary edit rule —
// one's own local record in place, a published one as a Freeform counterproposal — and a Block whose
// buildings do not touch is refused before anything is saved. Runs the real shell over stubbed stores.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shellPath = require.resolve('../../frontend/js/proposal-editor-shell.js');
const saved = new Map();

function install(name, value) {
    if (!saved.has(name)) saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    globalThis[name] = value;
}

const box = (west, south, east, north) => ({
    type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});
const D = 0.0002;

function block(extra = {}, buildings = [{ type: 'Feature', properties: { height: 15 }, geometry: box(16, 45, 16 + 3 * D, 45 + D) }]) {
    return {
        proposalId: 'own-block', goal: 'buildings', typologyType: 'block', title: 'Courtyard block', applied: true,
        cadastreParcelIds: ['HR-1', 'HR-2'], createdAt: '2026-10-01T10:00:00.000Z',
        buildingProposal: { typologyType: 'block', parameters: { mode: 'parametric', typology: 'block', setback: 2 } },
        geometry: { buildings, blockMassing: buildings[0] },
        ...extra
    };
}

function loadShell(source) {
    const drafts = new Map();
    const store = {
        createDraftFromProposal: vi.fn(proposal => {
            const draft = {
                id: 'conversion-draft', sourceProposalId: proposal.proposalId, sourceSnapshot: proposal,
                adapterKey: 'buildings', goal: 'buildings', fields: { name: proposal.title },
                editorPayload: { typology: 'block', context: { blockName: 'Block 7', parameters: { mode: 'parametric', setback: 2, typology: 'block' } } },
                validation: { valid: true, errors: [] }
            };
            drafts.set(draft.id, draft);
            return draft;
        }),
        updateDraft: vi.fn((id, patch) => {
            const draft = drafts.get(id);
            // As proposal-drafts.js does: an updater replaces, a patch object is merged deeply.
            const plain = value => value && typeof value === 'object' && !Array.isArray(value);
            const merge = (base, extra) => {
                const out = JSON.parse(JSON.stringify(base));
                Object.keys(extra).forEach(key => { out[key] = plain(out[key]) && plain(extra[key]) ? merge(out[key], extra[key]) : JSON.parse(JSON.stringify(extra[key])); });
                return out;
            };
            const next = typeof patch === 'function' ? patch(JSON.parse(JSON.stringify(draft))) : merge(draft, patch);
            Object.keys(draft).forEach(key => delete draft[key]);
            Object.assign(draft, next);
            return draft;
        }),
        getDraft: id => drafts.get(id) || null,
        validateDraft: id => drafts.get(id),
        deleteDraft: vi.fn(id => drafts.delete(id)),
        buildProposalFromDraft: vi.fn(id => ({ goal: drafts.get(id).goal, title: source.title, editorPayload: drafts.get(id).editorPayload })),
        consumeAfterPublish: vi.fn()
    };
    install('proposalDraftStore', store);
    install('proposalStorage', {
        getProposal: id => (String(id) === source.proposalId ? source : null),
        addProposal: vi.fn(() => 'fork-1'),
        save: vi.fn()
    });
    install('getProposalByIdOrHash', id => (String(id) === source.proposalId ? source : null));
    const ProposalManager = {
        findEditDependents: vi.fn(() => []),
        updateProposalInPlace: vi.fn(async () => ({ applied: true })),
        deriveForNewProposal: vi.fn(async () => ({ applied: true })),
        _refreshUIAfterProposalChange: vi.fn(),
        getLastApplyFailure: vi.fn(() => null),
        getLastApplyFailureInfo: vi.fn(() => null)
    };
    install('ProposalManager', ProposalManager);
    install('ProposalLineage', require('../../frontend/js/proposals/lineage.js'));
    install('__freeformConversion', require('../../frontend/js/proposals/freeform-conversion.js'));
    install('__siteDraft', require('../../frontend/js/proposals/site-draft.js'));
    install('turf', turf);
    install('CbDialog', { confirm: vi.fn(async () => true) });
    install('isProposalApplied', record => record?.applied === true);
    install('showStyledAlert', vi.fn());
    install('showEphemeralMessage', vi.fn());
    install('beginApplyIndicator', vi.fn());
    install('endApplyIndicator', vi.fn());
    delete require.cache[shellPath];
    require(shellPath);
    return { store, drafts, ProposalManager };
}

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
    delete require.cache[shellPath];
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
    vi.restoreAllMocks();
});

describe('convertProposalToFreeform', () => {
    it('converts one\'s own local Block in place: one Freeform building, same id', async () => {
        const source = block();
        const { drafts, ProposalManager } = loadShell(source);

        await expect(globalThis.convertProposalToFreeform('own-block')).resolves.toBe('own-block');

        const draft = drafts.get('conversion-draft');
        expect(draft).toMatchObject({ adapterKey: 'single', goal: 'single', editorPayload: { typology: 'single', placement: { free: true } } });
        expect(draft.editorPayload.context.buildings).toHaveLength(1);
        expect(draft.editorPayload.context.buildings[0].properties).toMatchObject({ height: 15, type: 'proposedBuildingSingle' });
        // The rule's parameters do not survive into the Freeform design.
        expect(draft.editorPayload.context.parameters).toEqual({ typology: 'single', height: 15, rotation: 0, footprintMode: 'polygon' });
        // No live parcels: the Block stores no site, so the Freeform stands on its own footprint.
        expect(turf.area(turf.feature(draft.fields.site))).toBeCloseTo(turf.area(turf.feature(source.geometry.buildings[0].geometry)), 0);
        expect(ProposalManager.updateProposalInPlace).toHaveBeenCalledOnce();
        expect(ProposalManager.updateProposalInPlace.mock.calls[0][0]).toBe('own-block');
        expect(globalThis.proposalStorage.addProposal).not.toHaveBeenCalled();
    });

    it('makes a Freeform counterproposal of a published Block, which stays as it is', async () => {
        const source = block({ serverProposalId: '901' });
        const before = JSON.parse(JSON.stringify(source));
        const { ProposalManager } = loadShell(source);

        await expect(globalThis.convertProposalToFreeform('own-block')).resolves.toBe('fork-1');

        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledOnce();
        expect(ProposalManager.updateProposalInPlace).not.toHaveBeenCalled();
        expect(source).toEqual(before);
        expect(globalThis.CbDialog.confirm.mock.calls[0][0]).toContain('counterproposal');
    });

    it('refuses a Block whose buildings do not touch, before asking or saving anything', async () => {
        const source = block({}, [
            { type: 'Feature', properties: { height: 15 }, geometry: box(16, 45, 16 + D, 45 + D) },
            { type: 'Feature', properties: { height: 15 }, geometry: box(16 + 3 * D, 45, 16 + 4 * D, 45 + D) }
        ]);
        const { store, ProposalManager } = loadShell(source);

        await expect(globalThis.convertProposalToFreeform('own-block')).resolves.toBeNull();

        expect(globalThis.showStyledAlert.mock.calls[0][0]).toMatch(/do not touch/);
        expect(globalThis.CbDialog.confirm).not.toHaveBeenCalled();
        expect(store.createDraftFromProposal).not.toHaveBeenCalled();
        expect(ProposalManager.updateProposalInPlace).not.toHaveBeenCalled();
    });

    it('keeps the rule when the user says so', async () => {
        const source = block();
        const { store } = loadShell(source);
        globalThis.CbDialog.confirm.mockResolvedValue(false);
        await expect(globalThis.convertProposalToFreeform('own-block')).resolves.toBeNull();
        expect(store.createDraftFromProposal).not.toHaveBeenCalled();
    });
});
