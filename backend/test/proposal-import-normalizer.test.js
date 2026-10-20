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
            cadastreParcelIds: ['10'],
            buildingProposal: {
                applied: true,
                status: 'executed',
                parameters: { floors: 4 }
            }
        });

        expect(imported.lifecycleStatus).toBe('Executed');
        expect(imported.applied).toBe(false);
        expect(imported).not.toHaveProperty('status');
        expect(imported.buildingProposal).not.toHaveProperty('applied');
        expect(imported.buildingProposal).not.toHaveProperty('status');
        expect(imported.cadastreParcelIds).toEqual(['10']);
        expect(imported).not.toHaveProperty('parentParcelIds');
        expect(imported.coordinatedPlanId).toBe('district-plan');
    });

    it('requires an explicit row field rather than inferring publication from an authored or local ID', () => {
        for (const proposalId of ['42', 'authored-local']) {
            const imported = prepareProposalForImport({ proposalId, goal: 'as-is', cadastreParcelIds: ['source-a'] });
            expect(imported.serverProposalId).toBeNull();
        }
        expect(prepareProposalForImport({ proposalId: 'authored', id: 42, cadastreParcelIds: ['source-a'] }).serverProposalId).toBeNull();
        expect(prepareProposalForImport({ proposalId: 'authored', id: 42, publicationApiBase: 'https://api.example.test', cadastreParcelIds: ['source-a'] }).serverProposalId).toBe('42');
        expect(normalizeServerProposalSummary({ proposalId: 'authored', title: 'Missing row', goal: 'as-is' }, 'test-city'))
            .toMatchObject({ proposalId: 'authored', id: null, serverProposalId: null });
    });

    it('does not turn a legacy map-application word into lifecycle evidence', () => {
        const imported = prepareProposalForImport({
            proposalId: 'legacy-road',
            status: 'applied',
            cadastreParcelIds: ['p-1'],
            roadProposal: {
                applied: true,
                status: 'applied',
                definition: { width: 8, points: [] }
            }
        });

        expect(imported.lifecycleStatus).toBe('Unknown');
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
            cadastreParcelIds: ['HR-1', 'HR-2'],
            geometry: { buildings: [blockMassing], blockMassing },
            buildingProposal: {
                typologyType: 'block',
                blockName: 'Block 1',
                ineligibleParcels: [{
                    status: 'below-min-plot',
                    geometry: blockMassing.geometry,
                    wouldBe: blockMassing
                }]
            }
        });

        expect(imported.typologyType).toBe('block');
        expect(imported.buildingProposal.ineligibleParcels).toEqual([
            { status: 'below-min-plot', geometry: blockMassing.geometry, wouldBe: blockMassing }
        ]);
        expect(imported.buildingProposal).not.toHaveProperty('blockParcelIds');
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
        })).toThrow(/missing-cadastral-provenance.*legacy-cadastral-declaration/);
    });

    it('refuses a compatibility alias even when it duplicates canonical ground', () => {
        expect(() => prepareProposalForImport({
            proposalId: 'legacy-duplicate',
            goal: 'park',
            cadastreParcelIds: ['HR-1'],
            parentParcelIds: ['HR-1'],
            structureProposal: { kind: 'park', geometry: { type: 'Polygon', coordinates: [] } }
        })).toThrow(/legacy-cadastral-declaration/);
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

    it('does not infer a semantic goal from a backend type or identifier alias', () => {
        const summary = normalizeServerProposalSummary({ id: 7, proposalId: 'p-7', type: 'road' }, 'zagreb');
        expect(summary.goal).toBeNull();
        expect(summary.serverProposalId).toBe('7');
        const imported = prepareProposalForImport({ proposalId: 'authored-7', type: 'road', cadastreParcelIds: ['HR-1'] });
        expect(imported.goal).toBeNull();
        expect(imported.serverProposalId).toBeNull();
    });
});
