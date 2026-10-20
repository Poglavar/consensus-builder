// Named plans in the app (frontend/js/proposals/plans.js): which plans a proposal is part of, the plan
// line on its row ("Plan: <name>" / "In N named plans"), and the rows of a Plans list. Superseded versions
// are left out everywhere: a revision replaces its predecessor.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Plans = require('../../frontend/js/proposals/plans.js');
const MenuModel = require('../../frontend/js/ui/parcel-menu-model.js');
const plansSource = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/plans.js', import.meta.url)), 'utf8');

function loadBrowserPlans({ yieldToBrowser, now = () => 0, getSerialProposalId } = {}) {
    const root = {
        normalizeCityCodeForApi: () => '', resolveCurrentCityCode: () => '',
        resolveBackendBaseUrl: () => '', getSerialProposalId, yieldToBrowser, performance: { now }
    };
    const module = { exports: {} };
    vm.runInNewContext(plansSource, {
        window: root, module, URLSearchParams, Date, setTimeout,
        fetch: async () => ({ ok: true, json: async () => ({ plans: [{ slug: 'one', proposalRowIds: ['1', '2', '3'] }] }) }),
        console
    });
    return module.exports;
}

const harbor = { slug: 'harbor-v2', title: 'Harbor <b>', proposalRowIds: ['1', '2'], memberCount: 2, superseded: false, author: 'Ana', place: 'Borovje' };
const harborOld = { slug: 'harbor', title: 'Harbor', proposalRowIds: ['1'], memberCount: 1, superseded: true };
const ring = { slug: 'ring-road', title: '', proposalRowIds: ['2', '3'], memberCount: 2, superseded: false, proposalAccount: 'So1anaAccount111' };

describe('which plans a proposal is part of', () => {
    it('does not identify a named-plan member by a numeric local key or an unqualified id', () => {
        const apiBase = 'https://api.example.test';
        const plans = loadBrowserPlans({ getSerialProposalId: record => (
            record?.publicationApiBase === apiBase && /^[1-9]\d*$/.test(String(record.serverProposalId ?? ''))
                ? String(record.serverProposalId) : null
        ) });
        expect(plans.serverIdOfRecord({ proposalId: '42' })).toBeNull();
        expect(plans.serverIdOfRecord({ proposalId: 'p-local', id: 42 })).toBeNull();
        expect(plans.serverIdOfRecord({ proposalId: 'p-local', serverProposalId: 42, publicationApiBase: apiBase })).toBe('42');
    });
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
        expect(html).toContain('Part of named plan Harbor &lt;b&gt;');
        expect(html).not.toContain('proposal-plan-toggle');
    });

    it('folds several plans under "In N named plans" with a link to each', () => {
        const html = Plans.planLineHtml([harbor, ring]);
        expect(html).toContain('In 2 named plans');
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

describe('proposal plan row decoration', () => {
    function fixture(size = 3) {
        const rows = Array.from({ length: size }, (_, index) => ({ id: String(index + 1), line: false,
            querySelector: selector => selector === '.proposal-plan-line' && rows[index].line ? {} : null }));
        const container = { dataset: {}, isConnected: true, addEventListener() {}, querySelectorAll: () => rows };
        return { container, rows };
    }

    it('yields between work slices when the 8ms budget is exhausted', async () => {
        let clock = 0;
        let yields = 0;
        const api = loadBrowserPlans({ now: () => clock += 9, yieldToBrowser: async () => { yields += 1; } });
        const { container, rows } = fixture();
        await api.decorateRows(container, {
            rowSelector: 'row', serverIdOf: row => row.id,
            place: row => { row.line = true; }
        });
        expect(rows.every(row => row.line)).toBe(true);
        expect(yields).toBe(3);
    });

    it('cancels stale work after a yield and leaves existing plan lines alone', async () => {
        let clock = 0;
        let releaseFirstYield;
        let yields = 0;
        const api = loadBrowserPlans({
            now: () => clock += 9,
            yieldToBrowser: () => {
                yields += 1;
                return yields === 1 ? new Promise(resolve => { releaseFirstYield = resolve; }) : Promise.resolve();
            }
        });
        const { container, rows } = fixture();
        let placed = 0;
        const options = { rowSelector: 'row', serverIdOf: row => row.id,
            place: row => { row.line = true; placed += 1; } };
        const staleJob = api.decorateRows(container, options);
        while (!releaseFirstYield) await Promise.resolve();
        const currentJob = api.decorateRows(container, options);
        await currentJob;
        releaseFirstYield();
        await staleJob;
        await api.decorateRows(container, options);
        expect(rows.every(row => row.line)).toBe(true);
        expect(placed).toBe(3);
    });
});
