// Local persistence is the authored proposal log, not a saved browser replay. Derived child ids,
// formation receipts and demolition scans must never survive a reload as apparent prerequisites.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const status = require('../../frontend/js/proposals/status.js');
const formationDepth = require('../../frontend/js/proposals/formation-depth.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const dataSource = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');
const DESIGN_CID = require('../../frontend/js/cid.js').cidOfObject({ schema: 'design/v1', title: 'Published park' });

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

afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
});

function bootStore() {
    const persisted = new Map();
    install('window', globalThis);
    install('__formationDepth', formationDepth);
    install('__planOrder', planOrder);
    install('ProposalOrigin', require('../../frontend/js/proposals/origin.js'));
    install('ProposalAuthoredRecord', require('../../frontend/js/proposals/authored-record.js'));
    install('normalizeParcelIdList', values => Array.from(new Set((values || []).map(String))));
    install('normalizeLensEntries', value => value || []);
    install('normalizeProposalStatusAxes', status.normalizeProposalStatusAxes);
    install('getLifecycleStatus', status.getLifecycleStatus);
    install('parkProposalForImport', status.parkProposalForImport);
    install('normalizeProposalGoalKey', value => String(value || '').trim().toLowerCase());
    install('isLocalProposalId', value => /^local-/.test(String(value || '')));
    install('PersistentStorage', {
        getItem: key => persisted.get(key) || null,
        setItem: (key, value) => persisted.set(key, String(value)),
        removeItem: key => persisted.delete(key),
        forEach: callback => persisted.forEach((value, key) => callback(value, key)),
        // Applies synchronously, like the real store's cache does once its transaction completes,
        // so the assertions below can read the map straight after the call.
        atomicWrite: async change => {
            (change.deletes || []).forEach(key => persisted.delete(key));
            (change.puts || new Map()).forEach((value, key) => persisted.set(key, String(value)));
        }
    });
    const api = (0, eval)(dataSource + '\n;({ proposalStorage, proposalWithAuthoredSelection })');
    return { storage: api.proposalStorage, proposalWithAuthoredSelection: api.proposalWithAuthoredSelection, persisted };
}

describe('proposalStorage authored-log persistence', () => {
    it('rolls back both definitions and imported plan membership if atomic storage fails, and permits retry', async () => {
        const File = require('../../frontend/js/plan-file.js');
        const UI = require('../../frontend/js/plan-file-ui.js');
        const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');
        const { storage, persisted } = bootStore();
        install('ProposalManager', { runParcelMutation: (kind, proposalId, work) => ParcelMutation.run({ kind, proposalId }, context => work({ _parcelMutation: context }),
            { runtime: globalThis, proposalStore: storage, storage: PersistentStorage, agentStore: null, fabric: null }) });
        const site = { type: 'Polygon', coordinates: [[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]] };
        const file = await File.create([{ goal: 'park', title: 'Atomic park', site, structureProposal: { kind: 'park', geometry: site } }], { title: 'Atomic plan', view: { at: '45,15,17', mode: '2d' } });
        const write = PersistentStorage.atomicWrite;
        PersistentStorage.atomicWrite = async () => { throw new Error('disk full'); };
        await expect(UI.browser(globalThis).commitImport(file)).rejects.toThrow('disk full');
        expect(storage.getAllProposals()).toEqual([]); expect(persisted.size).toBe(0);
        PersistentStorage.atomicWrite = write;
        const plan = await UI.browser(globalThis).commitImport(file);
        expect(storage.getAllProposals()).toHaveLength(1);
        expect(JSON.parse(persisted.get(UI.PREFIX + plan.cid))).toEqual(plan);
    });
    it('restores a portable plan through the real normalizer and reloads with identical authored content', async () => {
        const File = require('../../frontend/js/plan-file.js');
        const { storage } = bootStore();
        const site = { type: 'Polygon', coordinates: [[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]] };
        const file = await File.create([{ goal: 'park', title: 'Portable park', site,
            createdAt: '2026-10-25T10:00:00.000Z', structureProposal: { kind: 'park', geometry: site } }],
            { title: 'Portable plan', view: { at: '45,15,17', mode: '2d' } });
        const result = File.importInto(file, storage, { id: () => 'file-park' });
        storage.save(); storage.load();
        const record = storage.getProposal(result.memberIds[0]);
        expect(record.applied).toBe(false); expect(record).not.toHaveProperty('published');
        expect(await File.create([record], { title: result.content.title, view: result.content.view })).toEqual(file);
    });
    it('keeps local keys and design CIDs in separate namespaces', () => {
        const { storage } = bootStore();
        // A design read back from the index is kept under its own local key (DesignSync.importDesign);
        // its CID names it at the index, never in this store (DesignSync.localCopyOf finds it by CID).
        const publishedCopy = { proposalId: `design-${DESIGN_CID}`, published: { cid: DESIGN_CID, publishedAt: null, apiBase: 'https://api.example' } };
        const numericLocal = { proposalId: '42' };
        [publishedCopy, numericLocal].forEach(record => storage.proposals.set(record.proposalId, record));
        expect(storage.getProposal(DESIGN_CID)).toBeNull();
        expect(storage.removeProposal(DESIGN_CID)).toBeNull();
        expect(storage.getProposal(publishedCopy.proposalId)).toBe(publishedCopy);
        expect(storage.getProposal('42')).toBe(numericLocal);
        storage.proposals.delete('42');
        expect(storage.getProposal('42')).toBeNull();
        expect(storage.removeProposal('42')).toBeNull();
        expect(storage.proposals.size).toBe(1);
    });

    it('does not infer publication from a numeric imported local key', () => {
        const { storage } = bootStore();
        const imported = storage.importProposal({ proposalId: '42', goal: 'as-is', cadastreParcelIds: ['source-a'] });
        expect(imported.proposalId).toBe('42');
        expect(imported).not.toHaveProperty('published');
    });

    it('initializes authored records as Active but preserves unknown lifecycle on import and reload', () => {
        const { storage, persisted } = bootStore();
        const record = { proposalId: 'new-record', title: 'New design', goal: 'as-is', cadastreParcelIds: ['HR-1'] };
        const id = storage.addProposal(record);
        expect(storage.getProposal(id).lifecycleStatus).toBe('Active');
        expect(record).not.toHaveProperty('lifecycleStatus');
        const imported = storage.importProposal({ ...record, proposalId: 'imported-record' });
        expect(imported.lifecycleStatus).toBe('Unknown');
        persisted.set('proposal:stored-record', JSON.stringify({ ...record, proposalId: 'stored-record' }));
        storage.load();
        expect(storage.getProposal('stored-record').lifecycleStatus).toBe('Unknown');
    });

    it('keeps an imported record\'s creation time as it arrives and invents none', () => {
        // A published design hashes its creation time (design-record.js): a clock value stamped on
        // import would move its CID, and an agreement naming the design would read it as changed.
        const { storage } = bootStore();
        const record = { goal: 'as-is', cadastreParcelIds: ['HR-1'] };
        expect(storage.importProposal({ ...record, proposalId: 'dated', createdAt: '2026-10-01T12:00:00.000Z' }).createdAt)
            .toBe('2026-10-01T12:00:00.000Z');
        expect(storage.importProposal({ ...record, proposalId: 'undated', createdAt: null }).createdAt).toBeNull();
        // Authoring is when a record is created: addProposal stamps it.
        const id = storage.addProposal({ ...record, proposalId: 'authored' });
        expect(Number.isFinite(Date.parse(storage.getProposal(id).createdAt))).toBe(true);
    });

    it('persists flat cadastral declarations and strips all materialization output without mutating runtime state', () => {
        const { storage, persisted } = bootStore();
        const record = {
            proposalId: 'road-1',
            goal: 'road-track',
            applied: true,
            // The authored envelope carries flat source anchors explicitly. Runtime output can
            // temporarily decorate an in-memory record, but no retired land alias is accepted.
            cadastreParcelIds: ['HR-A', 'HR-B'],
            childParcelIds: ['HR-A#road-1'],
            parentFeatures: [{ type: 'Feature' }],
            editSeq: 4,
            roadProposal: {
                childParcelIds: ['HR-A#road-1'],
                formation: { parcelIds: ['HR-A'] },
                definition: {
                    polygon: { type: 'Polygon', coordinates: [] },
                    demolishedBuildings: [{ id: 'b-1' }],
                    demolitionScanned: true
                }
            }
        };
        storage.proposals.set(record.proposalId, record);

        storage._persist();

        const stored = JSON.parse(persisted.get('proposal:road-1'));
        expect(stored.applied).toBe(true);
        expect(stored.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(stored).not.toHaveProperty('childParcelIds');
        expect(stored).not.toHaveProperty('parentFeatures');
        expect(stored).not.toHaveProperty('editSeq');
        expect(stored.roadProposal).not.toHaveProperty('childParcelIds');
        expect(stored.roadProposal).not.toHaveProperty('formation');
        expect(stored.roadProposal.definition).not.toHaveProperty('demolishedBuildings');
        expect(stored.roadProposal.definition).not.toHaveProperty('demolitionScanned');

        // Serialization is a projection. The current replay may still use its in-memory output
        // ids for selection and rendering until the next materialization replaces them.
        expect(record.childParcelIds).toEqual(['HR-A#road-1']);
        expect(record.roadProposal.formation).toEqual({ parcelIds: ['HR-A'] });
    });

    it('refuses uploader-local block metadata without asking the live fabric to reinterpret it', () => {
        const cadastreIdsForParcelIds = vi.fn(() => {
            throw new Error('persistence crossed into live fabric');
        });
        install('LiveParcelFabric', { cadastreIdsForParcelIds });
        const { storage, persisted } = bootStore();
        storage.proposals.set('block-1', {
            proposalId: 'block-1',
            goal: 'buildings',
            typologyType: 'block',
            cadastreParcelIds: ['HR-330264-502'],
            buildingProposal: {
                blockParcelIds: ['HR-330264-502#p173qvvu'],
                ineligibleParcels: []
            }
        });

        expect(() => storage._persist()).toThrow(/buildingProposal\.blockParcelIds is invalid/);
        expect(cadastreIdsForParcelIds).not.toHaveBeenCalled();
        expect(Array.from(persisted.keys()).some(key => key.startsWith('proposal:'))).toBe(false);
    });

    it('persists one authored building geometry without live rendering stamps or mirrors', () => {
        const { storage, persisted } = bootStore();
        storage.proposals.set('block-2', {
            proposalId: 'block-2',
            goal: 'buildings',
            typologyType: 'block',
            cadastreParcelIds: ['HR-1'],
            similarityHash: 'runtime-index',
            buildingGeometry: { type: 'Polygon', coordinates: [] },
            buildingProperties: { height: 12, parcelId: 'HR-1#piece' },
            properties: { height: 12, parcelId: 'HR-1#piece' },
            geometry: {
                buildings: [{
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [] },
                    properties: {
                        height: 12,
                        parcelId: 'HR-1#piece',
                        proposalId: 'block-2',
                        proposalState: 'applied',
                        parentParcelIds: ['HR-1'],
                        buildingIndex: 0
                    }
                }]
            },
            buildingProposal: {
                buildingFeature: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } },
                buildings: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }]
            }
        });

        storage._persist();

        const stored = JSON.parse(persisted.get('proposal:block-2'));
        expect(stored.geometry.buildings).toHaveLength(1);
        expect(stored.geometry.buildings[0].properties).toEqual({ height: 12 });
        expect(stored).not.toHaveProperty('buildingGeometry');
        expect(stored).not.toHaveProperty('buildingProperties');
        expect(stored).not.toHaveProperty('properties');
        expect(stored).not.toHaveProperty('similarityHash');
        expect(stored.buildingProposal).not.toHaveProperty('buildingFeature');
        expect(stored.buildingProposal).not.toHaveProperty('buildings');
        expect(stored.buildingProposal).not.toHaveProperty('blockParcelIds');
    });

    it('projects a local live selection exactly once at the authoring boundary', () => {
        const cadastreIdsForParcelIds = vi.fn(ids => ids.flatMap(id => ({
            'live-main': ['HR-1'],
            'live-edge': ['HR-2'],
            'live-split': ['HR-1', 'HR-3']
        })[id] || []));
        install('LiveParcelFabric', { cadastreIdsForParcelIds });
        const { proposalWithAuthoredSelection } = bootStore();

        const normalized = proposalWithAuthoredSelection({
            typologyType: 'block',
            buildingProposal: { ineligibleParcels: [] }
        }, ['live-main', 'live-edge', 'live-split']);

        expect(normalized.cadastreParcelIds).toEqual(['HR-1', 'HR-2', 'HR-3']);
        expect(normalized).not.toHaveProperty('parentParcelIds');
        expect(normalized.buildingProposal).not.toHaveProperty('blockParcelIds');
        expect(cadastreIdsForParcelIds).toHaveBeenCalledTimes(1);
    });

    it('does not load an invalid authored record', () => {
        const { storage, persisted } = bootStore();
        persisted.set('cadastre_proposals_manifest', JSON.stringify({ manifestVersion: 1, nextProposalId: 4 }));
        persisted.set('proposal:valid-1', JSON.stringify({ proposalId: 'valid-1', cadastreParcelIds: ['HR-1'] }));
        persisted.set('proposal:invalid-1', JSON.stringify({ proposalId: 'invalid-1', cadastreParcelIds: ['HR-1#generated-piece'] }));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        storage.load();

        expect(storage.getAllProposals().map(proposal => proposal.proposalId)).toEqual(['valid-1']);
        expect(storage.getProposal('invalid-1')).toBeNull();
        expect(storage.nextProposalId).toBe(4);
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining('Rejected invalid stored proposal invalid-1'),
            expect.any(Error)
        );

        // A whole-store save drops the rejected row: it has no record in memory.
        storage._persist();
        expect(Array.from(persisted.keys()).filter(key => key.startsWith('proposal:'))).toEqual(['proposal:valid-1']);
        consoleError.mockRestore();
    });
});
