// Creation-surface contract for the active parcel model: cadastral boundaries are either kept or
// land-readjusted. Legacy Decide Later data stays readable elsewhere but cannot be newly created.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(`../../frontend/js/${relative}`, import.meta.url), 'utf8');
const dialogSource = read('proposals/dialog-create.js');
const coreSource = read('proposals/core.js');
const urbanRulesSource = read('proposals/urban-rules.js');
const createSource = read('proposals/create.js');
const dataSource = read('proposals/data.js');
const editorShellSource = read('proposal-editor-shell.js');

describe('active proposal parcel modes', () => {
    it('offers only unchanged boundaries and land readjustment in the create dialog', () => {
        expect(dialogSource).toContain('name="proposalParcelsMode" value="as-is"');
        expect(dialogSource).toContain('name="proposalParcelsMode" value="readjust"');
        expect(dialogSource).not.toContain('name="proposalParcelsMode" value="merge"');
        expect(dialogSource).not.toContain('parcelsOptions.merge');
    });

    it('cannot derive or serialize a new Decide Later proposal', () => {
        expect(coreSource).not.toContain("if (parcels === 'merge') return 'decide-later';");
        expect(urbanRulesSource).not.toContain("setProposalParcelsMode('merge')");
        expect(createSource).not.toContain('proposal.decideLaterProposal = {');
        expect(editorShellSource).toContain('if (rejectRetiredProposalGoal(proposal)) return null;');
        expect(editorShellSource).toContain('if (rejectRetiredProposalGoal(goal)) return null;');
    });

    it('does not advertise Decide Later as an active proposal-list filter', () => {
        const activeFilterBlock = dataSource.slice(
            dataSource.indexOf('const PROPOSAL_GOAL_FILTERS'),
            dataSource.indexOf('const PROPOSAL_INACTIVE_STATUSES')
        );
        expect(activeFilterBlock).not.toContain("value: 'decide-later'");
    });
});
