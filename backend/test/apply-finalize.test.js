// The shared apply-tail helpers (persist + UI refresh) extracted from the _apply<Type> methods.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { persistAppliedProposal, refreshProposalUIAfterApply } = require('../../frontend/js/proposals/apply/finalize.js');

const KEYS = ['proposalStorage', 'updateShowProposalsButton', 'updateProposalList', 'refreshParcelStylesForAppliedProposals', 'updateStatus'];
const saved = {};
const calls = () => { const f = (...a) => f.args.push(a); f.args = []; return f; };

beforeEach(() => { KEYS.forEach(k => saved[k] = globalThis[k]); });
afterEach(() => { KEYS.forEach(k => saved[k] === undefined ? delete globalThis[k] : (globalThis[k] = saved[k])); });

describe('persistAppliedProposal', () => {
    it('flips applied, stamps id, indexes and saves', () => {
        const indexed = [];
        let savedN = 0;
        globalThis.proposalStorage = { _indexProposal: p => indexed.push(p), save: () => savedN++, proposals: new Map() };
        const data = { roadProposal: { applied: false, appliedAt: 'stale' } };
        persistAppliedProposal(data, 'p-x');
        expect(data.applied).toBe(true);
        expect(data.appliedAt).toBeTruthy();
        expect(data.roadProposal.applied).toBeUndefined();
        expect(data.roadProposal.appliedAt).toBeUndefined();
        expect(data.proposalId).toBe('p-x');
        expect(data.updatedAt).toBeTruthy();
        expect(indexed).toEqual([data]);
        expect(savedN).toBe(1);
    });

    it('falls back to proposals.set when _indexProposal is absent', () => {
        const map = new Map();
        globalThis.proposalStorage = { save: () => {}, proposals: map };
        const data = { proposalId: 'p-keep' };
        persistAppliedProposal(data, 'p-x');
        expect(map.get('p-keep')).toBe(data); // keeps its own id
    });

    it('is a no-op on null', () => { expect(() => persistAppliedProposal(null, 'p')).not.toThrow(); });
});

describe('refreshProposalUIAfterApply', () => {
    it('invokes the guarded UI refreshers and the status message', () => {
        const btn = calls(), list = calls(), styles = calls(), status = calls();
        globalThis.updateShowProposalsButton = btn;
        globalThis.updateProposalList = list;
        globalThis.refreshParcelStylesForAppliedProposals = styles;
        globalThis.updateStatus = status;
        refreshProposalUIAfterApply('done');
        expect(btn.args.length).toBe(1);
        expect(list.args.length).toBe(1);
        expect(styles.args.length).toBe(1);
        expect(status.args[0]).toEqual(['done']);
    });

    it('tolerates missing UI globals and no message', () => {
        KEYS.forEach(k => delete globalThis[k]);
        expect(() => refreshProposalUIAfterApply()).not.toThrow();
    });
});
