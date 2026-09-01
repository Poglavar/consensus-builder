import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../../frontend/js/shared-utils.js');
const status = require('../../frontend/js/proposals/status.js');
const {
    normalizeServerProposalSummary,
    prepareProposalForImport
} = require('../../frontend/js/proposals/server-sync.js');

const GLOBAL_DEPENDENCIES = [
    'deepClone',
    'deepCloneArray',
    'ensureArrayOfStrings',
    'getLifecycleStatus',
    'normalizeLensEntries',
    'normalizeProposalGoalKey',
    'parkProposalForImport'
];

describe('proposal import boundary', () => {
    const previous = new Map();

    beforeEach(() => {
        GLOBAL_DEPENDENCIES.forEach(key => previous.set(key, globalThis[key]));
        globalThis.deepClone = shared.deepClone;
        globalThis.deepCloneArray = shared.deepCloneArray;
        globalThis.ensureArrayOfStrings = shared.ensureArrayOfStrings;
        globalThis.getLifecycleStatus = status.getLifecycleStatus;
        globalThis.parkProposalForImport = status.parkProposalForImport;
        globalThis.normalizeLensEntries = value => Array.isArray(value) ? value : [];
        globalThis.normalizeProposalGoalKey = value => String(value || '').trim().toLowerCase() || null;
    });

    afterEach(() => {
        GLOBAL_DEPENDENCIES.forEach(key => {
            const value = previous.get(key);
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        });
        previous.clear();
    });

    it('preserves lifecycle but always parks imported geometry locally', () => {
        const imported = prepareProposalForImport({
            id: 42,
            proposalId: 'shared-42',
            lifecycleStatus: 'Executed',
            applied: true,
            goal: 'buildings',
            coordinatedPlanId: 'district-plan',
            parentParcelIds: [10],
            buildingProposal: {
                applied: true,
                status: 'executed',
                parentParcelIds: [10],
                parameters: { floors: 4 }
            }
        });

        expect(imported.lifecycleStatus).toBe('Executed');
        expect(imported.applied).toBe(false);
        expect(imported).not.toHaveProperty('status');
        expect(imported.buildingProposal).not.toHaveProperty('applied');
        expect(imported.buildingProposal).not.toHaveProperty('status');
        expect(imported.parentParcelIds).toEqual(['10']);
        expect(imported.coordinatedPlanId).toBe('district-plan');
    });

    it('normalizes legacy lifecycle words without importing legacy application state', () => {
        const imported = prepareProposalForImport({
            proposalId: 'legacy-road',
            status: 'applied',
            roadProposal: {
                applied: true,
                status: 'applied',
                parentParcelIds: ['p-1']
            }
        });

        expect(imported.lifecycleStatus).toBe('Active');
        expect(imported.applied).toBe(false);
        expect(imported.roadProposal).not.toHaveProperty('applied');
        expect(imported.roadProposal).not.toHaveProperty('status');
    });

    it('preserves authored block membership and block-wide courtyard geometry', () => {
        const blockMassing = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [[15, 43], [15.01, 43], [15.01, 43.01], [15, 43.01], [15, 43]],
                    [[15.002, 43.002], [15.008, 43.002], [15.008, 43.008], [15.002, 43.008], [15.002, 43.002]]
                ]
            }
        };
        const imported = prepareProposalForImport({
            proposalId: 'shared-block',
            goal: 'buildings',
            typologyType: 'block',
            parentParcelIds: ['HR-1', 'HR-2'],
            geometry: { buildings: [blockMassing], blockMassing },
            buildingProposal: {
                typologyType: 'block',
                parentParcelIds: ['HR-1', 'HR-2'],
                blockParcelIds: ['HR-1', 'HR-2', 'HR-EDGE'],
                blockName: 'Block 1',
                ineligibleParcels: [{ parcelId: 'HR-EDGE', status: 'below-min-plot' }]
            }
        });

        expect(imported.typologyType).toBe('block');
        expect(imported.buildingProposal.blockParcelIds).toEqual(['HR-1', 'HR-2', 'HR-EDGE']);
        expect(imported.buildingProposal.ineligibleParcels).toEqual([
            { parcelId: 'HR-EDGE', status: 'below-min-plot' }
        ]);
        expect(imported.geometry.blockMassing.geometry.coordinates).toHaveLength(2);
    });

    it('refuses derived parent declarations instead of healing them during import', () => {
        expect(() => prepareProposalForImport({
            proposalId: 'legacy-derived-parent',
            goal: 'road-track',
            parentParcelIds: ['HR-1#c-old-1'],
            roadProposal: {
                parentParcelIds: ['HR-1#c-old-1'],
                definition: { width: 10, points: [] }
            }
        })).toThrow(/run migrate-tessellation\.js first/);
    });

    it('keeps server summaries lifecycle-only', () => {
        const summary = normalizeServerProposalSummary({
            id: 7,
            proposalId: 'p-7',
            lifecycleStatus: 'Cancelled',
            applied: true,
            goal: 'parcel'
        }, 'zagreb');

        expect(summary.lifecycleStatus).toBe('Cancelled');
        expect(summary).not.toHaveProperty('status');
        expect(summary).not.toHaveProperty('applied');
    });
});
