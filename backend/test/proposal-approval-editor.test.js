// The design editor and owner consent: a design's editor has no approval setup any more (no Approval
// or Terms tab; the decision rule belongs to the agreement, plan-design-agreement.md M2), and a fork
// of a design never carries its source's consent state, which describes the source, not the fork.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
globalThis.ProposalApproval = approval;
globalThis.turf = require('@turf/turf');
Object.assign(globalThis, require('../../frontend/js/corridor-profile.js'));

const { registry } = require('../../frontend/js/proposal-editor-adapters.js');
const { createProposalDraftStore } = require('../../frontend/js/proposal-drafts.js');

// A source carrying a local purchase simulation: browser-local state a design never passes on to a
// fork. A design carries no approval receipts to strip: owners decide on agreements (M2).
const source = {
    proposalId: 'proposal-source', goal: 'as-is', type: 'parcel', title: 'Source proposal',
    cadastreParcelIds: ['parcel-1'],
    localPurchaseSimulation: { buyer: 'actor-1' }
};
const LOCAL_KEYS = ['localPurchaseSimulation'];

describe('design editor without an approval setup', () => {
    it('drafts a design with no approval or lens field, and forks it without the source’s local state', () => {
        const adapter = registry.get('as-is');
        const seeded = adapter.draftFromProposal(source);
        expect(Object.keys(seeded.fields)).not.toContain('approvalConfig');
        expect(Object.keys(seeded.fields)).not.toContain('lens');
        const draft = {
            id: 'draft-fork', cityId: 'fixture-city', goal: 'as-is', adapterKey: 'as-is',
            sourceProposalId: source.proposalId, sourceSnapshot: source,
            fields: seeded.fields, editorPayload: seeded.editorPayload, previewGeometry: seeded.previewGeometry
        };
        const fork = adapter.serializeProposal(draft);
        expect(fork.cadastreParcelIds).toEqual(['parcel-1']);
        LOCAL_KEYS.forEach(key => expect(fork, key).not.toHaveProperty(key));
    });

    it('builds the record of a draft without the source’s local state', () => {
        const memory = new Map();
        const storage = {
            getItem: key => memory.has(key) ? memory.get(key) : null,
            setItem: (key, value) => memory.set(key, value),
            removeItem: key => memory.delete(key)
        };
        let nextId = 0;
        const store = createProposalDraftStore({
            storage, storageKey: 'design-editor-consent-test', adapterRegistry: registry,
            idFactory: () => `design-draft-${++nextId}`
        });
        const draft = store.createDraftFromProposal(source);
        expect(draft.dirty).toBe(false);
        expect(registry.get('as-is').validate(draft).valid).toBe(true);
        const built = store.buildProposalFromDraft(draft.id);
        expect(built.title).toBe('Source proposal');
        LOCAL_KEYS.forEach(key => expect(built, key).not.toHaveProperty(key));
    });
});
