import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifiedNamedPlanMembers, selectNamedPlanProposals } = require('../../frontend/js/proposals/grain-score-rules.js');
const member = (rowId, authoredId) => ({ proposalRowId: rowId, authoredProposalId: authoredId, changed: false });
const plan = () => ({ proposalRowIds: ['41', '42'], members: [member('41', 'p-a'), member('42', 'p-b')] });
const original = () => ({ serverProposalId: '41', proposalId: 'p-a' });
const second = () => ({ serverProposalId: '42', proposalId: 'p-b' });

describe('verified named-plan scoring membership', () => {
    it('uses exact published members in plan order and excludes unrelated applied records', () => {
        const a = original();
        const b = second();
        const unrelated = { serverProposalId: '99', proposalId: 'p-unrelated' };
        expect(selectNamedPlanProposals(plan(), [b, unrelated, a])).toEqual([a, b]);
    });

    it('keeps verification tied to row identity when member summaries arrive out of order', () => {
        const p = plan();
        p.members.reverse();
        expect(verifiedNamedPlanMembers(p).map(m => m.proposalRowId)).toEqual(['41', '42']);
    });

    it.each([
        ['source', { proposalId: 'p-fork', sourceProposalId: 'p-a' }],
        ['row source', { proposalId: 'p-fork', sourceProposalId: '41' }],
        ['replacement', { proposalId: 'p-fork', replacementOfProposalId: 'p-a' }],
        ['published replacement', { proposalId: 'p-fork', serverProposalId: '99', replacementOfProposalId: '41' }],
        ['authored ID collision', { proposalId: '41' }],
        ['generic ID collision', { proposalId: 'p-fork', id: '41' }],
        ['wrong published row', { proposalId: 'p-a', serverProposalId: '99' }],
    ])('refuses a %s in place of an original member', (_label, replacement) => {
        expect(selectNamedPlanProposals(plan(), [replacement, second()])).toBeNull();
    });

    it('allows a fork when that fork itself is the published member', () => {
        const p = { proposalRowIds: ['99'], members: [member('99', 'p-fork')] };
        const fork = { proposalId: 'p-fork', serverProposalId: '99', sourceProposalId: '41' };
        expect(selectNamedPlanProposals(p, [original(), fork])).toEqual([fork]);
    });

    it('recognizes the author’s local record even though publication assigns a different authored ID', () => {
        const p = { proposalRowIds: ['41'], members: [member('41', 'published-content-fingerprint')] };
        const local = { proposalId: 'p-local-drawing', serverProposalId: '41' };
        expect(selectNamedPlanProposals(p, [local])).toEqual([local]);
    });

    it('does not report a partial score when only one original member is applied', () => {
        expect(selectNamedPlanProposals(plan(), [original()])).toBeNull();
    });

    it('rejects ambiguous local copies of one published row', () => {
        expect(selectNamedPlanProposals(plan(), [original(), original(), second()])).toBeNull();
    });

    it.each([
        ['slug only', () => ({ slug: 'some-plan' })],
        ['no verification', () => ({ proposalRowIds: ['41', '42'] })],
        ['empty scope', () => ({ proposalRowIds: [], members: [] })],
        ['missing member', () => ({ ...plan(), members: [member('41', 'p-a')] })],
        ['unknown verification', () => ({ ...plan(), members: [{ proposalRowId: '41', authoredProposalId: 'p-a' }, member('42', 'p-b')] })],
        ['changed content', () => ({ ...plan(), members: [{ ...member('41', 'p-a'), changed: true }, member('42', 'p-b')] })],
        ['deleted content', () => ({ ...plan(), members: [{ proposalRowId: '41', missing: true, changed: true }, member('42', 'p-b')] })],
        ['absent authored identity', () => ({ ...plan(), members: [{ proposalRowId: '41', changed: false }, member('42', 'p-b')] })],
        ['duplicate rows', () => ({ proposalRowIds: ['41', '41'], members: [member('41', 'p-a'), member('41', 'p-a')] })],
        ['duplicate verification', () => ({ ...plan(), members: [member('41', 'p-a'), member('41', 'p-a')] })],
        ['extra member', () => ({ ...plan(), members: [...plan().members, member('99', 'p-c')] })],
        ['different verified row', () => ({ ...plan(), members: [member('41', 'p-a'), member('99', 'p-b')] })],
        ['authored IDs as row IDs', () => ({ proposalRowIds: ['p-a'], members: [member('p-a', 'p-a')] })],
    ])('refuses %s instead of falling back to the local composition', (_label, makePlan) => {
        expect(verifiedNamedPlanMembers(makePlan())).toBeNull();
        expect(selectNamedPlanProposals(makePlan(), [original(), second()])).toBeNull();
    });
});
