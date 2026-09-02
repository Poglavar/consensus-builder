// Flat, local proposal release.
//
// Durable state has two sides only: original cadastral parcels and authored proposal records.
// Generated parcels are disposable, proposal-owned output. Unapply removes only that owner's
// output and recomputes corridor arrangement only on the record's original cadastral anchors.
// Shared cadastral ids never become transitive proposal dependencies.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { setProposalApplied } = require('../../frontend/js/proposals/status.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
const turf = require('@turf/turf');

const touched = new Map();
function install(name, value) {
    if (!touched.has(name)) {
        touched.set(name, {
            existed: Object.prototype.hasOwnProperty.call(globalThis, name),
            value: globalThis[name]
        });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, previous] of touched) {
        if (previous.existed) globalThis[name] = previous.value;
        else delete globalThis[name];
    }
    touched.clear();
    vi.restoreAllMocks();
});

function feature(parcelId, properties = {}) {
    return {
        type: 'Feature',
        properties: { parcelId, ...properties },
        geometry: turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]).geometry
    };
}

function layer(value) {
    return { feature: value, toGeoJSON: () => JSON.parse(JSON.stringify(value)) };
}

describe('scoped reset starts from cadastral facts', () => {
    it('purges every generated layer on the changed bases and never reveals a synthetic predecessor', () => {
        const baseA = layer(feature('HR-A'));
        const baseB = layer(feature('HR-B'));
        const priorA = layer(feature('HR-A#prior-1', {
            ancestorProposal: 'prior',
            baseParcelIds: ['HR-A']
        }));
        const parkA = layer(feature('HR-A#park-1', {
            ancestorProposal: 'park',
            // Deliberately legacy metadata: scope still comes from the flat base stamp.
            parentParcelId: 'HR-A#prior-1',
            baseParcelIds: ['HR-A']
        }));
        const remoteB = layer(feature('HR-B#remote-1', {
            ancestorProposal: 'remote',
            baseParcelIds: ['HR-B']
        }));
        const byId = new Map([
            ['HR-A', baseA], ['HR-B', baseB],
            ['HR-A#prior-1', priorA], ['HR-A#park-1', parkA],
            ['HR-B#remote-1', remoteB]
        ]);
        const cache = new Map(byId);
        const visible = new Set([parkA, remoteB]);
        const cleared = vi.fn();
        const persistent = new Map([
            ['parcel_HR-A#prior-1_owner', 'agent-a'],
            ['parcel_HR-A#park-1_owner', 'agent-a'],
            ['parcel_HR-B#remote-1_owner', 'agent-b']
        ]);
        const prior = { proposalId: 'prior', childParcelIds: ['HR-A#prior-1'] };
        const park = { proposalId: 'park', childParcelIds: ['HR-A#park-1'] };

        install('window', {
            parcelLayerById: byId,
            parcelLayer: { hasLayer: entry => visible.has(entry) },
            ParcelsState: { getParcelCache: () => ({ byId: cache }) },
            __formationEdit: formationEdit,
            removeParcelLayerById: id => visible.delete(byId.get(String(id))),
            showParcelLayerById: id => visible.add(byId.get(String(id))),
            parks: [
                { properties: { proposalId: 'park' } },
                { properties: { proposalId: 'remote' } },
                { properties: { surveyed: true } }
            ],
            squares: [], lakes: [], transitStations: [], proposedBuildings: []
        });
        install('PersistentStorage', {
            getItem: key => persistent.get(key) || null,
            removeItem: key => persistent.delete(key),
            setItem: vi.fn()
        });
        install('clearPersistedParcelRecord', cleared);
        install('updateAgentOwnedParcels', vi.fn());

        const manager = { _clearDerivedRecordState: ProposalManager._clearDerivedRecordState };
        ProposalManager._resetDerivedFabric.call(manager, [prior], {
            baseParcelIds: ['HR-A'],
            proposalIds: ['prior', 'park'],
            recordsToClear: [prior, park]
        });

        expect([...byId.keys()].sort()).toEqual(['HR-A', 'HR-B', 'HR-B#remote-1']);
        expect(byId.has('HR-A#prior-1')).toBe(false);
        expect(visible.has(priorA)).toBe(false);
        expect(visible.has(parkA)).toBe(false);
        expect(visible.has(baseA)).toBe(true);
        expect(visible.has(remoteB)).toBe(true);
        expect(cache.has('HR-A#prior-1')).toBe(false);
        expect(cache.has('HR-A#park-1')).toBe(false);
        expect(cache.has('HR-B#remote-1')).toBe(true);
        expect(globalThis.window.parks.map(entry => entry.properties.proposalId || 'surveyed'))
            .toEqual(['remote', 'surveyed']);
        expect(prior.childParcelIds).toBeUndefined();
        expect(park.childParcelIds).toBeUndefined();
        expect(cleared.mock.calls.map(([id]) => id).sort()).toEqual(['HR-A#park-1', 'HR-A#prior-1']);
        expect(persistent.has('parcel_HR-B#remote-1_owner')).toBe(true);
    });

    it('consumes generated input by deleting it, while a base input is merely hidden', () => {
        const base = feature('HR-A');
        const generated = feature('HR-A#old-1', {
            ancestorProposal: 'old',
            baseParcelIds: ['HR-A']
        });
        const baseLayer = layer(base);
        const generatedLayer = layer(generated);
        const byId = new Map([['HR-A', baseLayer], ['HR-A#old-1', generatedLayer]]);
        const cache = new Map(byId);
        const hidden = vi.fn();
        const removed = vi.fn();

        install('window', {
            parcelLayerById: byId,
            ParcelsState: { getParcelCache: () => ({ byId: cache }) },
            hideParcelLayerById: hidden,
            removeParcelLayerById: removed
        });
        install('clearPersistedParcelRecord', vi.fn());

        ProposalManager._consumeFeaturesFromLiveFabric([base, generated]);

        expect(hidden).toHaveBeenCalledWith('HR-A');
        expect(removed).toHaveBeenCalledWith('HR-A#old-1');
        expect(byId.has('HR-A')).toBe(true);
        expect(byId.has('HR-A#old-1')).toBe(false);
        expect(cache.has('HR-A#old-1')).toBe(false);
    });
});

describe('generated parcel provenance', () => {
    it('writes one-hop producer metadata while flattening every land reference to cadastre', () => {
        const child = feature('temporary', {
            proposalId: 'new-plan',
            ancestorProposal: 'legacy-plan',
            rootParcelId: 'HR-A',
            rootParcelNumber: '1',
            baseParcelIds: ['HR-A#old-1']
        });
        install('window', { __formationEdit: formationEdit });

        ProposalManager._assignSyntheticChildIdentities('new-plan', [child]);

        expect(child.properties.baseParcelIds).toEqual(['HR-A']);
        expect(child.properties.parentParcelIds).toEqual(['HR-A']);
        expect(child.properties.parentParcelId).toBe('HR-A');
        expect(child.properties.producedByProposalId).toBe('new-plan');
        expect(child.properties).not.toHaveProperty('ancestorProposal');
    });
});

describe('proposal-owned output release', () => {
    it('removes current producedByProposalId output and leaves another proposal on the same base untouched', () => {
        const base = layer(feature('HR-A'));
        const mine = layer(feature('HR-A#mine-1', {
            producedByProposalId: 'park',
            proposalId: 'park',
            baseParcelIds: ['HR-A']
        }));
        const road = layer(feature('HR-A#road-1', {
            producedByProposalId: 'road',
            proposalId: 'road',
            baseParcelIds: ['HR-A']
        }));
        const byId = new Map([
            ['HR-A', base],
            ['HR-A#mine-1', mine],
            ['HR-A#road-1', road]
        ]);
        const cache = new Map(byId);
        const live = new Set([mine, road]);
        const record = { proposalId: 'park', childParcelIds: ['HR-A#mine-1'] };

        install('window', {
            parcelLayerById: byId,
            parcelLayer: { hasLayer: entry => live.has(entry) },
            ParcelsState: { getParcelCache: () => ({ byId: cache }) },
            removeParcelLayerById: id => live.delete(byId.get(String(id))),
            parks: [
                { properties: { proposalId: 'park' } },
                { properties: { proposalId: 'other' } }
            ],
            squares: [], lakes: [], transitStations: [], proposedBuildings: []
        });

        const manager = { _clearDerivedRecordState: ProposalManager._clearDerivedRecordState };
        const removed = ProposalManager._removeProposalOwnedOutput.call(manager, record);

        expect(removed.removedParcelIds).toEqual(['HR-A#mine-1']);
        expect([...byId.keys()].sort()).toEqual(['HR-A', 'HR-A#road-1']);
        expect(cache.has('HR-A#mine-1')).toBe(false);
        expect(cache.has('HR-A#road-1')).toBe(true);
        expect(live.has(road)).toBe(true);
        expect(globalThis.window.parks.map(item => item.properties.proposalId)).toEqual(['other']);
        expect(record.childParcelIds).toBeUndefined();
    });

    it('rederives only the four seed anchors even when one belongs to a 661-parcel track', async () => {
        const parkBases = ['HR-330264-574', 'HR-330264-576', 'HR-330264-575', 'HR-330264-5940'];
        const trackBases = ['HR-330264-5940', ...Array.from({ length: 660 }, (_, i) => `HR-TRACK-${i}`)];
        const remoteBuildings = Array.from({ length: 165 }, (_, i) => ({
            proposalId: `building-${i}`,
            applied: true,
            cadastreParcelIds: [`HR-REMOTE-${i}`]
        }));
        const park = { proposalId: 'park', applied: false, cadastreParcelIds: parkBases };
        const track = { proposalId: 'track', applied: true, cadastreParcelIds: trackBases };
        const derive = vi.fn(async options => ({
            added: 2, removed: 1, unchanged: 3,
            parcels: options.parcelIds.length,
            parcelIds: options.parcelIds,
            failed: []
        }));
        const rebuildPass = vi.fn();
        const appliedTakes = vi.fn(() => [{ id: 'track', geometry: { type: 'Polygon', coordinates: [] } }]);
        const removed = vi.fn(() => ({ proposalId: 'park', removedParcelIds: ['park-child'], ownership: new Map() }));
        const hideParcelInfoPanel = vi.fn();
        const updateSelectionUI = vi.fn();

        install('window', {
            showParcelLayerById: vi.fn(),
            hideParcelLayerById: vi.fn(),
            selectedParcelId: 'park-child',
            currentParcel: { id: 'park-child' },
            selectedParcelInProposal: 'park-child',
            multiParcelSelection: {
                selectedParcels: new Set(['park-child', 'still-live']),
                lastSelectedParcelId: 'park-child',
                updateUI: updateSelectionUI
            },
            hideParcelInfoPanel
        });
        install('proposalStorage', { getAllProposals: () => [track, ...remoteBuildings] });
        const manager = {
            _flatScopeSeeds: vi.fn(),
            _removeProposalOwnedOutput: removed,
            _deriveCorridorFabric: derive,
            _appliedCorridorTakes: appliedTakes,
            _parcelsClaimedByDerivedGround: () => new Set(),
            _commitRemovedProposalOutput: vi.fn(),
            _rebuildPass: rebuildPass,
            _releaseProposalLocally: ProposalManager._releaseProposalLocally
        };

        const result = await manager._releaseProposalLocally(park, {
            scope: { complete: true, baseParcelIds: parkBases }
        });

        expect(result.ok).toBe(true);
        expect(result.baseParcelIds).toEqual(parkBases);
        expect(derive).toHaveBeenCalledOnce();
        expect(derive.mock.calls[0][0].parcelIds).toEqual(parkBases);
        expect(derive.mock.calls[0][0].parcelIds).not.toContain('HR-TRACK-0');
        expect(appliedTakes).toHaveBeenCalledOnce();
        expect(rebuildPass).not.toHaveBeenCalled();
        expect(removed).toHaveBeenCalledWith(park);
        expect(globalThis.window.selectedParcelId).toBeNull();
        expect(globalThis.window.currentParcel).toBeNull();
        expect(globalThis.window.selectedParcelInProposal).toBeNull();
        expect([...globalThis.window.multiParcelSelection.selectedParcels]).toEqual(['still-live']);
        expect(globalThis.window.multiParcelSelection.lastSelectedParcelId).toBe('still-live');
        expect(updateSelectionUI).toHaveBeenCalledOnce();
        expect(hideParcelInfoPanel).toHaveBeenCalledOnce();
    });

    it('commits unapply state before restoring its recorded cadastral scope', async () => {
        const park = {
            proposalId: 'park',
            applied: true,
            cadastreParcelIds: ['HR-A'],
            structureProposal: { kind: 'park' }
        };
        const records = new Map([['park', park]]);
        const release = vi.fn(async (_record, options) => ({
            ok: !!options._mutationTransaction,
            baseParcelIds: ['HR-A'],
            failed: []
        }));
        const storage = {
            proposals: records,
            beginBatch: vi.fn(), endBatch: vi.fn(), save: vi.fn(), _indexProposal: vi.fn(),
            getProposal: id => records.get(String(id)) || null
        };
        const startParcelWrites = vi.fn();
        const flushParcelWrites = vi.fn();
        const discardParcelWrites = vi.fn();
        install('proposalStorage', storage);
        install('setProposalApplied', setProposalApplied);
        install('window', {
            parcelLayerById: new Map(), parks: [], squares: [], lakes: [], transitStations: [], proposedBuildings: [],
            isParcelWriteBatchActive: () => false,
            _startParcelWriteCache: startParcelWrites,
            _flushParcelWriteCache: flushParcelWrites,
            _discardParcelWriteCache: discardParcelWrites
        });

        const manager = {
            _rebuildInProgress: false,
            _enqueueFabricChange: fn => fn(),
            _recordedCadastreScope: vi.fn(() => ({ complete: true, baseParcelIds: ['HR-A'] })),
            _flatScopeSeeds: vi.fn(() => { throw new Error('unapply must not inspect map geometry'); }),
            _loadReplayGround: vi.fn(async () => 0),
            _clearDerivedRecordState: ProposalManager._clearDerivedRecordState,
            _unapplyProposalTransactionBody: ProposalManager._unapplyProposalTransactionBody,
            _releaseProposalLocally: release,
            _refreshUIAfterProposalChange: vi.fn(),
            unapplyProposal: ProposalManager.unapplyProposal
        };

        await expect(manager.unapplyProposal('park')).resolves.toBe(true);

        expect(park.applied).toBe(false);
        expect(release).toHaveBeenCalledOnce();
        expect(release.mock.calls[0][0]).toBe(park);
        expect(release.mock.calls[0][1].scope.baseParcelIds).toEqual(['HR-A']);
        expect(manager._flatScopeSeeds).not.toHaveBeenCalled();
        expect(manager._loadReplayGround).toHaveBeenCalledWith([park], expect.objectContaining({ purpose: 'unapply' }));
        expect(storage.beginBatch).toHaveBeenCalledTimes(2);
        expect(storage.endBatch).toHaveBeenCalledTimes(2);
        // Only the independent restoration transaction may touch map presentation. The state
        // transaction must not snapshot or batch parcel layers merely to flip `applied` to false.
        expect(startParcelWrites).toHaveBeenCalledOnce();
        expect(flushParcelWrites).toHaveBeenCalledOnce();
        expect(discardParcelWrites).not.toHaveBeenCalled();
    });

    it('keeps the proposal unapplied when local parcel restoration fails', async () => {
        const building = {
            proposalId: 'building', applied: true, cadastreParcelIds: ['HR-A'],
            buildingProposal: { type: 'block' }
        };
        const records = new Map([['building', building]]);
        const storage = {
            proposals: records,
            beginBatch: vi.fn(), endBatch: vi.fn(), save: vi.fn(), _indexProposal: vi.fn(),
            getProposal: id => records.get(String(id)) || null
        };
        install('proposalStorage', storage);
        install('setProposalApplied', setProposalApplied);
        install('window', { parcelLayerById: new Map(), parks: [], squares: [], lakes: [], transitStations: [], proposedBuildings: [] });
        const manager = {
            _rebuildInProgress: false,
            _enqueueFabricChange: fn => fn(),
            _recordedCadastreScope: () => ({ complete: true, baseParcelIds: ['HR-A'] }),
            _loadReplayGround: vi.fn(async () => 0),
            _clearDerivedRecordState: ProposalManager._clearDerivedRecordState,
            _unapplyProposalTransactionBody: ProposalManager._unapplyProposalTransactionBody,
            _releaseProposalLocally: vi.fn(async () => ({ ok: false, failed: [{ reason: 'clip failed' }] })),
            _refreshUIAfterProposalChange: vi.fn(),
            unapplyProposal: ProposalManager.unapplyProposal
        };

        await expect(manager.unapplyProposal('building')).resolves.toBe(true);

        expect(building.applied).toBe(false);
        expect(manager._releaseProposalLocally).toHaveBeenCalledOnce();
    });

    it('reconstructs clickable corridor pieces under a removed park without touching remote output', async () => {
        const baseFeature = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]], {
            parcelId: 'HR-A', PARCEL_ID: 'HR-A', BROJ_CESTICE: '1'
        });
        const ribbon = turf.polygon([[[0.0004, -0.0002], [0.0006, -0.0002], [0.0006, 0.0012], [0.0004, 0.0012], [0.0004, -0.0002]]]);
        const baseLayer = layer(baseFeature);
        const parkLayer = layer(feature('HR-A#park-1', {
            producedByProposalId: 'park', proposalId: 'park', baseParcelIds: ['HR-A']
        }));
        const remoteLayer = layer(feature('HR-B#remote-1', {
            producedByProposalId: 'remote', proposalId: 'remote', baseParcelIds: ['HR-B']
        }));
        const byId = new Map([
            ['HR-A', baseLayer],
            ['HR-A#park-1', parkLayer],
            ['HR-B#remote-1', remoteLayer]
        ]);
        const visible = new Set([parkLayer, remoteLayer]);
        const cache = new Map(byId);
        const win = {
            parcelLayerById: byId,
            parcelLayer: { hasLayer: entry => visible.has(entry) },
            ParcelsState: { getParcelCache: () => ({ byId: cache }) },
            __parcelArrangement: arrangement,
            __cadastreAncestry: { loadedCadastreParcels: () => [{ id: 'HR-A', feature: baseFeature }] },
            removeParcelLayerById: id => visible.delete(byId.get(String(id))),
            showParcelLayerById: id => { const entry = byId.get(String(id)); if (entry) visible.add(entry); },
            hideParcelLayerById: id => { const entry = byId.get(String(id)); if (entry) visible.delete(entry); },
            yieldToBrowser: async () => {},
            parks: [{ properties: { proposalId: 'park' } }],
            squares: [], lakes: [], transitStations: [], proposedBuildings: []
        };
        install('window', win);
        install('turf', turf);
        install('isSyntheticParcelId', id => String(id).includes('#'));

        const manager = {
            _clearDerivedRecordState: ProposalManager._clearDerivedRecordState,
            _removeProposalOwnedOutput: ProposalManager._removeProposalOwnedOutput,
            _commitRemovedProposalOutput: vi.fn(),
            _appliedCorridorTakes: () => [{ id: 'road', geometry: ribbon.geometry }],
            _deriveCorridorFabric: ProposalManager._deriveCorridorFabric,
            _deriveCorridorFabricBody: ProposalManager._deriveCorridorFabricBody,
            _parcelsClaimedByDerivedGround: ProposalManager._parcelsClaimedByDerivedGround,
            _addFeaturesToMap: async features => {
                features.forEach(value => {
                    const id = String(value.properties.parcelId);
                    const entry = layer(value);
                    byId.set(id, entry);
                    cache.set(id, entry);
                    visible.add(entry);
                });
            },
            _releaseProposalLocally: ProposalManager._releaseProposalLocally
        };
        const park = { proposalId: 'park', applied: false, cadastreParcelIds: ['HR-A'], childParcelIds: ['HR-A#park-1'] };

        const result = await manager._releaseProposalLocally(park, {
            scope: { complete: true, baseParcelIds: ['HR-A'] }
        });

        const localPieces = [...byId.keys()].filter(id => arrangement.isPieceId(id));
        expect(result.ok).toBe(true);
        expect(byId.has('HR-A#park-1')).toBe(false);
        expect(localPieces.length).toBeGreaterThan(0);
        expect(localPieces.every(id => visible.has(byId.get(id)))).toBe(true);
        expect(visible.has(baseLayer)).toBe(false);
        const roadPieces = localPieces
            .map(id => byId.get(id).feature)
            .filter(value => value.properties.isCorridor === true);
        const landPieces = localPieces
            .map(id => byId.get(id).feature)
            .filter(value => value.properties.isCorridor !== true);
        expect(roadPieces.length).toBeGreaterThan(0);
        expect(landPieces.length).toBeGreaterThan(0);
        for (const roadPiece of roadPieces) {
            for (const landPiece of landPieces) {
                const overlap = turf.intersect(roadPiece, landPiece);
                expect(overlap ? turf.area(overlap) : 0).toBeLessThan(0.05);
            }
        }
        expect(byId.get('HR-B#remote-1')).toBe(remoteLayer);
        expect(visible.has(remoteLayer)).toBe(true);
    });
});

describe('flat local materialization', () => {
    it('re-stamps every declaration from loaded cadastral geometry and removes generated ids', () => {
        const footprint = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]);
        const record = {
            proposalId: 'legacy-road',
            goal: 'road-track',
            cadastreParcelIds: ['HR-OLD#dead-1'],
            parentParcelIds: ['HR-OLD#dead-1'],
            roadProposal: {
                parentParcelIds: ['HR-OLD#dead-1'],
                definition: { polygon: footprint.geometry }
            }
        };
        install('__planOrder', planOrder);
        install('turf', turf);
        install('window', {
            __planOrder: planOrder,
            __cadastreAncestry: {
                loadedCadastreCoverage: () => ({ ids: ['HR-A#old-7', 'HR-B'], coverage: 1 })
            }
        });

        const result = ProposalManager._resolveAndStampFlatCadastreAnchors(record);

        expect(result).toEqual({ baseParcelIds: ['HR-A', 'HR-B'], complete: true });
        expect(record.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(record.parentParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(record.roadProposal.parentParcelIds).toEqual(['HR-A', 'HR-B']);
    });

    it('does not replace a durable stamp from incomplete loaded geometry', () => {
        const footprint = turf.polygon([[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]);
        const record = {
            proposalId: 'partly-loaded',
            cadastreParcelIds: ['HR-A'],
            geometry: footprint.geometry
        };
        install('__planOrder', planOrder);
        install('turf', turf);
        install('window', {
            __planOrder: planOrder,
            __cadastreAncestry: {
                loadedCadastreCoverage: () => ({ ids: ['HR-B'], coverage: 0.8 })
            }
        });

        const result = ProposalManager._resolveAndStampFlatCadastreAnchors(record);

        expect(result).toEqual({ baseParcelIds: ['HR-A'], complete: false });
        expect(record.cadastreParcelIds).toEqual(['HR-A']);
        expect(record.parentParcelIds).toBeUndefined();
    });

    it('materializes only the named seed and never expands through shared cadastral ids', async () => {
        const square = west => turf.polygon([[[west, 0], [west + 0.001, 0], [west + 0.001, 0.001], [west, 0.001], [west, 0]]]);
        const records = [
            { proposalId: 'on-a', applied: true, createdAt: '2026-01-01', cadastreParcelIds: ['HR-A'] },
            { proposalId: 'bridge', applied: true, createdAt: '2026-01-02', cadastreParcelIds: ['HR-A', 'HR-B'] },
            {
                proposalId: 'road-b', applied: true, createdAt: '2026-01-03', goal: 'road-track',
                cadastreParcelIds: ['HR-B'], roadProposal: { definition: { polygon: square(0).geometry } }
            },
            { proposalId: 'remote', applied: true, createdAt: '2026-01-04', cadastreParcelIds: ['HR-C'] }
        ];
        const derive = vi.fn(async options => ({ parcelIds: options.parcelIds, failed: [] }));
        const apply = vi.fn(async id => {
            const record = records.find(item => item.proposalId === String(id));
            record.applied = true;
            return true;
        });

        install('__planOrder', planOrder);
        install('turf', turf);
        install('window', { __planOrder: planOrder, CityConfigManager: null });
        install('setProposalApplied', setProposalApplied);
        install('isProposalCurrentlyApplied', record => record.applied === true);
        install('proposalStorage', {
            getAllProposals: () => records,
            getProposal: id => records.find(record => record.proposalId === String(id)) || null,
            beginBatch: vi.fn(), endBatch: vi.fn(), save: vi.fn()
        });

        const manager = {
            _rebuildInProgress: false,
            _flatScopeSeeds: vi.fn(async () => ({ baseParcelIds: ['HR-A'], complete: true })),
            _appliedCorridorTakes: vi.fn(() => [{ id: 'road-b', geometry: square(0).geometry }]),
            _removeProposalOwnedOutput: vi.fn(record => ({
                proposalId: String(record.proposalId), removedParcelIds: [], ownership: new Map()
            })),
            _commitRemovedProposalOutput: vi.fn(),
            _deriveCorridorFabric: derive,
            applyProposal: apply,
            getLastApplyFailure: vi.fn(),
            _rematerializeResolvedScope: ProposalManager._rematerializeResolvedScope,
            rematerializeFlatScope: ProposalManager.rematerializeFlatScope
        };

        const result = await manager.rematerializeFlatScope([records[0]], { _fabricQueue: true });

        expect(result.ok).toBe(true);
        expect(result.baseParcelIds).toEqual(['HR-A']);
        expect(result.proposalIds).toEqual(['on-a']);
        expect(derive).toHaveBeenCalledWith({
            parcelIds: ['HR-A'],
            takes: [{ id: 'road-b', geometry: square(0).geometry }]
        });
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith('on-a', { replay: true, deferPresentation: false });
        expect(manager._removeProposalOwnedOutput).toHaveBeenCalledTimes(1);
        expect(manager._removeProposalOwnedOutput).not.toHaveBeenCalledWith(records[1]);
        expect(manager._removeProposalOwnedOutput).not.toHaveBeenCalledWith(records[2]);
        expect(manager._removeProposalOwnedOutput).not.toHaveBeenCalledWith(records[3]);
    });

    it('refuses and never falls back to a whole-plan rebuild when local coverage is incomplete', async () => {
        const rebuildAppliedFabric = vi.fn(async () => ({ ok: true, applied: 3, failed: [] }));
        const manager = {
            _flatScopeSeeds: vi.fn(async () => ({ baseParcelIds: ['HR-A'], complete: false })),
            rebuildAppliedFabric,
            rematerializeFlatScope: ProposalManager.rematerializeFlatScope
        };

        const result = await manager.rematerializeFlatScope([{ proposalId: 'p' }], { _fabricQueue: true, silent: true });

        expect(result.ok).toBe(false);
        expect(result.failed[0].reason).toBe('cadastral ground is incomplete');
        expect(rebuildAppliedFabric).not.toHaveBeenCalled();
    });
});

describe('unapply contract', () => {
    it('uses proposal-owned local release instead of flat-component replay', () => {
        const source = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');
        const start = source.indexOf('async unapplyProposal(proposalId, options = {})');
        const end = source.indexOf('async _unapplyProposalTransactionBody', start);
        const unapply = source.slice(start, end);
        expect(unapply).toContain('_releaseProposalLocally');
        expect(unapply).toContain('_recordedCadastreScope');
        expect(unapply).not.toContain('_flatScopeSeeds');
        expect(unapply).not.toContain('rematerializeFlatScope');
        expect(unapply).not.toContain('rebuildAppliedFabric');
        expect(unapply).not.toContain('_rebuildPass');
    });
});
