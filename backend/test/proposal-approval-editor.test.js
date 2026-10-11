// Protects the editor's ownership approval draft projection and keeps approval readiness out of geometric validation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
globalThis.ProposalApproval = approval;
globalThis.turf = require('@turf/turf');
Object.assign(globalThis, require('../../frontend/js/corridor-profile.js'));

const { registry } = require('../../frontend/js/proposal-editor-adapters.js');
const { createProposalDraftStore } = require('../../frontend/js/proposal-drafts.js');
globalThis.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const editorShell = require('../../frontend/js/proposal-editor-shell.js');

const rights = {
    schema: 'parcel-rights/v1',
    source: { provider: 'upload', reference: 'snapshot-1' },
    parcels: [{
        parcelId: 'parcel-1', complete: true, areaM2: 100,
        owners: [{ ownerId: 'owner-a', share: '1/1' }]
    }]
};
const source = {
    proposalId: 'proposal-source', goal: 'as-is', type: 'parcel', title: 'Source proposal',
    cadastreParcelIds: ['parcel-1'],
    approvalConfig: { schema: 'proposal-approval/v1', rights, policy: { type: 'unanimous' } },
    lens: ['member-a'],
    ownerApprovals: { 'owner-a': { ownerId: 'owner-a', actorId: 'actor-1', effectHash: 'old-effect' } },
    ownerApprovalHistory: [{ effectHash: 'older-effect' }],
    ownerAcceptances: { 'owner-a': true },
    acceptedParcelIds: ['parcel-1']
};

describe('proposal approval editor projection', () => {
    it('renders approval readiness against canonical cadastre IDs without mutating the live-piece draft', () => {
        const adapter = registry.get('as-is');
        const seeded = adapter.draftFromProposal({
            proposalId: 'source-live-selection', goal: 'as-is', title: 'Source', cadastreParcelIds: ['cad:source']
        });
        const draft = {
            id: 'draft-live-selection', cityId: 'fixture-city', goal: 'as-is', adapterKey: 'as-is',
            sourceProposalId: 'source-live-selection', sourceSnapshot: { goal: 'as-is', cadastreParcelIds: ['cad:source'] },
            fields: { ...seeded.fields, selectedParcelIds: ['live-piece:7'] },
            editorPayload: seeded.editorPayload, previewGeometry: seeded.previewGeometry
        };
        draft.fields.approvalConfig = approval.normalizeConfig({
            schema: 'proposal-approval/v1',
            rights: { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'snapshot' }, parcels: [
                { parcelId: 'cad:7', complete: true, areaM2: 100, owners: [{ ownerId: 'owner:a', share: '1/1' }] }
            ] }, policy: { type: 'unanimous' }
        });
        globalThis.LiveParcelFabric = { cadastreIdsForParcelIds: ids => ids.map(() => 'cad:7') };
        const before = JSON.stringify(draft);

        expect(editorShell.approvalCadastreParcelIds(draft)).toEqual(['cad:7']);
        const html = editorShell.renderApprovalPreview(draft.fields.approvalConfig, draft);

        expect(html).toContain('Ownership data is complete');
        expect(html).toContain('cad:7');
        expect(html).not.toContain('live-piece:7');
        expect(JSON.stringify(draft)).toBe(before);
    });

    it('round-trips canonical rights, policy, and lens through the common serializer and clears consent on a fork', () => {
        const adapter = registry.get('as-is');
        const seeded = adapter.draftFromProposal(source);
        const draft = {
            id: 'draft-approval', cityId: 'fixture-city', goal: 'as-is', adapterKey: 'as-is',
            sourceProposalId: source.proposalId, sourceSnapshot: source,
            fields: seeded.fields, editorPayload: seeded.editorPayload,
            previewGeometry: seeded.previewGeometry
        };
        draft.fields.approvalConfig = approval.normalizeConfig({
            schema: 'proposal-approval/v1', rights,
            policy: {
                type: 'threshold',
                owners: { numerator: 1, denominator: 2, strict: false },
                area: { numerator: 7, denominator: 10, strict: true }
            }
        });
        draft.fields.lens = ['member-b'];

        const fork = adapter.serializeProposal(draft);
        expect(fork.approvalConfig).toEqual(draft.fields.approvalConfig);
        expect(fork.lens).toEqual(['member-b']);
        expect(fork).not.toHaveProperty('ownerApprovals');
        expect(fork).not.toHaveProperty('ownerApprovalHistory');
        expect(fork).not.toHaveProperty('ownerAcceptances');
        expect(fork).not.toHaveProperty('acceptedParcelIds');

        const summary = adapter.summarizeChanges(source, draft);
        expect(summary.changedFacets.map(change => change.key)).toContain('approvalConfig');
        expect(summary.changedFacets.map(change => change.key)).toContain('lens');
        expect(approval.contextHash(fork)).not.toBe(approval.contextHash(source));
    });

    it('records approval edits in the autosaved draft and leaves geometric validation independent of missing rights', () => {
        const memory = new Map();
        const storage = {
            getItem: key => memory.has(key) ? memory.get(key) : null,
            setItem: (key, value) => memory.set(key, value),
            removeItem: key => memory.delete(key)
        };
        let nextId = 0;
        const store = createProposalDraftStore({
            storage, storageKey: 'approval-editor-test', adapterRegistry: registry,
            idFactory: () => `approval-draft-${++nextId}`
        });
        const parcelOnly = { ...source, approvalConfig: null, lens: [], ownerApprovals: undefined, ownerApprovalHistory: undefined };
        const draft = store.createDraftFromProposal(parcelOnly);
        expect(draft.dirty).toBe(false);
        expect(registry.get('as-is').validate(draft).valid).toBe(true);

        const edited = store.updateDraft(draft.id, {
            fields: {
                approvalConfig: approval.normalizeConfig({
                    schema: 'proposal-approval/v1', rights,
                    policy: { type: 'unanimous' }
                }),
                lens: ['member-c']
            }
        });
        expect(edited.dirty).toBe(true);
        expect(edited.fields.lens).toEqual(['member-c']);
        expect(JSON.parse(memory.get('approval-editor-test')).drafts[0].fields.approvalConfig.rights.parcels[0].owners[0].share).toBe('1/1');
    });
});
