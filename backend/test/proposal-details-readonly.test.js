// The proposal details panel's authoring contract (frontend/js/proposals/details-panel.js): Duplicate
// placement and the contextual geometry actions, wired through inlineJsArg, in every language.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const detailsSource = read('../../frontend/js/proposals/details-panel.js');

describe('proposal details authoring contract', () => {
    it('labels fresh pointer placement as Duplicate', () => {
        expect(detailsSource).toContain("panel.proposal.actions.duplicateDesign'");
        expect(detailsSource).toContain("panel.proposal.actions.duplicateDesignHint'");
        expect(detailsSource).toContain('onclick="startDesignDuplication(${inlineJsArg(proposalKey)})"');
        // No proposal id may be pasted raw into an inline handler; see inlineJsArg in shared-utils.js.
        expect(detailsSource).not.toMatch(/on(click|change|input)="[^"]*'\$\{/);
        expect(detailsSource).not.toContain('class="btn btn-primary btn-propose-proposal"');
    });

    it('keeps direct geometry editing as a contextual design action beside Fork', () => {
        expect(detailsSource).toContain('const geometryEditable = proposalKey && !crossSectionButtonHtml');
        expect(detailsSource).toContain("typeof canEditProposalGeometry === 'function'");
        expect(detailsSource).toContain("typeof editProposalGeometry === 'function'");
        expect(detailsSource).toContain('canEditProposalGeometry(fullProposal || proposal)');
        // The edit action is a secondary `btn` (docs/design-language.md) with its hook class.
        expect(detailsSource).toMatch(/class="btn[^"]*btn-edit-geometry"/);
        expect(detailsSource).toContain('onclick="editProposalGeometry(${inlineJsArg(proposalKey)})"');
        expect(detailsSource).toContain('crossSectionButtonHtml + editGeometryButtonHtml');
    });

    // The one in-place geometry action is a road's cross-section — the same rule as its node
    // handles — and only where proposals/road-actions-model.js says it applies.
    it('gates the road cross-section button on RoadActionsModel and runs it through RoadActions', () => {
        expect(detailsSource).toContain('class="btn btn-quiet btn-cross-section"');
        expect(detailsSource).toContain("RoadActionsModel.isActionAvailable('crossSection', roadActionFacts)");
        expect(detailsSource).toContain("onclick=\"RoadActions.runAction('crossSection', RoadActions.factsFor(${inlineJsArg(proposalKey)}))\"");
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s describes click-to-place duplication', locale => {
        const dictionary = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        expect(dictionary.panel.proposal.actions.duplicateDesign).toEqual(expect.any(String));
        expect(dictionary.panel.proposal.actions.duplicateDesign.trim().length).toBeGreaterThan(3);
        expect(dictionary.panel.proposal.actions.duplicateDesignHint).toEqual(expect.any(String));
        expect(dictionary.panel.proposal.actions.duplicateDesignHint.length).toBeGreaterThan(20);
    });
});
