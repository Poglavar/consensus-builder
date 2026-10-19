// proposals/lineage.js — forks link back to their source and an original lists what was made from it.
// The pure parts: renaming a source id to its published record, finding local forks, and merging the
// server's list with this browser's.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Lineage = require('../../frontend/js/proposals/lineage.js');

describe('publishedSourceIds', () => {
    it('names a since-published local source by its published record', () => {
        const local = { 'p-draft': { proposalId: 'p-draft', serverProposalId: 879 } };
        const fork = { sourceProposalId: 'p-draft', replacementOfProposalId: 'p-draft', copiedFromProposalId: 'p-other' };
        expect(Lineage.publishedSourceIds(fork, id => local[id] || null))
            .toEqual({ sourceProposalId: '879', replacementOfProposalId: '879' });
    });

    it('leaves an unpublished source, an already-published id and a missing source alone', () => {
        const local = { 'p-draft': { proposalId: 'p-draft' }, 'c2-x': { proposalId: 'c2-x', serverProposalId: 'c2-x' } };
        expect(Lineage.publishedSourceIds({ sourceProposalId: 'p-draft' }, id => local[id])).toEqual({});
        expect(Lineage.publishedSourceIds({ sourceProposalId: 'c2-x' }, id => local[id])).toEqual({});
        expect(Lineage.publishedSourceIds({}, () => null)).toEqual({});
        expect(Lineage.publishedSourceIds(null, () => null)).toEqual({});
    });
});

describe('localDerived / mergeDerived', () => {
    const original = { proposalId: 'c2-orig', serverProposalId: '879', title: 'Original' };
    const forkA = { proposalId: 'p-a', sourceProposalId: 'c2-orig', title: 'Fork A' };
    const forkB = { proposalId: 'p-b', replacementOfProposalId: '879', serverProposalId: '901', title: 'Fork B', landFork: { kind: 'overlap' } };
    const unrelated = { proposalId: 'p-c', sourceProposalId: 'c2-else', title: 'Other' };

    it('finds forks that name the original by either id, never the original itself', () => {
        expect(Lineage.localDerived(original, [original, forkA, forkB, unrelated]).map(p => p.proposalId)).toEqual(['p-a', 'p-b']);
        expect(Lineage.localDerived({}, [forkA])).toEqual([]);
    });

    it('lists published forks first and does not repeat a local copy of one', () => {
        const server = [{ id: 901, proposalId: 'c2-fork-b', title: 'Fork B', author: 'Owner C', status: 'Active', landFork: true }];
        const merged = Lineage.mergeDerived(server, [forkA, forkB]);
        expect(merged.map(e => [e.lookup, e.title, e.published, e.landFork])).toEqual([
            ['901', 'Fork B', true, true],
            ['p-a', 'Fork A', false, false]
        ]);
    });
});
