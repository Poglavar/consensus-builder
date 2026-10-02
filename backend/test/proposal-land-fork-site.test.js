import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposal-editor-shell.js', import.meta.url)), 'utf8');

function loadContinueLandFork(context) {
    const start = source.indexOf('    async function continueLandFork() {');
    const end = source.indexOf('    // One line at the top of the create dialog', start);
    if (start < 0 || end < 0) throw new Error('continueLandFork implementation not found');
    vm.runInNewContext(`${source.slice(start, end)}\nthis.runContinueLandFork = continueLandFork;`, context);
}

describe('changed-land site fork preparation', () => {
    it('rebuilds site, parcel declaration, and structure geometry from selected live ground', async () => {
        const sourceSite = { type: 'Polygon', coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.81], [15.9, 45.8]]] };
        const newSite = { type: 'MultiPolygon', coordinates: [[[[15.92, 45.8], [15.93, 45.8], [15.93, 45.81], [15.92, 45.8]]]] };
        const originalSnapshot = { title: 'Source park', site: sourceSite, cadastreParcelIds: ['HR-1-100'] };
        const draft = {
            id: 'draft-fork', sourceSnapshot: structuredClone(originalSnapshot),
            fields: { site: sourceSite, binding: { parcels: [{ parcelId: 'HR-1-100' }] }, cadastreParcelIds: ['HR-1-100'] },
            editorPayload: { structureProposal: { kind: 'park', geometry: sourceSite } }
        };
        const liveIds = ['HR-1-101#live'];
        const updated = vi.fn((id, patch) => {
            Object.assign(draft.fields, patch.fields);
            Object.assign(draft, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'fields')));
        });
        const stage = vi.fn(async () => true);
        const global = {
            proposalDraftStore: { getDraft: () => draft, updateDraft: updated },
            __siteDraft: { siteFromFeatures: vi.fn() },
            LiveParcelFabric: { cadastreIdsForParcelIds: vi.fn(() => ['HR-1-101']) }
        };
        const context = {
            global,
            landForkSession: { draftId: draft.id, origin: originalSnapshot },
            describeLandForkSelection: () => ({ liveIds }),
            siteOfLiveSelection: vi.fn(() => newSite),
            polygonOfSite: vi.fn(site => ({ type: 'Polygon', coordinates: site.coordinates[0] })),
            STRUCTURE_KIND_LABELS: { park: 'Park', square: 'Square', lake: 'Lake' },
            endLandForkSession: vi.fn(),
            stageProposalDraftForPublishing: stage,
            showLandForkDialogNotice: vi.fn(),
            renderLandForkBar: vi.fn(),
            reportDisconnectedStructureSelection: vi.fn(),
            console
        };
        context.globalThis = context;
        loadContinueLandFork(context);

        await context.runContinueLandFork();

        expect(updated).toHaveBeenCalledOnce();
        const [draftId, patch, options] = updated.mock.calls[0];
        expect(draftId).toBe('draft-fork');
        expect(options.coalesceKey).toBe('land-fork-selection');
        expect(patch.fields).toMatchObject({
            selectedParcelIds: liveIds,
            site: newSite,
            cadastreParcelIds: ['HR-1-101'],
            binding: null
        });
        expect(patch.editorPayload.structureProposal.geometry).toEqual({
            type: 'Polygon', coordinates: newSite.coordinates[0]
        });
        expect(patch.previewGeometry).toEqual(patch.editorPayload.structureProposal.geometry);
        expect(draft.sourceSnapshot).toEqual(originalSnapshot);
        expect(stage).toHaveBeenCalledWith('draft-fork');
    });
});
