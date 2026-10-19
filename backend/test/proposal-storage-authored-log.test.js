// Local persistence is the authored proposal log, not a saved browser replay. Derived child ids,
// formation receipts and demolition scans must never survive a reload as apparent prerequisites.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const status = require('../../frontend/js/proposals/status.js');
const formationDepth = require('../../frontend/js/proposals/formation-depth.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const chainRecord = require('../../frontend/js/proposals/chain-record.js');
const { loadChainProposalFromRef } = require('../../frontend/js/proposals/chain-proposal-loader.js');
const dataSource = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');

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
    install('__cbSecondaryTab', false);
    install('__formationDepth', formationDepth);
    install('__planOrder', planOrder);
    install('normalizeParcelIdList', values => Array.from(new Set((values || []).map(String))));
    install('normalizeOwnerAcceptances', value => value || {});
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
    it('preserves this browser consent on reload but discards imported unsigned claims', () => {
        const { storage } = bootStore();
        const record = { proposalId: 'session-consent', goal: 'as-is', cadastreParcelIds: ['parcel-a'],
            acceptedParcelIds: ['parcel-a'], ownerAcceptances: { 'parcel-a': { acceptedOwnerKeys: ['party-a'] } } };
        const before = structuredClone(record);
        storage.addProposal(record);
        storage.load();
        expect(storage.getProposal(record.proposalId)).toMatchObject(record);
        const imported = storage.importProposal({ ...record, proposalId: 'remote-consent' });
        expect(imported.acceptedParcelIds).toEqual([]);
        expect(imported.ownerAcceptances).toEqual({});
        expect(storage.getProposal(record.proposalId)).toMatchObject(record);
        const refresh = storage.importProposal({ ...record, title: 'Refreshed metadata',
            ownerAcceptances: { 'parcel-a': { acceptedOwnerKeys: ['remote-party'] } } });
        expect(refresh.ownerAcceptances).toEqual(record.ownerAcceptances);
        expect(refresh.ownerAcceptances).not.toBe(record.ownerAcceptances);
        expect(refresh.acceptedParcelIds).toEqual([]); // no current-terms evaluator in this fixture
        expect(record).toEqual(before);
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

    it('restores parked records without assigning them a new initial lifecycle', () => {
        const { storage, persisted } = bootStore();
        persisted.set('cadastre_proposals_recovery', JSON.stringify({ records: [
            { proposalId: 'parked-record', goal: 'as-is', cadastreParcelIds: ['HR-1'] }
        ] }));
        expect(storage.restoreRecovery()).toBe(1);
        expect(storage.getProposal('parked-record').lifecycleStatus).toBe('Unknown');
    });
    it.each([false, true])('reconstructs the complete minted record from chain and IPFS alone (local draft present: %s)', async localDraft => {
        const { storage, persisted } = bootStore();
        install('__chainRecord', chainRecord);
        install('ProposalAuthoredRecord', require('../../frontend/js/proposals/authored-record.js'));
        install('buildChainProposalId', (chain, contract, token) => `${chain}-${contract}-${token}`);
        install('getProposalGoalLabel', goal => goal);
        install('proposalStorage', storage);
        const site = { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] };
        const source = chainRecord.authoredRecord({
            proposalId: 'minted-park', city: 'test-city', goal: 'park', type: 'structure',
            name: 'Committed park', title: 'Committed park', description: 'As minted', author: 'Park author',
            createdAt: '2026-10-01T12:00:00Z', offer: 0, offerCurrency: 'ETH',
            depositEnabled: true, depositPercent: 20, isConditional: true, lens: [],
            cadastreParcelIds: ['HR-1'], site, binding: { parcels: [{ parcelId: 'HR-1' }], coverage: 'complete' },
            cadastreSnapshot: { protocol: 'cadastre-snapshot/1', regionHasCadastre: true, parcels: [{ id: 'HR-1', geometry: site }] },
            structureProposal: { kind: 'park', geometry: site }
        });
        if (localDraft) storage.proposals.set(source.proposalId, {
            ...source, title: 'A much longer locally edited draft title', author: 'Another author', offer: 999,
            depositEnabled: false, buildingProposal: { parameters: { floors: 50 } }, preparation: { id: 'stale-server-signature' }
        });
        install('ChainDataLoader', { getProposalsByIds: vi.fn(async () => [{
            proposalId: '77', imageURI: 'ipfs://committed-metadata', cadastreParcelIds: ['HR-1'], isConditional: true, lens: []
        }]) });
        const fetch = vi.fn(async url => {
            expect(url).toBe('https://ipfs.io/ipfs/committed-metadata');
            return { ok: true, json: async () => ({ properties: chainRecord.metadataProperties(source) }) };
        });
        install('fetch', fetch);
        const result = await loadChainProposalFromRef({ chainType: 'evm', chainId: '84532', contract: '0xC', tokenId: '77' });
        expect(result.ok).toBe(true);
        expect(result.proposal.lifecycleStatus).toBe('Unknown');
        expect(result.proposal).toMatchObject(source);
        expect(result.proposal.onchain).toMatchObject({ proposalId: '77', metadataUri: 'ipfs://committed-metadata' });
        expect(result.proposal).not.toHaveProperty('preparation');
        expect(result.proposal).not.toHaveProperty('buildingProposal');
        storage._persist();
        expect(JSON.parse(persisted.get('proposal:minted-park'))).toMatchObject(source);
        expect(fetch).toHaveBeenCalledTimes(1);
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
