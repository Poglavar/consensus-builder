import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposal-editor-shell.js', import.meta.url), 'utf8');
const start = source.indexOf('    function applyDraftFacetsToProposalDialog(');
const end = source.indexOf('    async function stageProposalDraftForPublishing(', start);

for (const readjust of [true, false]) {
    it(`draft initialization preserves payment terms and ${readjust ? 'locks replacement ownership' : 'allows recipient editing'}`, () => {
        const conditional = { checked: true };
        const modes = [];
        const global = {
            document: { getElementById: id => id === 'proposalConditionalCheckbox' ? conditional : null },
            setProposalOwnershipMode: (mode, options) => modes.push({ mode, options }),
            onProposalOwnershipChange() {
                modes.push({ mode: 'per-slice', options: { unlock: true } });
                conditional.checked = true;
            },
            showProposalPerSliceOption() {},
        };
        const context = vm.createContext({ global });
        vm.runInContext(source.slice(start, end), context);
        context.applyDraftFacetsToProposalDialog({ goal: readjust ? 'reparcellization' : 'park', fields: { ownership: readjust ? 'per-slice' : 'third-party', isConditional: false } });
        expect(conditional.checked).toBe(false);
        if (readjust) expect(modes.at(-1)).toEqual({ mode: 'per-slice', options: { lock: true } });
        else expect(modes[0]).toEqual({ mode: 'third-party', options: { unlock: true } });
    });
}
