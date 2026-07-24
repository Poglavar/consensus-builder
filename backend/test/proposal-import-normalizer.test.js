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

    it('keeps server summaries lifecycle-only', () => {
        const summary = normalizeServerProposalSummary({
            id: 7,
            proposalId: 'p-7',
            status: 'Cancelled',
            applied: true,
            goal: 'parcel'
        }, 'zagreb');

        expect(summary.lifecycleStatus).toBe('Cancelled');
        expect(summary).not.toHaveProperty('status');
        expect(summary).not.toHaveProperty('applied');
    });
});
