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
// A design published at the index: the CID mark proposals/lineage.js reads as immutable.
const publishedAs = title => ({ published: { cid: require('../../frontend/js/cid.js').cidOfObject({ schema: 'design/v1', title }),
    publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test' } });
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
        proposalId: 'own-block', goal: 'buildings', typologyType: 'block', title: 'Courtyard block', titleOrigin: 'generated', applied: true,
        cadastreParcelIds: ['HR-1', 'HR-2'], createdAt: '2026-10-01T10:00:00.000Z',
        buildingProposal: { typologyType: 'block', parameters: { mode: 'parametric', typology: 'block', setback: 2 } },
        // A Block stores its per-parcel pieces beside the complete authored massing; several pieces
        // here stand for a ring in separate parts, so the massing is their MultiPolygon.
        geometry: { buildings, ruleMassing: buildings.length === 1 ? buildings[0] : {
            type: 'Feature', properties: { height: 15 },
            geometry: { type: 'MultiPolygon', coordinates: buildings.map(feature => feature.geometry.coordinates) }
        } },
        ...extra
    };
}

function loadShell(source) {
    const drafts = new Map();
    let nextDraft = 0;
    const draftId = () => (nextDraft++ === 0 ? 'conversion-draft' : `draft-${nextDraft}`);
    const store = {
        createDraft: vi.fn(input => {
            const draft = { ...JSON.parse(JSON.stringify(input)), id: draftId(), sourceLocalProposalId: input.sourceLocalProposalId || null, validation: { valid: true, errors: [] } };
            delete draft.activate;
            drafts.set(draft.id, draft);
            return JSON.parse(JSON.stringify(draft));
        }),
        createDraftFromProposal: vi.fn(proposal => {
            const draft = {
                id: draftId(), sourceLocalProposalId: proposal.proposalId, sourceSnapshot: proposal,
                adapterKey: 'buildings', goal: 'buildings', fields: { name: proposal.title, description: proposal.description || '', ...(proposal.titleOrigin ? { titleOrigin: proposal.titleOrigin } : {}) },
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
        resumeDraft: id => drafts.get(id) || null,
        flush: vi.fn(),
        validateDraft: id => drafts.get(id),
        deleteDraft: vi.fn(id => drafts.delete(id)),
        buildProposalFromDraft: vi.fn(id => ({
            goal: drafts.get(id).goal,
            title: drafts.get(id).fields?.name ?? source.title,
            site: drafts.get(id).fields?.site,
            geometry: { buildings: drafts.get(id).editorPayload?.context?.buildings || [] },
            editorPayload: drafts.get(id).editorPayload
        })),
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
        applyProposal: vi.fn(async () => true),
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
    install('generateDefaultProposalName', type => `${type} generated`);
    install('generateDefaultProposalDescription', (type, name) => `${type}: ${name}`);
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
        expect(draft.fields).toMatchObject({ name: 'single generated', titleOrigin: 'generated', description: 'single: single generated' });
        // No live parcels: the Block stores no site, so the Freeform stands on its own footprint.
        expect(turf.area(turf.feature(draft.fields.site))).toBeCloseTo(turf.area(turf.feature(source.geometry.buildings[0].geometry)), 0);
        expect(ProposalManager.updateProposalInPlace).toHaveBeenCalledOnce();
        expect(ProposalManager.updateProposalInPlace.mock.calls[0][0]).toBe('own-block');
        expect(globalThis.proposalStorage.addProposal).not.toHaveBeenCalled();
    });

    it('preserves a user-authored title while converting the geometry', async () => {
        const source = block({ title: 'My courtyard', titleOrigin: 'user' });
        const { drafts } = loadShell(source);
        await globalThis.convertProposalToFreeform('own-block');
        expect(drafts.get('conversion-draft').fields).toMatchObject({ name: 'My courtyard', titleOrigin: 'user' });
    });

    it('does not replace an authored description when it replaces a generated title', async () => {
        const source = block({ description: 'Keep this description.' });
        const { drafts } = loadShell(source);
        await globalThis.convertProposalToFreeform('own-block');
        expect(drafts.get('conversion-draft').fields).toMatchObject({ name: 'single generated', titleOrigin: 'generated', description: 'Keep this description.' });
    });

    it('makes a Freeform counterproposal of a published Block, which stays as it is', async () => {
        const source = block(publishedAs('Published block'));
        const before = JSON.parse(JSON.stringify(source));
        const { ProposalManager } = loadShell(source);

        await expect(globalThis.convertProposalToFreeform('own-block')).resolves.toBe('fork-1');

        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledOnce();
        expect(ProposalManager.updateProposalInPlace).not.toHaveBeenCalled();
        // The counterproposal is applied like any proposal (ProposalManager.applyProposal), so the
        // applied records on its ground come off the map instead of staying under it.
        expect(ProposalManager.applyProposal).toHaveBeenCalledExactlyOnceWith('fork-1');
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
    return block({ proposalId: 'own-detached', typologyType: 'parcelBased', title: 'Two houses', titleOrigin: 'generated',
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
        expect(first.sourceLocalProposalId).toBe('own-detached');
        expect(second.sourceLocalProposalId).toBeNull();
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
            expect(draft.fields.site).toEqual({ type: 'MultiPolygon', coordinates: [droppedHouses(source)[index].site.coordinates] });
        });

        globalThis.finishProposalDraftDesignSession();
        await flushSaves(ProposalManager, store, 2);
        expect(ProposalManager.updateProposalInPlace).toHaveBeenCalledOnce();
        expect(ProposalManager.updateProposalInPlace.mock.calls[0][0]).toBe('own-detached');
        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledOnce();
        expect(globalThis.proposalStorage.addProposal.mock.calls[0][0].site).toEqual({ type: 'MultiPolygon', coordinates: [droppedHouses(source)[1].site.coordinates] });
        // The further house is applied like any proposal, rivals and all (ProposalManager.applyProposal).
        expect(ProposalManager.applyProposal).toHaveBeenCalledExactlyOnceWith('fork-1');
        // The first is saved before the second is built.
        expect(ProposalManager.updateProposalInPlace.mock.invocationCallOrder[0])
            .toBeLessThan(globalThis.proposalStorage.addProposal.mock.invocationCallOrder[0]);
    });

    it('a published Detached: every house becomes a counterproposal and the source stays as it is', async () => {
        const source = detached(publishedAs('Published detached'));
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

describe('stageActiveFreeformBuildings: fixed imported geometry uses ordinary Freeform siblings', () => {
    it('stages one Polygon building per entry, preserves holes and properties, and saves siblings after Done', async () => {
        const source = block();
        const { store, drafts, ProposalManager } = loadShell(source);
        await globalThis.editProposalGeometry('own-block');
        const outer = [[16, 45], [16 + D, 45], [16 + D, 45 + D], [16, 45 + D], [16, 45]];
        const hole = [[16 + D / 4, 45 + D / 4], [16 + D / 4, 45 + 3 * D / 4], [16 + 3 * D / 4, 45 + 3 * D / 4], [16 + 3 * D / 4, 45 + D / 4], [16 + D / 4, 45 + D / 4]];
        const imported = {
            type: 'Feature',
            properties: { height: 18, sourceId: 'imported-courtyard', label: 'courtyard' },
            geometry: { type: 'Polygon', coordinates: [outer, hole] }
        };
        const second = {
            type: 'Feature',
            properties: { height: 12, sourceId: 'imported-wing' },
            geometry: box(17, 45, 17 + D, 45 + D)
        };
        const siteA = turf.bboxPolygon([15.9, 44.9, 16.2, 45.2]).geometry;
        const siteB = turf.bboxPolygon([16.9, 44.9, 17.2, 45.2]).geometry;

        const staged = [
            { building: imported, site: siteA }, { building: second, site: siteB }
        ];
        const result = globalThis.stageActiveFreeformBuildings({ buildings: staged });

        expect(result).toEqual({ ok: true, count: 2 });
        expect(drafts.size).toBe(2);
        expect(store.buildProposalFromDraft).not.toHaveBeenCalled();
        expect(ProposalManager.updateProposalInPlace).not.toHaveBeenCalled();
        const [first, sibling] = [...drafts.values()];
        expect(first.editorPayload.context.buildings).toEqual([imported]);
        expect(first.editorPayload.context.buildings[0].geometry.coordinates).toEqual([outer, hole]);
        expect(first.fields.site).toEqual({ type: 'MultiPolygon', coordinates: [siteA.coordinates] });
        expect(first.editorPayload.placement.site).toEqual(first.fields.site);
        expect(sibling.editorPayload.context.buildings).toEqual([second]);
        expect(sibling.fields.site).toEqual({ type: 'MultiPolygon', coordinates: [siteB.coordinates] });
        expect(sibling.editorPayload.placement.site).toEqual(sibling.fields.site);
        expect(sibling.fields).toMatchObject({ name: '', titleOrigin: 'generated', description: '' });

        // The import preview can be edited before Done, then restaged from its final geometry.
        const oldSiblingId = sibling.id;
        expect(globalThis.stageActiveFreeformBuildings({ buildings: staged })).toEqual({ ok: true, count: 2 });
        expect(drafts.size).toBe(2);
        expect(drafts.has(oldSiblingId)).toBe(false);
        expect(store.buildProposalFromDraft).not.toHaveBeenCalled();

        globalThis.finishProposalDraftDesignSession();
        await flushSaves(ProposalManager, store, 2);

        expect(ProposalManager.updateProposalInPlace).toHaveBeenCalledOnce();
        expect(ProposalManager.updateProposalInPlace.mock.calls[0][1].geometry.buildings).toEqual([imported]);
        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledOnce();
        expect(globalThis.proposalStorage.addProposal.mock.calls[0][0].geometry.buildings).toEqual([second]);
        expect(ProposalManager.updateProposalInPlace.mock.invocationCallOrder[0])
            .toBeLessThan(globalThis.proposalStorage.addProposal.mock.invocationCallOrder[0]);
    });

    it('saves every uploaded building when Done comes from the form Design tab', async () => {
        const { store, ProposalManager } = loadShell(block());
        const draft = store.createDraft({ goal: 'single', adapterKey: 'single', fields: {}, editorPayload: {} });
        globalThis.beginProposalDraftDesignSession(draft.id);
        const first = { type: 'Feature', properties: { height: 18 }, geometry: box(16,45,16+D,45+D) };
        const second = { type: 'Feature', properties: { height: 9 }, geometry: box(17,45,17+D,45+D) };
        expect(globalThis.stageActiveFreeformBuildings({ buildings: [first,second].map(building => ({ building, site: building.geometry })) })).toEqual({ ok: true, count: 2 });
        globalThis.finishProposalDraftDesignSession();
        await flushSaves(ProposalManager, store, 2);
        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledTimes(2);
        expect(globalThis.proposalStorage.addProposal.mock.calls.map(([record]) => record.geometry.buildings)).toEqual([[first],[second]]);
    });

    it('restores every unsaved building and its surroundings before reopening a failed first save, then retries once per building', async () => {
        const { store, drafts, ProposalManager } = loadShell(block());
        const buildings = [
            { type: 'Feature', properties: { height: 18 }, geometry: box(16, 45, 16 + D, 45 + D) },
            { type: 'Feature', properties: { height: 9 }, geometry: box(16 + 3 * D, 45, 16 + 4 * D, 45 + D) }
        ];
        const site = box(16 - D, 45 - D, 16 + 5 * D, 45 + 2 * D);
        const surroundings = { groundSurface: { treatment: 'green', polygon: site }, groundBoundary: site, takeWholeParcels: false };
        const draft = store.createDraft({
            goal: 'single', adapterKey: 'single', fields: { site },
            editorPayload: { typology: 'single', context: { buildings, buildingFeature: buildings[0], ...surroundings } },
            previewGeometry: buildings
        });
        globalThis.beginProposalDraftDesignSession(draft.id);
        const original = JSON.parse(JSON.stringify(draft));
        const reopened = [];
        globalThis.openProposalDraftDesign.mockImplementation(async id => {
            reopened.push(JSON.parse(JSON.stringify(store.getDraft(id))));
            globalThis.beginProposalDraftDesignSession(id);
            return true;
        });
        const entries = buildings.map((building, index) => ({ building, site: index === 0 ? site : building.geometry,
            ...(index === 0 ? { surroundings } : {}) }));
        globalThis.stageActiveFreeformBuildings({ buildings: entries });
        store.buildProposalFromDraft.mockImplementationOnce(() => { throw new Error('Site binding unavailable'); });

        globalThis.finishProposalDraftDesignSession();
        await flushSaves(ProposalManager, store, 1);

        expect(reopened).toHaveLength(1);
        expect(reopened[0].editorPayload).toEqual(original.editorPayload);
        expect(reopened[0].previewGeometry).toEqual(buildings);
        expect(reopened[0].fields).toEqual(original.fields);
        expect(drafts.size).toBe(1);
        expect(globalThis.proposalStorage.addProposal).not.toHaveBeenCalled();

        globalThis.stageActiveFreeformBuildings({ buildings: entries });
        globalThis.finishProposalDraftDesignSession();
        await flushSaves(ProposalManager, store, 3);

        expect(globalThis.proposalStorage.addProposal.mock.calls.map(([record]) => record.geometry.buildings)).toEqual(buildings.map(building => [building]));
        expect(reopened).toHaveLength(1);
    });

    it('rejects non-Polygon building entries before replacing the active draft', async () => {
        const { drafts } = loadShell(block());
        await globalThis.editProposalGeometry('own-block');
        const before = JSON.parse(JSON.stringify(drafts.get('conversion-draft')));
        const multi = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [] } };

        expect(globalThis.stageActiveFreeformBuildings({ buildings: [{ building: multi, site: box(0, 0, 1, 1) }] }))
            .toMatchObject({ ok: false });
        expect(drafts.get('conversion-draft')).toEqual(before);
        expect(drafts.size).toBe(1);
    });
});
