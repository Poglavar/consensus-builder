// Proposals are geometry; their parcels are derived (frontend/js/proposals/ground-rebase.js). When
// the cadastre in view no longer fits a record's stored parcels, a local draft re-derives them and
// applies, and a published record is offered a fork whose parcels come from its geometry.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rebase = require('../../frontend/js/proposals/ground-rebase.js');

const outside = { code: 'proposal-footprint-outside-cadastre', message: 'outside' };

describe('rebaseRoute', () => {
    it('re-derives a local draft and offers a published record a fork, only for ground changes', () => {
        const record = { proposalId: 'p1', cadastreParcelIds: ['HR-1-1'] };
        expect(rebase.rebaseRoute(record, outside, false)).toBe('rederive');
        expect(rebase.rebaseRoute(record, outside, true)).toBe('fork');
        expect(rebase.rebaseRoute(record, { code: 'cadastral-ground-absent' }, true)).toBe('fork');
        expect(rebase.rebaseRoute(record, { code: 'building-uncovered-ground' }, false)).toBe('rederive');
        // Not a ground change: nothing to re-derive from, or a different fault.
        expect(rebase.rebaseRoute(record, { code: 'cadastral-ground-unavailable' }, false)).toBeNull();
        expect(rebase.rebaseRoute(record, { code: 'building-over-road' }, true)).toBeNull();
        expect(rebase.rebaseRoute(record, null, false)).toBeNull();
        // A record drawn on its own site keeps the site rule.
        expect(rebase.rebaseRoute({ ...record, site: { type: 'MultiPolygon', coordinates: [] } }, outside, false)).toBeNull();
    });
});

describe('rederiveAndApply', () => {
    const draft = { proposalId: 'p1', cadastreParcelIds: ['HR-1-1'] };

    it('stores the parcels its geometry takes today and applies once more', async () => {
        const setDraftIds = vi.fn(() => true);
        const apply = vi.fn(async () => true);
        const result = await rebase.rederiveAndApply(draft, { currentIds: async () => ['HR-1-1', 'HR-1-9'], setDraftIds, apply });
        expect(result).toEqual({ outcome: 'applied', ids: ['HR-1-1', 'HR-1-9'] });
        expect(setDraftIds).toHaveBeenCalledWith('p1', ['HR-1-1', 'HR-1-9']);
        expect(apply).toHaveBeenCalledWith('p1');
    });

    it('changes nothing when the geometry takes the same parcels, or none', async () => {
        const setDraftIds = vi.fn(() => true);
        const apply = vi.fn();
        expect((await rebase.rederiveAndApply(draft, { currentIds: async () => ['HR-1-1'], setDraftIds, apply })).outcome).toBe('unchanged');
        expect((await rebase.rederiveAndApply(draft, { currentIds: async () => [], setDraftIds, apply })).outcome).toBe('empty');
        expect(setDraftIds).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });

    it('reports a refused store and a second failed apply', async () => {
        const deps = { currentIds: async () => ['HR-2-2'], apply: async () => false };
        expect((await rebase.rederiveAndApply(draft, { ...deps, setDraftIds: () => false })).outcome).toBe('refused');
        expect((await rebase.rederiveAndApply(draft, { ...deps, setDraftIds: () => true })).outcome).toBe('failed');
    });
});

describe('forkOntoCurrentGround', () => {
    it('opens a new draft of the record with the parcels its geometry takes today', async () => {
        const record = { proposalId: '879', cadastreParcelIds: ['HR-1-1'] };
        const store = {
            createDraftFromProposal: vi.fn(() => ({ id: 'd1' })),
            updateDraft: vi.fn()
        };
        const stage = vi.fn(async () => true);
        await rebase.forkOntoCurrentGround(record, { currentIds: async () => ['HR-1-2', 'HR-1-3'], store, stage });
        expect(store.createDraftFromProposal).toHaveBeenCalledWith(record, { activate: true, forceNew: true });
        expect(store.updateDraft).toHaveBeenCalledWith('d1', { fields: { selectedParcelIds: ['HR-1-2', 'HR-1-3'], cadastreParcelIds: ['HR-1-2', 'HR-1-3'] } });
        expect(stage).toHaveBeenCalledWith('d1');
    });

    it('refuses when the geometry covers no parcels on the ground in view', async () => {
        const store = { createDraftFromProposal: vi.fn(), updateDraft: vi.fn() };
        await expect(rebase.forkOntoCurrentGround({ proposalId: '1' }, { currentIds: async () => [], store, stage: vi.fn() }))
            .rejects.toThrow('covers no parcels');
        expect(store.createDraftFromProposal).not.toHaveBeenCalled();
    });
});
