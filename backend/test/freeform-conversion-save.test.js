// "Convert to freeform building" on a saved Block (proposal-editor-shell.js convertProposalToFreeform):
// the stored massing becomes one Freeform building in a draft that saves by the ordinary edit rule —
// one's own local record in place, a published one as a Freeform counterproposal — and a Block whose
// buildings do not touch is refused before anything is saved. A Detached rule dropped elsewhere
// becomes one Freeform proposal per house (convertActiveDesignToFreeformBuildings). Runs the real
// shell over stubbed stores.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shellPath = require.resolve('../../frontend/js/proposal-editor-shell.js');
const variation = require('../../frontend/js/urban-rule-variation.js');
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
    let nextDraft = 0;
    const draftId = () => (nextDraft++ === 0 ? 'conversion-draft' : `draft-${nextDraft}`);
    const store = {
        createDraft: vi.fn(input => {
            const draft = { ...JSON.parse(JSON.stringify(input)), id: draftId(), sourceProposalId: input.sourceProposalId || null, validation: { valid: true, errors: [] } };
            delete draft.activate;
            drafts.set(draft.id, draft);
            return JSON.parse(JSON.stringify(draft));
        }),
        createDraftFromProposal: vi.fn(proposal => {
            const draft = {
                id: draftId(), sourceProposalId: proposal.proposalId, sourceSnapshot: proposal,
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
            Object.assign(draft, next, { dirty: true });
            return draft;
        }),
        getDraft: id => drafts.get(id) || null,
        flush: vi.fn(),
        validateDraft: id => drafts.get(id),
        deleteDraft: vi.fn(id => drafts.delete(id)),
        buildProposalFromDraft: vi.fn(id => ({ goal: drafts.get(id).goal, title: drafts.get(id).fields?.name ?? source.title, site: drafts.get(id).fields?.site, editorPayload: drafts.get(id).editorPayload })),
        consumeAfterPublish: vi.fn()
    };
    install('proposalDraftStore', store);
    let forks = 0;
    install('proposalStorage', {
        getProposal: id => (String(id) === source.proposalId ? source : null),
        addProposal: vi.fn(() => `fork-${++forks}`),
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
    install('UrbanRuleVariation', variation);
    install('CbDialog', { confirm: vi.fn(async () => true) });
    install('isProposalApplied', record => record?.applied === true);
    install('showStyledAlert', vi.fn());
    install('showEphemeralMessage', vi.fn());
    install('beginApplyIndicator', vi.fn());
    install('endApplyIndicator', vi.fn());
    install('proposalEditorAdapterRegistry', { get: () => ({ key: 'parcelBased', canEdit: () => true }) });
    install('openProposalDraftDesign', vi.fn(async id => { globalThis.activeProposalDesignDraftId = id; return true; }));
    install('activeProposalDesignDraftId', null);
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

// A Detached rule on two parcels: one envelope per parcel (at the rule's maximum height), side by
// side with a gap between them. The map draws a lower example house inside each; that is not frozen.
function detached(extra = {}) {
    const house = (west, floors, parcelId) => ({ type: 'Feature',
        properties: { height: floors * 3, floors, parcelId, urbanRule: variation.normalizeParcelRule({ kind: 'max', maxFloors: floors, minFloors: 1, floorHeightM: 3 }), variationSeed: 7, massing: true },
        geometry: box(west, 45, west + D, 45 + D) });
    const houses = [house(16, 3, 'HR-1'), house(16 + 3 * D, 4, 'HR-2')];
    return block({ proposalId: 'own-detached', typologyType: 'parcelBased', title: 'Two houses',
        buildingProposal: { typologyType: 'parcelBased', parameters: { typology: 'parcelBased' } }, ...extra }, houses);
}
const shift = (geometry, dx) => ({ ...geometry, coordinates: geometry.coordinates.map(ring => ring.map(([x, y]) => [x + dx, y])) });
const droppedHouses = source => source.geometry.buildings.map(feature => {
    const moved = { ...feature, geometry: shift(feature.geometry, 10 * D) };
    return { feature: moved, site: moved.geometry };
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function flushSaves(ProposalManager, store, expectedCreates) {
    for (let i = 0; i < 50 && store.buildProposalFromDraft.mock.calls.length < expectedCreates; i++) await settle();
    await settle();
}

describe('convertActiveDesignToFreeformBuildings: a dropped Detached becomes one Freeform per house', () => {
    it('one\'s own local Detached: the first house keeps the id, the second is a new proposal, saved after it', async () => {
        const source = detached();
        const { store, drafts, ProposalManager } = loadShell(source);
        await globalThis.editProposalGeometry('own-detached');

        const result = await globalThis.convertActiveDesignToFreeformBuildings({ houses: droppedHouses(source), confirm: false });
        expect(result).toMatchObject({ ok: true, count: 2 });
        // The further house is a fresh draft, not a second copy of the source.
        expect(store.createDraft).toHaveBeenCalledOnce();
        const [first, second] = [...drafts.values()];
        expect(first.sourceProposalId).toBe('own-detached');
        expect(second.sourceProposalId).toBeNull();
        expect(second.fields.name).toBe('');
        // Named, when saved, as the Freeform building it now is.
        expect(second.proposalType).toBe(first.proposalType);
        expect(second.proposalType).toBe('single');
        [first, second].forEach((draft, index) => {
            const envelope = droppedHouses(source)[index].feature;
            // The example house the map draws is lower than the envelope; the envelope is what freezes.
            expect(variation.realizeFeature(envelope, { turf }).properties.height).toBeLessThan(envelope.properties.height);
            expect(draft).toMatchObject({ goal: 'single', adapterKey: 'single' });
            expect(draft.editorPayload.context.buildings).toHaveLength(1);
            expect(draft.editorPayload.context.parameters).toEqual({ typology: 'single', height: [9, 12][index], rotation: 0, footprintMode: 'polygon' });
            expect(turf.area(draft.editorPayload.context.buildings[0])).toBeCloseTo(turf.area(envelope), 1);
            expect(draft.fields.site).toEqual(droppedHouses(source)[index].site);
        });

        globalThis.finishProposalDraftDesignSession();
        await flushSaves(ProposalManager, store, 2);
        expect(ProposalManager.updateProposalInPlace).toHaveBeenCalledOnce();
        expect(ProposalManager.updateProposalInPlace.mock.calls[0][0]).toBe('own-detached');
        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledOnce();
        expect(globalThis.proposalStorage.addProposal.mock.calls[0][0].site).toEqual(droppedHouses(source)[1].site);
        // The first is saved before the second is built.
        expect(ProposalManager.updateProposalInPlace.mock.invocationCallOrder[0])
            .toBeLessThan(globalThis.proposalStorage.addProposal.mock.invocationCallOrder[0]);
    });

    it('a published Detached: every house becomes a counterproposal and the source stays as it is', async () => {
        const source = detached({ serverProposalId: '902' });
        const before = JSON.parse(JSON.stringify(source));
        const { store, ProposalManager } = loadShell(source);
        await globalThis.editProposalGeometry('own-detached');

        await expect(globalThis.convertActiveDesignToFreeformBuildings({ houses: droppedHouses(source), confirm: false })).resolves.toMatchObject({ ok: true });
        expect(store.createDraft).not.toHaveBeenCalled();
        expect(store.createDraftFromProposal).toHaveBeenCalledTimes(2);
        globalThis.finishProposalDraftDesignSession();
        await flushSaves(ProposalManager, store, 2);

        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledTimes(2);
        expect(ProposalManager.updateProposalInPlace).not.toHaveBeenCalled();
        expect(source).toEqual(before);
    });

    it('drops the further houses when the editor is abandoned instead of confirmed', async () => {
        const source = detached();
        const { store, drafts } = loadShell(source);
        await globalThis.editProposalGeometry('own-detached');
        await globalThis.convertActiveDesignToFreeformBuildings({ houses: droppedHouses(source), confirm: false });
        expect(drafts.size).toBe(2);

        globalThis.discardProposalDraftDesignSession();

        expect(drafts.size).toBe(0);
        expect(store.buildProposalFromDraft).not.toHaveBeenCalled();
    });
});
