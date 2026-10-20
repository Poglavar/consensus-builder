// Source authority, revision references and authored publication must remain separate from consent.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { gupRecord } from '../planning/providers/zagreb-gup.js';
import { stripLocalProposalState } from '../proposals/serializer.js';
import { precheckProposalCreate } from '../routes/proposals.js';
const require = createRequire(import.meta.url);
const contract = require('../../frontend/js/planning/source-proposal.js');
const chain = require('../../frontend/js/proposals/chain-record.js');
const row = { gup_id: 2025, parcel_id: 'HR-1-17', gbp_m2: 123, current: true,
    result_status: 'evidence_missing', reason: 'exception_unresolved', computed_at: '2026-10-09T00:00:00Z', floors: [] };

describe('source-backed obligatory proposal', () => {
    it('has stable provider identity and explicit authority/applicability without an authored deal or fabricated validity dates', () => {
        const item = gupRecord(row), proposal = item.proposal;
        expect(item.proposalId).toBe(proposal.proposalId);
        expect(proposal).toMatchObject({ schemaVersion: 'source-proposal.v1', proposalClass: 'obligatory-source', decisionKind: null, readOnly: true,
            authority: { effect: 'obligatory', basis: 'solver-cache', issuer: null, effectiveFrom: null },
            applicability: { status: 'unresolved', parcelIds: ['HR-1-17'], conditions: null },
            lifecycle: { availability: 'available', revisionMode: 'latest-only' } });
        for (const field of ['applied', 'ownerAcceptances', 'executedAt', 'offer', 'geometry']) expect(proposal).not.toHaveProperty(field);
    });
    it('preserves a referenced revision when the provider changes instead of rewriting the authored record', () => {
        const initial = gupRecord(row).proposal, reference = contract.reference(initial), before = JSON.stringify(reference);
        const next = gupRecord({ ...row, gbp_m2: 130 }).proposal;
        expect(next.proposalId).toBe(initial.proposalId); expect(contract.compareReference(reference, next)).toBe('changed');
        expect(JSON.stringify(reference)).toBe(before); expect(contract.compareReference(reference, null)).toBe('unavailable');
    });
    it('treats withdrawal as availability, separately from calculation revision or legal expiry', () => {
        const initial = gupRecord(row).proposal;
        const withdrawn = gupRecord({ ...row, current: false }).proposal;
        expect(withdrawn.source.revision).toBe(initial.source.revision);
        expect(contract.compareReference(contract.reference(initial), withdrawn)).toBe('withdrawn');
        expect(withdrawn.authority.effectiveUntil).toBeNull();
    });
    it('hashes equivalent property ordering identically', () => {
        expect(gupRecord(row).source.version).toBe(gupRecord(Object.fromEntries(Object.entries(row).reverse())).source.version);
    });
    it('keeps pinned source references through server serialization, excluding browser application state', () => {
        const sourceReferences = [contract.reference(gupRecord(row).proposal)];
        const result = stripLocalProposalState({ proposalId: 'design', sourceReferences, applied: true });
        expect(result.sourceReferences).toEqual(sourceReferences); expect(result).not.toHaveProperty('applied');
        expect(result.sourceReferences).not.toBe(sourceReferences);
    });
    it('keeps the same references through portable chain metadata', () => {
        const geometry = { type: 'Polygon', coordinates: [[[10,40],[10.001,40],[10.001,40.001],[10,40]]] };
        const authored = { proposalId: 'design', type: 'structure', cadastreParcelIds: ['HR-1-17'],
            site: geometry, binding: { parcels: [] }, cadastreSnapshot: { parcels: [] },
            sourceReferences: [contract.reference(gupRecord(row).proposal)] };
        const metadata = { properties: chain.metadataProperties(authored) };
        expect(chain.fromMetadata(metadata).sourceReferences).toEqual(authored.sourceReferences);
    });
    it('refuses malformed references before a publication could charge or store them', () => {
        const body = { type: 'parcel', cadastreParcelIds: ['HR-1-17'], sourceReferences: [{ revision: 'latest' }] };
        expect(precheckProposalCreate({ body, validatedBody: body })).toMatchObject({ ok: false, status: 422, code: 'invalid-source-reference' });
    });
    it('reserves provider identities from the authored publication route', () => {
        const body = { proposalId: 'source:pretend', type: 'parcel', cadastreParcelIds: ['HR-1-17'] };
        expect(precheckProposalCreate({ body, validatedBody: body })).toMatchObject({ ok: false, code: 'source-proposal-read-only' });
    });
});
