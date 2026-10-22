// Tests for backend/proposals/archive-state.js: what an authored record keeps when it leaves a browser or a
// database (stripLocalProposalState) and the archive form of a reconstruction (stripProposalArchiveState),
// shared by the reconstruction archive codecs and the proposal row serializer, plus the refusal of a
// record from an older version (invalidRecord).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
    PROPOSAL_RECORD_INVALID, PROPOSAL_RECORD_INVALID_MESSAGE, invalidRecord, stripLocalProposalState, stripProposalArchiveState
} from '../proposals/archive-state.js';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');

const square = (x, y, size = 0.001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
const DESIGN_CID = Cid.cidOfObject({ schema: 'design/v1', goal: 'park', title: 'Source park' });

// Everything a browser adds to an authored building record while it is applied and decided on.
function appliedBuilding() {
    return {
        proposalId: 'p-local-7', title: 'Corner block', goal: 'buildings', city: 'zagreb', createdAt: '2026-08-13T00:00:00.000Z',
        approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' } },
        applied: true, appliedAt: '2026-10-01T10:00:00.000Z', status: 'applied', localEditAt: 7, editSeq: 3, revertSnapshot: { x: 1 },
        localPurchaseSimulation: { cents: 1 }, executedAt: '2026-10-02T00:00:00.000Z', publicationApiBase: 'http://localhost:3000',
        lifecycleEvidence: { kind: 'local' }, proposalDraftId: 'draft-1', proposalDraftRevision: 2, authorAgentId: 'agent-3',
        sourceProposalId: 'p-old', replacementOfProposalId: 'p-older', copiedFromProposalId: 'p-copy', copiedFromName: 'Copy',
        childParcelIds: ['c1'], descendantParcelIds: ['d1'], parentFeatures: [{}], parentProposals: [], childProposals: [],
        parentProposalIds: [], childProposalIds: [], formation: { pieces: 2 }, demolishedBuildings: [1], demolitionScanned: true,
        parcelSourceId: 'hr-cadastre', ownerApprovals: [{ ownerId: 'a' }], ownerApprovalHistory: [], approvalState: 'collecting',
        approvalRuntimeState: {}, authorityApprovals: [], authorityApprovalHistory: [], authorityState: {}, authorityRuntimeState: {},
        acceptedParcelIds: ['HR-1'], ownerAcceptances: { 'HR-1': true }, childFeatures: [{}],
        parentParcelIds: ['HR-1'], parcelIds: ['HR-1'],
        geometry: {
            buildings: [{ type: 'Feature', properties: { height: 12, floors: 4, floorPlans: [{ level: 0 }], floorModel: { id: 'm' } }, geometry: square(15.97, 45.8) }],
            parentFeatures: [{}], childFeatures: [{}]
        },
        buildingProposal: {
            typologyType: 'single', parameters: { height: 12 }, applied: true, appliedAt: 'x', status: 'applied', childParcelIds: ['c'],
            parentFeatures: [{}], parentsToRemove: ['p'], formation: {}, demolishedBuildings: [2], demolitionScanned: true, childFeatures: [{}],
            parentParcelIds: ['HR-1']
        }
    };
}

describe('stripLocalProposalState', () => {
    it('keeps what was authored and drops every applied, local, lineage and runtime approval field', () => {
        const input = appliedBuilding();
        const before = structuredClone(input);
        const out = stripLocalProposalState(input);
        expect(input).toEqual(before);
        expect(out).toEqual({
            proposalId: 'p-local-7', title: 'Corner block', goal: 'buildings', city: 'zagreb', createdAt: '2026-08-13T00:00:00.000Z',
            // Approval configuration is authored content; decisions and their state are not.
            approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' } },
            geometry: { buildings: [{ type: 'Feature', properties: { height: 12, floors: 4 }, geometry: square(15.97, 45.8) }] },
            buildingProposal: { typologyType: 'single', parameters: { height: 12 } }
        });
    });

    it('keeps a road\'s definition in its payload and drops what applying it computed', () => {
        const out = stripLocalProposalState({
            proposalId: 'road', goal: 'road-track',
            definition: { stale: true },
            geometry: { roadPlan: {}, roadGeometry: {} },
            roadProposal: {
                roadGeometry: {}, applied: true,
                definition: { polygon: square(15.97, 45.8), surfaceFootprint: square(15.97, 45.8), demolishedBuildings: [1], demolitionScanned: true, width: 12 }
            }
        });
        expect(out).toEqual({ proposalId: 'road', goal: 'road-track', roadProposal: { definition: { polygon: square(15.97, 45.8), width: 12 } } });
        // A road with other geometry keeps it.
        const kept = stripLocalProposalState({ roadProposal: { definition: { width: 9 } }, geometry: { roadPlan: {}, note: 'kept' } });
        expect(kept.geometry).toEqual({ note: 'kept' });
    });

    it('makes the origin portable: a design CID stays, a browser key never travels', () => {
        const design = stripLocalProposalState({ proposalId: 'fork', proposalOrigin: { relation: 'copy', source: { kind: 'design', cid: DESIGN_CID }, title: ' Source park ' } });
        expect(design.proposalOrigin).toEqual({ relation: 'copy', source: { kind: 'design', cid: DESIGN_CID }, title: 'Source park' });
        const local = stripLocalProposalState({ proposalId: 'fork', proposalOrigin: { relation: 'revision', source: { kind: 'local', localProposalId: 'p-9' }, title: 'Mine' } });
        expect(local.proposalOrigin).toEqual({ relation: 'revision', source: null, title: 'Mine' });
    });

    it('refuses a record from an older version by name: an origin naming a server row', () => {
        let error;
        try {
            stripLocalProposalState({ proposalId: 'old', proposalOrigin: { relation: 'revision', source: { kind: 'server', proposalId: 41 } } });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ code: PROPOSAL_RECORD_INVALID, status: 422, message: PROPOSAL_RECORD_INVALID_MESSAGE });
        expect(error.detail).toMatch(/^Invalid proposal record: proposalOrigin: A proposal origin requires a local key or a design CID/);
        expect(() => stripLocalProposalState({ proposalOrigin: { relation: 'fork' } })).toThrow(PROPOSAL_RECORD_INVALID_MESSAGE);
    });

    it('checks pinned source references instead of following the latest one', () => {
        const reference = { proposalId: 'source:gup-1', providerId: 'zagreb-gup', recordId: 'r1', edition: '2016', revision: '3', city: 'zagreb', parcelId: null, scenario: 'adopted' };
        expect(stripLocalProposalState({ proposalId: 'x', sourceReferences: [reference] }).sourceReferences).toEqual([reference]);
        expect(() => stripLocalProposalState({ proposalId: 'x', sourceReferences: [{ ...reference, proposalId: 'gup-1' }] })).toThrow('Invalid or duplicate source reference');
        expect(() => stripLocalProposalState({ proposalId: 'x', sourceReferences: [reference, reference] })).toThrow('Invalid or duplicate source reference');
    });

    it('passes through what is not a record', () => {
        expect(stripLocalProposalState(null)).toBeNull();
        expect(stripLocalProposalState('text')).toBe('text');
        const list = [1, 2];
        expect(stripLocalProposalState(list)).toBe(list);
    });
});

describe('stripProposalArchiveState', () => {
    it('also drops the source database identities and the agent claim', () => {
        const out = stripProposalArchiveState({ ...appliedBuilding(), id: 633, serverProposalId: 633, agent: { name: 'densifier-01' } });
        expect(out).not.toHaveProperty('id');
        expect(out).not.toHaveProperty('serverProposalId');
        expect(out).not.toHaveProperty('agent');
        expect(out).toEqual(stripLocalProposalState(appliedBuilding()));
        expect(stripProposalArchiveState(null)).toBeNull();
    });
});

describe('invalidRecord', () => {
    it('is a 422 a person can read, with the technical reason kept for logs', () => {
        const error = invalidRecord('row 5: missing goal');
        expect(error).toMatchObject({ code: 'proposal-record-invalid', status: 422, detail: 'row 5: missing goal' });
        expect(error.message).toBe('This proposal was made with an older version of the site and can no longer be opened.');
    });
});
