// Draft facets prefilled into the classic create dialog keep the draft's payment terms and leave its
// recipient editable.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposal-editor-shell.js', import.meta.url), 'utf8');
const start = source.indexOf('    function applyDraftFacetsToProposalDialog(');
const end = source.indexOf('    async function stageProposalDraftForPublishing(', start);

it('draft initialization preserves payment terms and allows recipient editing', () => {
    const conditional = { checked: true };
    const modes = [];
    const global = {
        document: { getElementById: id => id === 'proposalConditionalCheckbox' ? conditional : null },
        setProposalOwnershipMode: (mode, options) => modes.push({ mode, options }),
        // Ownership initialization resets payment defaults; the draft's saved choice must win.
        onProposalOwnershipChange() { conditional.checked = true; }
    };
    const context = vm.createContext({ global });
    vm.runInContext(source.slice(start, end), context);
    context.applyDraftFacetsToProposalDialog({ goal: 'park', fields: { ownership: 'third-party', isConditional: false } });
    expect(conditional.checked).toBe(false);
    expect(modes).toEqual([{ mode: 'third-party', options: { unlock: true } }]);
});
