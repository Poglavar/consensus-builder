// The Plan Stats dialog, actually run.
//
// plan-stats-wiring.test.js reads the source and checks the slots line up; this executes the file
// against a small fake DOM and reads the numbers back out of the elements it built. That is the
// difference between "the strings match" and "opening the dialog does not throw and puts the right
// figure in the right box" — which is the failure a syntax check cannot see and a browser-free
// project would otherwise never catch.
//
// The fake DOM is deliberately tiny: create/append/setAttribute, plus the three querySelector forms
// this dialog uses. It is not a browser; it is enough surface for the file to run on.
import { describe, it, expect, beforeEach } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const planYield = require('../../frontend/js/proposals/plan-yield.js');
const siteStats = require('../../frontend/js/proposals/site-stats.js');
const CbFormat = require('../../frontend/js/format.js');
const CityMoney = require('../../frontend/js/city-money.js');
const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/plan-stats.js', import.meta.url)), 'utf8');

function makeNode(tag) {
    const node = {
        tagName: String(tag).toUpperCase(),
        style: {},
        dataset: {},
        attributes: {},
        children: [],
        listeners: {},
        textContent: '',
        value: '',
        id: '',
        className: '',
        set innerHTML(_) { this.children = []; },
        get innerHTML() { return ''; },
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener() { },
        focus() { },
        matches(selector) {
            const attr = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
            if (attr) {
                const [, name, want] = attr;
                const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                const have = this.attributes[name] ?? (name.startsWith('data-') ? this.dataset[key] : undefined);
                return want === undefined ? have !== undefined : have === want;
            }
            if (selector.startsWith('#')) return this.id === selector.slice(1);
            return false;
        },
        querySelectorAll(selector) {
            const out = [];
            const walk = node => node.children.forEach(child => {
                if (child.matches(selector)) out.push(child);
                walk(child);
            });
            walk(this);
            return out;
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    };
    return node;
}

function makeWindow(proposals, { city = null } = {}) {
    const root = makeNode('root');
    const document = {
        body: root,
        listeners: {},
        createElement: makeNode,
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        getElementById(id) { return root.querySelectorAll(`#${id}`)[0] || null; },
        querySelector(selector) { return root.querySelector(selector); },
        querySelectorAll(selector) { return root.querySelectorAll(selector); }
    };
    const window = {
        document,
        console,
        __planYield: planYield,
        __siteStats: siteStats,
        CbFormat,
        CityMoney: CityMoney.forCity(() => city),
        PlanAnalysis: { prepare: async plan => {
            if (!plan) throw new Error('Choose a plan.');
            if (plan.failure) throw new Error(plan.failure);
            return { plan, records: (plan.records || proposals).map(p => ({ ...p, applied: true })), materializedFeatures: [], cadastralFeatures: [] };
        } },
        CbDialog: { open: options => { window.openedDialog = options; return options; } },
        // Land split and present state: real arithmetic is in present-state.test.js; here the figures
        // only have to reach the right boxes.
        PresentState: {
            // A plan marked withExisting keeps one existing building beside its designs.
            groundOf: async snapshot => {
                if (snapshot.plan?.landFailure) throw new Error(snapshot.plan.landFailure);
                return { land: { publicLandM2: 1200, privateLandM2: 3400 },
                    remaining: snapshot.plan?.withExisting ? [{ ...block(null), proposalId: 'built:w1' }] : [] };
            },
            measure: async ({ title, basis }) => ({ unavailable: false, planTitle: title, proposalsTotal: 0, proposalsCounted: 0,
                yield: planYield.planYield([], { appliedOnly: true }),
                remainingYield: planYield.planYield([block(null), block(null), block(null)], { appliedOnly: true }),
                remainingRecords: [block(null), block(null), block(null)],
                parcelCount: basis.length, parcelMeasuredCount: basis.length, parcelMeasuredArea: 900, openGroundM2: null,
                planAreaM2: 900, publicLandM2: 300, privateLandM2: 600 })
        },
        // Layouts (plan-units.js): none here unless a test lays some out (window.layoutCounts).
        PlanUnits: { forSnapshot: async records => {
            const counted = window.layoutCounts ? await window.layoutCounts(records) : null;
            return { unitsOf: feature => (counted ? counted(feature) : null), laidOut: 0, estimated: 0, reasons: {} };
        } },
        NamedPlans: { list: () => [{ cid: 'other', content: { title: 'Saved elsewhere', view: { city: 'zagreb' } } }] },
        normalizeCityCodeForApi: code => code,
        resolveCurrentCityCode: () => 'zagreb',
        proposalStorage: { getAllProposals: () => { throw new Error('Must not read map designs'); } }
    };
    window.window = window;
    return window;
}

function openDialog(proposals, options = {}) {
    const window = makeWindow(proposals, options);
    vm.runInNewContext(source, {
        window,
        CbFormat,
        globalThis: window,
        document: window.document,
        proposalStorage: window.proposalStorage,
        console
    });
    return window;
}

const rect = (lon0, lat0, lon1, lat1) => [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]];
const SIBENIK = rect(15.8850, 43.7350, 15.8870, 43.7365);

// A prepared plan record carries its design CID as proposalId (PlanAnalysis.prepare).
function block(cid) {
    return {
        applied: true,
        proposalId: cid,
        cadastreParcelIds: ['HR-330264-628'],
        buildingProposal: {
            parameters: { rule: { minHeightM: 17.5, maxHeightM: 17.5, floorHeightM: 3.5 } },
            buildings: [{
                type: 'Feature',
                properties: { type: 'proposedBuilding', height: 17.5 },
                geometry: { type: 'Polygon', coordinates: SIBENIK }
            }]
        }
    };
}

const slot = (window, key) => window.document.querySelector(`[data-plan-stat="${key}"]`).textContent;
// The leading number of a cell, thousands separators removed. Several cells read "3 (380,583 m²)",
// where it is the count being checked and the parenthesis is the detail beside it.
const digits = text => Number(String(text).split('(')[0].replace(/[^\d]/g, '') || 0);

let plan;

beforeEach(() => {
    plan = [block('d-2035'), block('d-2045'), block('d-unscheduled'), { applied: false, buildingProposal: { buildings: [] } }];
});

describe('opening the dialog', () => {
    it('builds it and fills every figure, without throwing', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        ['resulting-parcels', 'buildings', 'floor-area', 'apartments', 'people', 'jobs', 'sales-value']
            .forEach(key => expect(slot(window, key), key).not.toBe('—'));
        expect(window.document.getElementById('plan-stats-modal').hidden).toBe(false);
    });

    // The sales price is the city's money: a UK plan is priced per m² in pounds from the UK default.
    it('prices the floor area in the city currency', async () => {
        const uk = openDialog(plan, { city: { currency: { code: 'GBP' } } });
        await uk.showPlanStatsModal({ content: { title: 'Garden plan' } });
        expect(slot(uk, 'sales-value')).toMatch(/GBP$/);
        expect(uk.document.getElementById('plan-stats-price').value).toBe('4000');
        const suffix = uk.document.querySelector('[for="plan-stats-price"]');
        expect(suffix.textContent).toBe('GBP per m²');
        expect(JSON.parse(suffix.attributes['data-i18n-params'])).toEqual({ currency: 'GBP' });

        const hr = openDialog(plan, { city: { currency: { code: 'EUR' } } });
        await hr.showPlanStatsModal({ content: { title: 'Garden plan' } });
        expect(slot(hr, 'sales-value')).toMatch(/EUR$/);
        expect(hr.document.getElementById('plan-stats-price').value).toBe('4000');
    });

    it('names the plan and counts every member, including unapplied designs', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        expect(slot(window, 'scope')).toContain('Garden plan');
        expect(slot(window, 'scope')).toContain('4');
    });

    it('agrees with plan-yield rather than computing its own answer', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        const expected = planYield.planYield(plan.map(p => ({ ...p, applied: true })), { appliedOnly: true });
        expect(digits(slot(window, 'apartments'))).toBe(expected.total.apartments);
        expect(digits(slot(window, 'people'))).toBe(expected.total.people);
        expect(digits(slot(window, 'buildings'))).toBe(expected.total.buildings);
    });

    it('counts the parcels the plan leaves standing, not the ones the map drew', async () => {
        // Three building proposals on the same parcel, no map loaded at all: one parcel standing,
        // and an average it honestly declines to state.
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        expect(slot(window, 'resulting-parcels')).toBe('1');
        expect(slot(window, 'notes')).toMatch(/1/);
    });
});

// Open ground (PARCEL-OPTIONAL.md phase 6): a proposal with an empty binding has a site and
// buildings but no parcels. Its floor area is a site figure and is shown; its parcel count is a
// binding figure and reads "No parcels here" — never a 0 that looks measured.
describe('a plan on open ground', () => {
    const site = { type: 'MultiPolygon', coordinates: [SIBENIK] };
    const onOpenGround = (unsurveyedM2, parcels = []) => ({
        ...block(null),
        cadastreParcelIds: parcels,
        site,
        binding: { parcels: parcels.map(parcelId => ({ parcelId })), coverage: parcels.length ? 'partial' : 'none', unsurveyedM2, siteM2: 25000 }
    });

    it('says there are no parcels instead of counting 0, and still measures the floor area', async () => {
        const window = openDialog([onOpenGround(25000)]);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        expect(slot(window, 'resulting-parcels')).toBe('No parcels here');
        expect(digits(slot(window, 'floor-area'))).toBeGreaterThan(0);
        expect(digits(slot(window, 'buildings'))).toBe(1);
        expect(slot(window, 'notes')).toMatch(/Open ground: 25,000 m²/);
        expect(slot(window, 'notes')).not.toMatch(/average parcel size/);
    });

    it('a partly bound plan counts its bound parcels and shows the open ground beside them', async () => {
        const window = openDialog([onOpenGround(300, ['HR-330264-700'])]);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        expect(slot(window, 'resulting-parcels')).toBe('1');
        expect(slot(window, 'notes')).toMatch(/Open ground: 300 m²/);
    });

    it('a cadastral plan shows no open-ground note', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        expect(slot(window, 'notes')).not.toMatch(/Open ground/);
    });
});

describe('changing an assumption', () => {
    it('accepts zero housing share without falling back to the default', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });
        const floorArea = slot(window, 'floor-area');
        const input = window.document.getElementById('plan-stats-housing-share');
        input.value = '0';
        input.listeners.input.forEach(fn => fn());
        expect(digits(slot(window, 'apartments'))).toBe(0);
        expect(digits(slot(window, 'people'))).toBe(0);
        expect(slot(window, 'floor-area')).toBe(floorArea);
    });

    it('moves every derived figure at once', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        const before = digits(slot(window, 'apartments'));
        const input = window.document.getElementById('plan-stats-apartment-size');
        input.value = '130';                       // twice the default → about half the apartments
        input.listeners.input.forEach(fn => fn());

        const after = digits(slot(window, 'apartments'));
        expect(after).toBeLessThan(before);
        expect(after).toBeGreaterThan(0);
        // People follow apartments; a stale people count beside a fresh apartment count is exactly
        // the disagreement re-deriving everything is meant to prevent.
        expect(digits(slot(window, 'people'))).toBe(Math.round(after * 2.4));
    });

    it('leaves the measured figures where they were', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        const floorArea = slot(window, 'floor-area');
        const input = window.document.getElementById('plan-stats-housing-share');
        input.value = '40';
        input.listeners.input.forEach(fn => fn());

        expect(slot(window, 'floor-area')).toBe(floorArea);
    });
});

describe('the period table', () => {
    // Periods come from the plan's schedule: the year each member's construction window ends.
    const scheduled = { title: 'Garden plan', schedule: {
        'd-2035': { start: '2034-03', end: '2035-11' },
        'd-2045': { start: '2045-01', end: '2045-12' }
    } };

    it('lists the year each construction window ends in, plus the unscheduled designs', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: scheduled });

        const table = window.document.querySelector('[data-plan-stat="period-table"]');
        const rows = table.children[0].children;
        expect(rows).toHaveLength(4);                    // header + 2035 + 2045 + no period
        expect(rows[1].children[0].textContent).toBe('2035');
        expect(rows[1].children[1].textContent).toBe('1');
        expect(rows[2].children[0].textContent).toBe('2045');
        expect(rows[3].children[0].textContent).toBe('no period');
    });

    it('switches to standing totals, where the unscheduled ones are already inside each year', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: scheduled });

        const toggle = window.document.querySelector('[data-period-view="cumulative"]');
        toggle.listeners.click.forEach(fn => fn());

        const rows = window.document.querySelector('[data-plan-stat="period-table"]').children[0].children;
        expect(rows).toHaveLength(3);                    // header + 2035 + 2045, no separate unscheduled row
        const added = digits(rows[1].children[1].textContent);
        const standing = digits(rows[2].children[1].textContent);
        expect(standing).toBeGreaterThan(added);
    });

    it('stays hidden when the plan schedules no member', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });

        expect(window.document.querySelector('[data-plan-stat="period-section"]').hidden).toBe(true);
    });
});

// Compare plans: each plan measured as Plan stats measures one, side by side, turnable.
describe('comparing plans', () => {
    const textOf = node => node.textContent + node.children.map(textOf).join('');
    const rowsOf = table => table.children.map(tr => tr.children.map(textOf));
    const tableOf = window => window.openedDialog.body.querySelectorAll('[data-plan-compare]')[0]
        || (function find(node) { if (node.dataset?.planCompare) return node; for (const child of node.children) { const hit = find(child); if (hit) return hit; } return null; })(window.openedDialog.body);

    it('shows every plan’s figures in its own column, and swaps to plans as rows', async () => {
        const window = openDialog(plan);
        await window.comparePlanStats([
            { content: { title: 'Two blocks' }, records: [block('d-1'), block('d-2')], withExisting: true },
            { content: { title: 'One block' }, records: [block('d-1')], withExisting: true },
            { content: { title: 'Broken' }, failure: 'Parcel coverage is unavailable.' }
        ]);
        // The present state is measured after the dialog opens; let its promise settle.
        await new Promise(resolve => setImmediate(resolve));
        const basis = (function find(node) { if (node.dataset && 'planCompareBasis' in node.dataset) return node; for (const child of node.children) { const hit = find(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        expect(basis.children.map(option => [option.value, option.textContent])).toEqual([
            ['compared', 'All compared plans'], ['plan:0', 'Two blocks'], ['plan:1', 'One block'], ['saved:other', 'Saved elsewhere']]);
        expect(window.openedDialog.title).toBe('Compare plans');
        let rows = rowsOf(tableOf(window));
        expect(rows[0]).toEqual(['', 'Present state', 'Two blocks', 'One block', 'BrokenNot measured: Parcel coverage is unavailable.']);
        const buildings = rows.find(row => row[0].startsWith('Buildings'));
        // Standing buildings: the present state's three existing ones; each plan's new ones plus the
        // one existing building it leaves.
        expect(digits(buildings[1])).toBe(3);
        expect(digits(buildings[2])).toBe(3);
        expect(digits(buildings[3])).toBe(2);
        expect(buildings[4]).toBe('—');
        const remaining = rows.find(row => row[0].startsWith('of which existing'));
        const added = rows.find(row => row[0].startsWith('of which new'));
        expect([remaining[1], remaining[2]].map(digits)).toEqual([3, 1]);
        expect([added[1], added[2], added[3]].map(digits)).toEqual([0, 2, 1]);
        expect(rows).toHaveLength(1 + 13);
        expect(rows.find(row => row[0].startsWith('Public land')).slice(1, 3)).toEqual(['300', '1,200']);
        expect(rows.find(row => row[0].startsWith('Private land')).slice(1, 3)).toEqual(['600', '3,400']);

        const swap = (function find(node) { if (node.dataset && 'planCompareSwap' in node.dataset) return node; for (const child of node.children) { const hit = find(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        swap.listeners.click.forEach(fn => fn());
        expect(swap.getAttribute('aria-pressed')).toBe('true');
        rows = rowsOf(tableOf(window));
        expect(rows).toHaveLength(1 + 4);
        expect(rows[0]).toHaveLength(1 + 13);
        expect(rows[0][0]).toBe('Plan');
        expect(rows[1][0]).toBe('Present state');
        expect(rows[2][0]).toBe('Two blocks');
        expect(rows[0].findIndex(label => label.startsWith('Buildings'))).toBeGreaterThan(0);
        swap.listeners.click.forEach(fn => fn());
    });

    it('compares designs as one-member plans, names them designs, and puts the first two with a map side under the divider', async () => {
        const window = openDialog(plan);
        const shown = [];
        window.ThreeCompare = { show: sides => shown.push(sides) };
        await window.comparePlanStats([
            { content: { title: 'North block' }, records: [block('d-1')] },
            { content: { title: 'Fetched block' }, records: [block('d-2')] },
            { content: { title: 'South block' }, records: [block('d-3')] }
        ], { subject: 'designs', sides: ['design:d-1', null, 'design:d-3'] });
        await new Promise(resolve => setImmediate(resolve));
        const find = test => (function walk(node) { if (test(node)) return node; for (const child of node.children) { const hit = walk(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        expect(window.openedDialog.title).toBe('Compare designs');
        expect(find(node => node.dataset && 'planCompareBasis' in node.dataset).children[0].textContent).toBe('All compared designs');
        expect(rowsOf(tableOf(window))[0]).toEqual(['', 'Present state', 'North block', 'Fetched block', 'South block']);
        const swap = find(node => node.dataset && 'planCompareSwap' in node.dataset);
        swap.listeners.click.forEach(fn => fn());
        expect(rowsOf(tableOf(window))[0][0]).toBe('Design');
        swap.listeners.click.forEach(fn => fn());
        const sideBySide = find(node => node.dataset && 'planCompareSideBySide' in node.dataset);
        expect(sideBySide.disabled).toBe(false);
        sideBySide.listeners.click.forEach(fn => fn());
        // The design fetched only for the comparison is not a side on the map; the next one is.
        expect(shown).toEqual([{ left: 'design:d-1', right: 'design:d-3' }]);
    });

    it('compares agreements through their plans under the agreements\' own titles, with their map sides', async () => {
        const window = openDialog(plan);
        const shown = [];
        window.ThreeCompare = { show: sides => shown.push(sides) };
        await window.comparePlanStats([
            { cid: 'plan-1', content: { title: 'Shared plan' }, records: [block('d-1')] },
            { cid: 'plan-2', content: { title: 'Shared plan' }, records: [block('d-2')] }
        ], { subject: 'agreements', titles: ['Owners deal', 'Community vote'], sides: ['agreement:a-1', 'agreement:a-2'] });
        await new Promise(resolve => setImmediate(resolve));
        const find = test => (function walk(node) { if (test(node)) return node; for (const child of node.children) { const hit = walk(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        expect(window.openedDialog.title).toBe('Compare agreements');
        const basis = find(node => node.dataset && 'planCompareBasis' in node.dataset);
        expect(basis.children.slice(0, 3).map(option => option.textContent)).toEqual(['All compared agreements', 'Owners deal', 'Community vote']);
        expect(rowsOf(tableOf(window))[0]).toEqual(['', 'Present state', 'Owners deal', 'Community vote']);
        const swap = find(node => node.dataset && 'planCompareSwap' in node.dataset);
        swap.listeners.click.forEach(fn => fn());
        expect(rowsOf(tableOf(window))[0][0]).toBe('Agreement');
        find(node => node.dataset && 'planCompareSideBySide' in node.dataset).listeners.click.forEach(fn => fn());
        expect(shown).toEqual([{ left: 'agreement:a-1', right: 'agreement:a-2' }]);
    });

    it('puts the agreements\' terms above what their plans build, marks the ones they differ in, and can show only those', async () => {
        const window = openDialog(plan);
        const asked = [];
        window.AgreementPanel = { compareTerms: (agreements, _tr, options) => {
            asked.push({ ids: agreements.map(agreement => agreement.id), summaryText: options.summaryText });
            return [
                { key: 'rule', label: 'Decision rule', values: ['Owners · Binding', 'Community · Non-binding'], differs: true },
                { key: 'inputs', label: 'Input parcels', values: ['2 · 1,000 m²', '2 · 1,000 m²'], differs: false }
            ];
        } };
        await window.comparePlanStats([
            { cid: 'plan-1', content: { title: 'Shared plan' }, records: [block('d-1')] },
            { cid: 'plan-1', content: { title: 'Shared plan' }, records: [block('d-1')] }
        ], { subject: 'agreements', titles: ['Owners deal', 'Community vote'], terms: [{ id: 'a-1', title: 'Owners deal' }, { id: 'a-2', title: 'Community vote' }] });
        expect(asked).toEqual([{ ids: ['a-1', 'a-2'], summaryText: null }]);
        const find = test => (function walk(node) { if (test(node)) return node; for (const child of node.children) { const hit = walk(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        const section = find(node => node.dataset && 'planCompareTerms' in node.dataset);
        expect(window.openedDialog.body.children.indexOf(section)).toBe(0);
        const terms = find(node => node.tagName === 'TABLE' && node.className.includes('plan-compare__terms-table'));
        expect(rowsOf(terms)).toEqual([['', 'Owners deal', 'Community vote'], ['Decision ruleDiffers', 'Owners · Binding', 'Community · Non-binding'], ['Input parcels', '2 · 1,000 m²', '2 · 1,000 m²']]);
        const only = find(node => node.dataset && 'planCompareDiffering' in node.dataset);
        only.checked = true;
        only.listeners.change.forEach(fn => fn());
        expect(terms.children.slice(1).map(tr => !!tr.hidden)).toEqual([false, true]);
        only.checked = false;
        only.listeners.change.forEach(fn => fn());
        expect(terms.children.slice(1).map(tr => !!tr.hidden)).toEqual([false, false]);
    });

    it('re-derives every column from its own assumptions, says the rule, and keeps them for Plan stats', async () => {
        const window = openDialog(plan);
        await window.comparePlanStats([{ content: { title: 'Two blocks' }, records: [block('d-1'), block('d-2')], withExisting: true }]);
        await new Promise(resolve => setImmediate(resolve));
        const body = window.openedDialog.body;
        const apartments = () => rowsOf(tableOf(window)).find(row => row[0] === 'Apartments').slice(1).map(digits);
        const before = apartments();
        expect(before.every(count => count > 0)).toBe(true);
        expect(textOf(body.querySelector('[data-plan-compare-rule]'))).toBe(
            'A building with a suggested layout counts its apartments; any other: gross floor area × 80 % net × 75 % housing ÷ 65 m² per apartment. People = apartments × 2.4.');
        const size = body.querySelector('#plan-compare-apartment-size');
        size.value = '130';
        size.listeners.input.forEach(fn => fn());
        // Twice the apartment size, half the apartments (rounded down), in the present state too.
        expect(apartments()).toEqual(before.map(count => Math.floor(count / 2)));
        expect(textOf(body.querySelector('[data-plan-compare-rule]'))).toContain('÷ 130 m² per apartment');
        await window.showPlanStatsModal({ content: { title: 'Garden plan' } });
        expect(window.document.getElementById('plan-stats-apartment-size').value).toBe('130');
    });
});

describe('apartments counted from layouts in Compare plans', () => {
    const textOf = node => node.textContent + node.children.map(textOf).join('');
    const findAll = (node, test, out = []) => { node.children.forEach(child => { if (test(child)) out.push(child); findAll(child, test, out); }); return out; };
    it('spins in the Apartments and People cells until the buildings are laid out, then says how many were', async () => {
        const window = openDialog(plan);
        let release;
        const laidOut = new Promise(resolve => { release = resolve; });
        // Every new building lays out as 7 apartments once released; the existing ones keep the rule.
        window.layoutCounts = async records => {
            await laidOut;
            return () => (records.some(r => String(r.proposalId).startsWith('d-')) ? { apartments: 7, shopNetM2: 0 } : null);
        };
        await window.comparePlanStats([{ content: { title: 'Two blocks' }, records: [block('d-1'), block('d-2')] }]);
        await new Promise(resolve => setImmediate(resolve));
        const cells = () => findAll(window.openedDialog.body, node => node.tagName === 'TD');
        const counting = () => cells().filter(cell => String(cell.className).includes('plan-stats-counting')).map(textOf);
        expect(counting()).toEqual(['Counting…', 'Counting…', 'Counting…', 'Counting…']);
        release();
        for (let i = 0; i < 10 && counting().length; i++) await new Promise(resolve => setImmediate(resolve));
        expect(counting()).toEqual([]);
        expect(cells().map(textOf)).toContain('14 (2 of 2 buildings laid out)');
    });
});

describe('public and private land in Plan stats', () => {
    it('fills the land figures once the parks and squares are read', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' }, withExisting: true });
        expect(slot(window, 'public-land')).toBe('1,200');
        expect(slot(window, 'private-land')).toBe('3,400');
        // Three blocks and the one existing building that remains stand after the plan.
        expect(digits(slot(window, 'buildings'))).toBe(4);
        expect(digits(slot(window, 'buildings-remaining'))).toBe(1);
        expect(digits(slot(window, 'buildings-new'))).toBe(3);
    });

    it('says why when they cannot be read, and keeps every other figure', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal({ content: { title: 'Garden plan' }, landFailure: 'Overpass is busy' });
        expect(slot(window, 'public-land')).toBe('—');
        expect(slot(window, 'notes')).toContain('Existing buildings and public land could not be read: Overpass is busy');
        expect(slot(window, 'buildings-remaining')).toBe('—');
        expect(digits(slot(window, 'buildings'))).toBeGreaterThan(0);
    });
});
