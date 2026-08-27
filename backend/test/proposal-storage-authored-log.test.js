// Local persistence is the authored proposal log, not a saved browser replay. Derived child ids,
// formation receipts and demolition scans must never survive a reload as apparent prerequisites.
import { afterEach, describe, expect, it } from 'vitest';
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
    const storage = (0, eval)(dataSource + '\n;proposalStorage');
    return { storage, persisted };
}

describe('proposalStorage authored-log persistence', () => {
    it('persists flat cadastral declarations and strips all materialization output without mutating runtime state', () => {
        const { storage, persisted } = bootStore();
        const record = {
            proposalId: 'road-1',
            goal: 'road-track',
            applied: true,
            cadastreParcelIds: ['HR-A#old-1', 'HR-B'],
            parentParcelIds: ['HR-A#old-1'],
            childParcelIds: ['HR-A#road-1'],
            parentFeatures: [{ type: 'Feature' }],
            editSeq: 4,
            roadProposal: {
                parentParcelIds: ['HR-A#old-1'],
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

        const stored = JSON.parse(persisted.get('cadastre_proposals'))[0];
        expect(stored.applied).toBe(true);
        expect(stored.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(stored.parentParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(stored.roadProposal.parentParcelIds).toEqual(['HR-A', 'HR-B']);
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
});
