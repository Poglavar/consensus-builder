// Local persistence is the authored proposal log, not a saved browser replay. Derived child ids,
// formation receipts and demolition scans must never survive a reload as apparent prerequisites.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const formationDepth = require('../../frontend/js/proposals/formation-depth.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
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
    install('PersistentStorage', {
        getItem: key => persisted.get(key) || null,
        setItem: (key, value) => persisted.set(key, String(value)),
        removeItem: key => persisted.delete(key)
    });
    const api = (0, eval)(dataSource + '\n;({ proposalStorage, proposalWithAuthoredSelection })');
    return { storage: api.proposalStorage, proposalWithAuthoredSelection: api.proposalWithAuthoredSelection, persisted };
}

describe('proposalStorage authored-log persistence', () => {
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

        const stored = JSON.parse(persisted.get('cadastre_proposals')).records[0];
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
        expect(persisted.has('cadastre_proposals')).toBe(false);
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

        const stored = JSON.parse(persisted.get('cadastre_proposals')).records[0];
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
});
