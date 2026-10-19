// Named plans in the app (frontend/js/proposals/plans.js): which plans a proposal is part of, the plan
// line on its row ("Plan: <name>" / "In N plans"), and the rows of a Plans list. Superseded versions
// are left out everywhere: a revision replaces its predecessor.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Plans = require('../../frontend/js/proposals/plans.js');
const MenuModel = require('../../frontend/js/ui/parcel-menu-model.js');

const harbor = { slug: 'harbor-v2', title: 'Harbor <b>', proposalRowIds: ['1', '2'], memberCount: 2, superseded: false, author: 'Ana', place: 'Borovje' };
const harborOld = { slug: 'harbor', title: 'Harbor', proposalRowIds: ['1'], memberCount: 1, superseded: true };
const ring = { slug: 'ring-road', title: '', proposalRowIds: ['2', '3'], memberCount: 2, superseded: false, proposalAccount: 'So1anaAccount111' };

describe('which plans a proposal is part of', () => {
    it('maps each published proposal row to the current plans naming it, leaving superseded versions out', () => {
        const byMember = Plans.plansByMember([harbor, harborOld, ring]);
        expect(byMember.get('1').map(plan => plan.slug)).toEqual(['harbor-v2']);
        expect(byMember.get('2').map(plan => plan.slug)).toEqual(['harbor-v2', 'ring-road']);
        expect(byMember.get('3').map(plan => plan.slug)).toEqual(['ring-road']);
        expect(byMember.has('4')).toBe(false);
    });

    it('names a plan by its title, else by its name', () => {
        expect(Plans.planLabel(harbor)).toBe('Harbor <b>');
        expect(Plans.planLabel(ring)).toBe('ring-road');
    });
});

describe('the plan line on a proposal row', () => {
    it('links the one plan by name, escaped', () => {
        const html = Plans.planLineHtml([harbor]);
        expect(html).toContain('data-plan-slug="harbor-v2"');
        expect(html).toContain('Part of plan Harbor &lt;b&gt;');
        expect(html).not.toContain('proposal-plan-toggle');
    });

    it('folds several plans under "In N plans" with a link to each', () => {
        const html = Plans.planLineHtml([harbor, ring]);
        expect(html).toContain('In 2 plans');
        expect(html).toContain('class="cb-link proposal-plan-toggle" aria-expanded="false"');
        expect(html).toContain('<ul class="proposal-plan-options" hidden>');
        expect((html.match(/class="cb-link proposal-plan-link"/g) || []).length).toBe(2);
    });

    it('says nothing for a proposal in no current plan', () => {
        expect(Plans.planLineHtml([])).toBe('');
        expect(Plans.planLineHtml([harborOld])).toBe('');
    });
});

describe('a Plans list', () => {
    it('lists current plans with their size, who made them, where, and a pool when one is minted', () => {
        const html = Plans.planRowsHtml([harbor, harborOld, ring]);
        expect(html).toContain('data-plan-slug="harbor-v2"');
        expect(html).toContain('data-plan-slug="ring-road"');
        expect(html).not.toContain('data-plan-slug="harbor"');
        expect(html).toContain('2 proposals');
        expect(html).toContain('Ana · Borovje');
        expect((html.match(/Betting pool/g) || []).length).toBe(1);
        expect(html).toContain('Harbor &lt;b&gt;');
    });

    it('shows the empty text when there is no current plan', () => {
        expect(Plans.planRowsHtml([harborOld], { emptyText: 'None here.' })).toContain('None here.');
    });
});

describe('the parcel menu offers the Proposals tab', () => {
    const facts = overrides => ({ parcelId: 'p1', isRoad: false, multiSelectActive: false, selectionCount: 0, historyIds: ['HR-1-1'], blocksEnabled: true, ...overrides });

    it('on every cadastral parcel, after Details', () => {
        const actions = MenuModel.availableActions(facts());
        expect(actions.indexOf('proposals')).toBe(actions.indexOf('details') + 1);
    });

    it('not on open ground, where no proposal declares a parcel', () => {
        expect(MenuModel.availableActions(facts({ isGround: true }))).not.toContain('proposals');
    });
});
