// Unit tests for the versioned, multi-city proposal draft lifecycle.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    PROPOSAL_DRAFT_SCHEMA_VERSION,
    PROPOSAL_DRAFT_STORAGE_KEY,
    LEGACY_CORRIDOR_DRAFT_KEY,
    createProposalDraftStore
} = require('../../frontend/js/proposal-drafts.js');

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.get(String(key)) ?? null,
        setItem: (key, value) => values.set(String(key), String(value)),
        removeItem: key => values.delete(String(key)),
        keys: () => [...values.keys()]
    };
}

function harness(options = {}) {
    let clock = new Date('2026-07-11T10:00:00.000Z').getTime();
    let nextId = 1;
    const storage = options.storage || memoryStorage();
    const store = createProposalDraftStore({
        storage,
        now: () => new Date(clock),
        idFactory: () => `draft-${nextId++}`,
        coalesceMs: 500,
        adapterRegistry: options.adapterRegistry
    });
    return {
        store,
        storage,
        advance(ms) { clock += ms; }
    };
}

describe('ProposalDraftStore', () => {
    it('creates source-linked drafts without exposing mutable source snapshots', () => {
        const { store } = harness();
        const source = {
            proposalId: 'proposal-7',
            city: 'zagreb',
            goal: 'park',
            title: 'Pocket park',
            description: 'Original',
            parentParcelIds: ['a', 'b'],
            geometry: { type: 'Polygon', coordinates: [] }
        };

        const draft = store.createDraftFromProposal(source);
        draft.sourceSnapshot.title = 'Mutated outside';
        draft.fields.name = 'Also outside';

        expect(store.getDraft(draft.id)).toMatchObject({
            schemaVersion: PROPOSAL_DRAFT_SCHEMA_VERSION,
            cityId: 'zagreb',
            goal: 'park',
            sourceProposalId: 'proposal-7',
            fields: { name: 'Pocket park', parentParcelIds: ['a', 'b'] },
            sourceSnapshot: { title: 'Pocket park' }
        });
    });

    it('persists multiple drafts across reload and filters them by city', () => {
        const first = harness();
        first.store.createDraft({ cityId: 'zagreb', goal: 'park', fields: { name: 'Z1' } });
        first.store.createDraft({ cityId: 'split', goal: 'square', fields: { name: 'S1' } });

        const restored = createProposalDraftStore({ storage: first.storage });

        expect(restored.listDrafts()).toHaveLength(2);
        expect(restored.listDrafts({ cityId: 'zagreb' }).map(draft => draft.fields.name)).toEqual(['Z1']);
        expect(restored.listDrafts({ cityId: 'split' }).map(draft => draft.fields.name)).toEqual(['S1']);
        expect(restored.getActiveDraft().fields.name).toBe('S1');
    });

    it('resumes the existing draft for a source instead of duplicating it', () => {
        const { store } = harness();
        const source = { proposalId: 'p1', city: 'zagreb', goal: 'park', title: 'A', parentParcelIds: ['1'] };
        const first = store.createDraftFromProposal(source);
        store.updateDraft(first.id, { fields: { name: 'Edited' } });

        const resumed = store.createDraftFromProposal({ ...source, title: 'Server refresh' });

        expect(resumed.id).toBe(first.id);
        expect(resumed.fields.name).toBe('Edited');
        expect(store.listDrafts()).toHaveLength(1);
    });

    it('migrates the old active corridor record exactly once', () => {
        const storage = memoryStorage({
            [LEGACY_CORRIDOR_DRAFT_KEY]: JSON.stringify({
                kind: 'road',
                cityId: 'nyc',
                dirty: true,
                updatedAt: '2026-07-10T12:00:00.000Z',
                sourceProposalId: 'road-source',
                copySource: { proposalId: 'road-source', name: 'Broadway', prefill: { description: 'Extend it' } },
                seed: {
                    centerline: [[{ lat: 40.7, lng: -74 }, { lat: 40.71, lng: -73.99 }]],
                    segmentIds: ['segment-1'],
                    width: 14,
                    sidewalkWidth: 2
                }
            })
        });

        const first = harness({ storage });
        const draft = first.store.listDrafts()[0];
        expect(draft).toMatchObject({
            goal: 'road-track',
            cityId: 'nyc',
            sourceProposalId: 'road-source',
            fields: { name: 'Broadway', description: 'Extend it' },
            editorPayload: { kind: 'road', definition: { width: 14, segmentIds: ['segment-1'] } }
        });
        expect(storage.getItem(LEGACY_CORRIDOR_DRAFT_KEY)).toBeNull();

        const second = createProposalDraftStore({ storage });
        expect(second.listDrafts()).toHaveLength(1);
    });

    it('quarantines corrupt storage and starts with an empty usable store', () => {
        const storage = memoryStorage({ [PROPOSAL_DRAFT_STORAGE_KEY]: '{not-json' });
        const { store } = harness({ storage });

        expect(store.listDrafts()).toEqual([]);
        expect(storage.keys().some(key => key.startsWith(`${PROPOSAL_DRAFT_STORAGE_KEY}.corrupt.`))).toBe(true);
        expect(() => store.createDraft({ cityId: 'zagreb', goal: 'park', fields: { name: 'Recovered' } })).not.toThrow();
        expect(store.listDrafts()).toHaveLength(1);
    });

    it('coalesces rapid editor changes into one undo step and supports redo', () => {
        const { store, advance } = harness();
        const draft = store.createDraft({ cityId: 'zagreb', goal: 'buildings', fields: { name: 'Block' }, editorPayload: { height: 3 } });

        store.updateDraft(draft.id, { editorPayload: { height: 4 } }, { coalesceKey: 'height-slider' });
        advance(100);
        store.updateDraft(draft.id, { editorPayload: { height: 5 } }, { coalesceKey: 'height-slider' });
        expect(store.getDraft(draft.id).history.past).toHaveLength(1);

        advance(1000);
        store.updateDraft(draft.id, { editorPayload: { height: 6 } }, { coalesceKey: 'height-slider' });
        expect(store.getDraft(draft.id).history.past).toHaveLength(2);

        expect(store.undoDraft(draft.id).editorPayload.height).toBe(5);
        expect(store.undoDraft(draft.id).editorPayload.height).toBe(3);
        expect(store.redoDraft(draft.id).editorPayload.height).toBe(5);
    });

    it('deletes one draft without leaking active state into another', () => {
        const { store } = harness();
        const first = store.createDraft({ cityId: 'zagreb', goal: 'park', fields: { name: 'One' } });
        const second = store.createDraft({ cityId: 'zagreb', goal: 'square', fields: { name: 'Two' } });

        expect(store.deleteDraft(second.id)).toBe(true);
        expect(store.getActiveDraft()).toBeNull();
        expect(store.getDraft(first.id).fields.name).toBe('One');
    });

    it('preserves the review checkpoint when a draft is closed and resumed', () => {
        const { store } = harness();
        const draft = store.createDraft({
            cityId: 'zagreb',
            goal: 'park',
            fields: { name: 'Reviewable park', parentParcelIds: ['1'] }
        });

        store.setDraftState(draft.id, 'review');
        store.clearActiveDraft();

        expect(store.resumeDraft(draft.id).state).toBe('review');
        expect(store.getActiveDraft().state).toBe('review');
    });

    it('uses adapter validation and serialization while preserving replacement provenance', () => {
        const adapter = {
            key: 'park',
            canEdit: () => true,
            draftFromProposal: proposal => ({
                fields: { name: proposal.title },
                editorPayload: { geometry: proposal.geometry }
            }),
            validate: draft => ({
                valid: draft.fields.name.length > 2,
                errors: draft.fields.name.length > 2 ? [] : [{ code: 'short-name', message: 'Name is too short.' }]
            }),
            serializeProposal: draft => ({
                goal: draft.goal,
                title: draft.fields.name,
                geometry: draft.editorPayload.geometry,
                parentParcelIds: draft.fields.parentParcelIds
            })
        };
        const { store } = harness({ adapterRegistry: { get: key => key === 'park' ? adapter : null } });
        const draft = store.createDraftFromProposal({
            proposalId: 'source-park', city: 'zagreb', goal: 'park', title: 'Park', parentParcelIds: ['1'], geometry: { type: 'Polygon' }
        });

        const proposal = store.buildProposalFromDraft(draft.id);
        expect(proposal).toMatchObject({
            title: 'Park',
            sourceProposalId: 'source-park',
            replacementOfProposalId: 'source-park',
            proposalDraftId: draft.id
        });
        expect(proposal.proposalId).toBeUndefined();
    });

    it('wipeAll erases every draft and the unload flush cannot resurrect the storage key', () => {
        const { store, storage } = harness();
        store.createDraft({ cityId: 'zagreb', goal: 'road-track', fields: { name: 'Drawn road' } });
        store.createDraft({ cityId: 'split', goal: 'park', fields: { name: 'Park' } });
        expect(storage.getItem(PROPOSAL_DRAFT_STORAGE_KEY)).not.toBeNull();

        expect(store.wipeAll()).toBe(true);

        expect(store.listDrafts()).toEqual([]);
        expect(store.getActiveDraft()).toBeNull();
        expect(storage.getItem(PROPOSAL_DRAFT_STORAGE_KEY)).toBeNull();

        // The pagehide/beforeunload handlers call flush(); after a wipe that must be a no-op.
        store.flush();
        expect(storage.getItem(PROPOSAL_DRAFT_STORAGE_KEY)).toBeNull();

        // A store created after the wiped session sees nothing.
        expect(createProposalDraftStore({ storage }).listDrafts()).toEqual([]);
    });

    it('still records deleting the last draft even though the store becomes empty', () => {
        const { store, storage } = harness();
        const draft = store.createDraft({ cityId: 'zagreb', goal: 'park', fields: { name: 'Only one' } });

        store.deleteDraft(draft.id);
        store.flush();

        expect(createProposalDraftStore({ storage }).listDrafts()).toEqual([]);
    });

    it('keeps failed publishing recoverable and reuses the idempotency operation on retry', () => {
        const { store } = harness();
        const draft = store.createDraft({ cityId: 'zagreb', goal: 'park', fields: { name: 'Park', parentParcelIds: ['1'] } });

        const publishing = store.markPublishing(draft.id);
        const failed = store.markPublishFailed(draft.id, Object.assign(new Error('Wallet rejected'), { code: 4001 }));
        const retrying = store.markPublishing(draft.id);

        expect(failed).toMatchObject({ state: 'error', publish: { error: { message: 'Wallet rejected', code: 4001 } } });
        expect(retrying.publish.operationId).toBe(publishing.publish.operationId);
        expect(store.getDraft(draft.id)).not.toBeNull();

        const receipt = store.consumeAfterPublish(draft.id, 'replacement-9');
        expect(store.getDraft(draft.id)).toBeNull();
        expect(store.consumeAfterPublish(draft.id, 'replacement-9')).toEqual(receipt);
    });

    // A live autosave carrying a very large/complex geometry can blow the localStorage quota. That
    // must degrade to "kept in memory only", never throw into the caller — a raw QuotaExceededError
    // once reached the status bar and aborted the block-building flow mid-edit.
    it('does not throw when the storage write fails (e.g. quota exceeded)', () => {
        const quotaStorage = memoryStorage();
        quotaStorage.setItem = () => {
            const err = new Error("Setting the value of 'consensus-builder.proposal-drafts.v1' exceeded the quota.");
            err.name = 'QuotaExceededError';
            throw err;
        };
        const { store } = harness({ storage: quotaStorage });

        let draft;
        expect(() => { draft = store.createDraft({ cityId: 'zagreb', goal: 'buildings', fields: { name: 'Huge block' } }); }).not.toThrow();
        // The draft still exists in memory — editing is unaffected, only persistence was lost.
        expect(store.getDraft(draft.id)).not.toBeNull();
        expect(() => store.updateDraft(draft.id, { editorPayload: { giant: 'x'.repeat(1000) } })).not.toThrow();
        expect(store.getDraft(draft.id).editorPayload.giant).toHaveLength(1000);
    });
});
