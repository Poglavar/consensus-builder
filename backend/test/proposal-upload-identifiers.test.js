import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const createSource = readFileSync(new URL('../../frontend/js/proposals/create.js', import.meta.url), 'utf8');

function loadBuildUploadReadyProposal({ fingerprint }) {
    const start = createSource.indexOf('function buildUploadReadyProposal(proposal) {');
    const end = createSource.indexOf('\nfunction handleCreateProposalHotkey(event)', start);
    if (start < 0 || end < 0) throw new Error('Could not isolate buildUploadReadyProposal.');

    const context = {
        stampCurrentAuthor: proposal => proposal,
        proposalStorage: { getProposal: () => null },
        resolveProposalGoalKey: proposal => proposal.goal,
        mapGoalToBackendType: () => 'structure',
        getProposalCityId: () => 'test-city',
        proposalContentFingerprint: () => fingerprint,
        window: null
    };
    context.window = context;
    context.ProposalLineage = { publishedSourceIds: () => ({}) };
    context.__cadastreAncestry = {
        validateCadastreParcelIds: ({ cadastreParcelIds }) => cadastreParcelIds,
        publishDeclaration: proposal => proposal.cadastreParcelIds,
        computeOwnershipFlow: () => []
    };
    context.__siteBinding = { requiresParcels: () => true };
    context.__publishBinding = { isServerBinding: () => false };
    context.__formationDepth = {
        preparePublishRecord: proposal => ({ verdict: { flat: true, violations: [] }, proposal })
    };
    vm.runInNewContext(`${createSource.slice(start, end)}\nthis.buildUploadReadyProposal = buildUploadReadyProposal;`, context);
    return context.buildUploadReadyProposal;
}

const sourceRecord = () => ({
    id: 417,
    proposal_id: 'legacy-authored-alias',
    proposalId: 'local-proposal-9',
    goal: 'park',
    type: 'structure',
    city: 'test-city',
    cadastreParcelIds: ['HR-1'],
    applied: false,
    localPurchaseSimulation: { buyerAgentId: 'buyer', simulatedAt: 'now', cadastreParcelIds: ['HR-1'] }
});

describe('buildUploadReadyProposal identifiers', () => {
    it('removes row and snake-case aliases while publishing the canonical content fingerprint', () => {
        const original = sourceRecord();
        const before = structuredClone(original);
        const upload = loadBuildUploadReadyProposal({ fingerprint: 'content-sha256:authored-fingerprint' })(original);

        expect(upload).not.toHaveProperty('id');
        expect(upload).not.toHaveProperty('localPurchaseSimulation');
        expect(upload).not.toHaveProperty('proposal_id');
        expect(upload.proposalId).toBe('content-sha256:authored-fingerprint');
        expect(original).toEqual(before);
    });

    it('keeps a nonnumeric authored proposalId when no content fingerprint is available', () => {
        const original = sourceRecord();
        const before = structuredClone(original);
        const upload = loadBuildUploadReadyProposal({ fingerprint: null })(original);

        expect(upload).not.toHaveProperty('id');
        expect(upload).not.toHaveProperty('localPurchaseSimulation');
        expect(upload).not.toHaveProperty('proposal_id');
        expect(upload.proposalId).toBe('local-proposal-9');
        expect(original).toEqual(before);
    });
});
