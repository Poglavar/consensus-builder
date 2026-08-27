// Flat cadastral-component rematerialization.
//
// Durable state has two sides only: original cadastral parcels and authored proposal records.
// Generated parcels are disposable replay output. A mutation finds the connected component in the
// base-parcel <-> standing-proposal graph, purges every generated layer in that component, and
// replays its records in plan order. These tests prevent the retired hidden-parent undo model from
// returning.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
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

describe('flat connected-component replay', () => {
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

    it('expands transitively through base parcels but leaves an unrelated component untouched', async () => {
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
        const removedPark = { proposalId: 'park-old', applied: false, cadastreParcelIds: ['HR-A'] };
        const rebuildPass = vi.fn(async members => ({ ok: true, applied: members.length, failed: [] }));

        install('__planOrder', planOrder);
        install('turf', turf);
        install('window', { __planOrder: planOrder, CityConfigManager: null });
        install('isProposalCurrentlyApplied', record => record.applied === true);
        install('proposalStorage', {
            getAllProposals: () => records,
            getProposal: id => records.find(record => record.proposalId === String(id)) || null,
            beginBatch: vi.fn(), endBatch: vi.fn(), save: vi.fn()
        });

        const manager = {
            _rebuildInProgress: false,
            _flatScopeSeeds: vi.fn(async () => ({ baseParcelIds: ['HR-A'], complete: true })),
            _orderedStandingProposals: ProposalManager._orderedStandingProposals,
            _appliedCorridorTakes: ProposalManager._appliedCorridorTakes,
            _rebuildPass: rebuildPass,
            rematerializeFlatScope: ProposalManager.rematerializeFlatScope
        };

        const result = await manager.rematerializeFlatScope([removedPark], { _fabricQueue: true });

        expect(result.ok).toBe(true);
        expect(result.baseParcelIds.sort()).toEqual(['HR-A', 'HR-B']);
        expect(result.proposalIds).toEqual(['on-a', 'bridge', 'road-b']);
        expect(rebuildPass).toHaveBeenCalledOnce();
        const [members, options] = rebuildPass.mock.calls[0];
        expect(members.map(record => record.proposalId)).toEqual(['on-a', 'bridge', 'road-b']);
        expect(options.baseParcelIds.sort()).toEqual(['HR-A', 'HR-B']);
        expect(options.resetProposalIds.sort()).toEqual(['bridge', 'on-a', 'park-old', 'road-b']);
        expect(options.corridorTakes.map(take => take.id)).toEqual(['road-b']);
        expect(options.resetProposalIds).not.toContain('remote');
    });

    it('falls back to the canonical rebuild when cadastral coverage cannot be established', async () => {
        const rebuildAppliedFabric = vi.fn(async () => ({ ok: true, applied: 3, failed: [] }));
        const manager = {
            _flatScopeSeeds: vi.fn(async () => ({ baseParcelIds: ['HR-A'], complete: false })),
            rebuildAppliedFabric,
            rematerializeFlatScope: ProposalManager.rematerializeFlatScope
        };

        const result = await manager.rematerializeFlatScope([{ proposalId: 'p' }], { _fabricQueue: true, silent: true });

        expect(result.fallback).toBe('full-rebuild');
        expect(rebuildAppliedFabric).toHaveBeenCalledWith({ _fabricQueue: true, silent: true });
    });
});

describe('one materializer', () => {
    it('contains no payload undo, ground-under restore, or corridor-specific incremental apply API', () => {
        const source = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');
        expect(source).not.toContain('_undoProposalPayload');
        expect(source).not.toContain('_deriveGroundUnder');
        expect(source).not.toContain('_releaseUnappliedRecord');
        expect(source).not.toContain('deriveCorridorIncrementally');
        expect(source).not.toContain('_offerToFreeReadjustmentGround');
        expect(source).not.toContain('_addProposalAsAncestor');
        expect(source).not.toContain('_getParcelAncestors');
        expect(source).toContain('rematerializeFlatScope');
    });
});
