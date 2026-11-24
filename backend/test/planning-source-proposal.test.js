// Source authority, revision references and authored publication must remain separate from consent.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { gupRecord } from '../planning/providers/zagreb-gup.js';
import { stripLocalProposalState } from '../proposals/archive-state.js';
const require = createRequire(import.meta.url);
const contract = require('../../frontend/js/planning/source-proposal.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const row = { gup_id: 2025, parcel_id: 'HR-1-17', gbp_m2: 123, current: true,
    result_status: 'evidence_missing', reason: 'exception_unresolved', computed_at: '2026-10-09T00:00:00Z', floors: [] };

describe('source-backed obligatory proposal', () => {
    it('finds the same full design site from its visible area or its government-plot massing', () => {
        const source = { id: 'city-plan', recordId: 'zone-7' };
        const area = { role: 'permitted', source, areas: [{ geometry: {} }], assessment: { meaning: 'zoning-area' } };
        const ref = { source: 'city-plan', recordId: 'zone-7' };
        const massing = { role: 'permitted', source, landBasis: 'zone', parcelEnvelope: true,
            sourceEvidence: { planningArea: { ...ref, lotId: 'zone:zone-7' } } };
        expect(contract.designSiteArea(area)).toEqual(ref);
        expect(contract.designSiteArea({ ...area, overview: true })).toEqual(ref);
        expect(contract.designSiteArea(massing)).toEqual(ref);
        expect(contract.designSite(massing)).toBeNull();
        expect(contract.designSiteArea({ ...massing, landBasis: 'parcel' })).toBeNull();
        expect(contract.designSiteArea({ ...massing, sourceEvidence: { zoningRecordId: 'zone-7' } })).toBeNull();
        expect(contract.designSiteArea({ ...massing, source: { id: 'other-plan' } })).toBeNull();
    });
    it('pins the full site, including holes and islands, independently of the source projection', () => {
        const ring = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
        const site = { type: 'MultiPolygon', coordinates: [[ring(15, 45, .01), ring(15.002, 45.002, .002)], [ring(15.1, 45.1, .006)]] };
        const record = { ...gupRecord(row), site, areas: [{ geometry: site }], assessment: { meaning: 'zoning-area' } };
        expect(contract.designSite({ ...record, overview: true })).toBeNull();
        expect(contract.designSite(gupRecord(row))).toBeNull();
        const draft = contract.designSite(record);
        const local = { ...draft, goal: 'parcel-layout', parcelLayout: { poolSource: 'site', pool: draft.site } };
        const published = DesignRecord.published(local);
        expect(published.site).toEqual(site);
        expect(published.sourceReferences).toEqual([contract.reference(record.proposal)]);
        expect(DesignRecord.validate(published).valid).toBe(true);
        expect(DesignRecord.validate({ ...published, sourceReferences: [{ recordId: 'unknown' }] }).valid).toBe(false);
        site.coordinates[1][0][0][0] = 16;
        expect(draft.site.coordinates).toEqual(published.site.coordinates);
    });
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
    it('refuses a malformed pinned reference instead of dropping it', () => {
        expect(() => stripLocalProposalState({ proposalId: 'design', sourceReferences: [{ revision: 'latest' }] })).toThrow(/source reference/);
    });
});
