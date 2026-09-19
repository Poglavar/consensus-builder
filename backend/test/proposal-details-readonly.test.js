import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const detailsSource = read('../../frontend/js/proposals/details-panel.js');

describe('proposal details authoring contract', () => {
    it('labels cloning as Counterpropose / Fork instead of presenting it as Details', () => {
        expect(detailsSource).toContain("panel.proposal.actions.counterpropose");
        expect(detailsSource).toContain("panel.proposal.actions.counterproposeHint");
        expect(detailsSource).toContain("onclick=\"proposeExistingProposal('${proposalKey}')\"");
        expect(detailsSource).not.toContain('class="btn btn-primary btn-propose-proposal"');
    });

    it('does not expose direct geometry editors from the read-only details footer', () => {
        expect(detailsSource).not.toContain('class="btn btn-outline-secondary btn-cross-section"');
        expect(detailsSource).not.toContain('class="btn btn-outline-secondary btn-edit-geometry"');
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s explains that the fork leaves its source unchanged', locale => {
        const dictionary = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        expect(dictionary.panel.proposal.actions.counterpropose).toEqual(expect.any(String));
        expect(dictionary.panel.proposal.actions.counterproposeHint).toEqual(expect.any(String));
        expect(dictionary.panel.proposal.actions.counterproposeHint.length).toBeGreaterThan(20);
    });
});
