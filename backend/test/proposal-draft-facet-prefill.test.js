// Draft facets prefilled into the classic create dialog: the draft's ownership facet stays editable
// and its recipient, name and description are carried over. (Designs carry no payment terms since M2,
// plan-design-agreement.md, so there is no payment checkbox to prefill.)
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposal-editor-shell.js', import.meta.url), 'utf8');
const start = source.indexOf('    function applyDraftFacetsToProposalDialog(');
const end = source.indexOf('    async function stageProposalDraftForPublishing(', start);

function dialog() {
    const elements = {
        proposalRecipientAddress: { value: '' },
        proposalName: { value: 'stale', dataset: {} },
        proposalDescription: { value: 'stale' }
    };
    const scopes = ['any', 'specific'].map(value => ({ value, checked: value === 'any' }));
    const calls = [];
    const global = {
        document: {
            getElementById: id => elements[id] || null,
            querySelectorAll: selector => (selector === 'input[name="proposalRecipientScope"]' ? scopes : [])
        },
        setProposalOwnershipMode: (mode, options) => calls.push(['ownership', mode, options]),
        onProposalOwnershipChange: () => calls.push(['ownership-change'])
    };
    const context = vm.createContext({ global });
    vm.runInContext(source.slice(start, end), context);
    return { context, elements, scopes, calls };
}

it('draft initialization keeps the ownership facet editable and carries the recipient and text over', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const { context, elements, scopes, calls } = dialog();
    context.applyDraftFacetsToProposalDialog({ goal: 'park', fields: {
        ownership: 'third-party', recipientScope: 'specific', recipientAddress: '0xabc',
        name: 'Pocket park', description: 'Trees', titleOrigin: 'user'
    } });
    expect(calls).toEqual([['ownership', 'third-party', { unlock: true }], ['ownership-change']]);
    expect(scopes.map(input => [input.value, input.checked])).toEqual([['any', false], ['specific', true]]);
    expect(elements.proposalRecipientAddress.value).toBe('0xabc');
    expect(elements.proposalName.value).toBe('Pocket park');
    expect(elements.proposalName.dataset.titleOrigin).toBe('user');
    expect(elements.proposalDescription.value).toBe('Trees');
});

it('draft initialization clears the dialog text for a draft without any and marks a generated title', () => {
    const { context, elements, calls } = dialog();
    context.applyDraftFacetsToProposalDialog({ goal: 'park', fields: { titleOrigin: 'generated' } });
    expect(calls).toEqual([['ownership-change']]);
    expect(elements.proposalRecipientAddress.value).toBe('');
    expect(elements.proposalName.value).toBe('');
    expect(elements.proposalName.dataset.titleOrigin).toBe('generated');
    expect(elements.proposalDescription.value).toBe('');
});
