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
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readSource } from './helpers/read-source.js';

const require = createRequire(import.meta.url);
const planYield = require('../../frontend/js/proposals/plan-yield.js');
const siteStats = require('../../frontend/js/proposals/site-stats.js');
const CbFormat = require('../../frontend/js/format.js');
const CityMoney = require('../../frontend/js/city-money.js');
const planScope = require('../../frontend/js/proposals/plan-scope.js');
const turf = require('@turf/turf');
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
        // Published agreements on a plan are read from our server's index (chain/read-source.js).
        ReadSource: readSource('server'),
        __planYield: planYield,
        __siteStats: siteStats,
        __planScope: planScope,
        __planDecision: require('../../frontend/js/proposals/plan-decision.js'),
        BuildingDensityStats: require('../../frontend/js/building-density-stats.js'),
        turf,
        CbFormat,
        CityMoney: CityMoney.forCity(() => city),
        EconomicSources: require('../../frontend/js/economic-sources.js'),
        PlanAnalysis: { prepare: async plan => {
            if (!plan) throw new Error('Choose a plan.');
            if (plan.failure) throw new Error(plan.failure);
            return { plan, records: (plan.records || proposals).map(p => ({ ...p, applied: true })), materializedFeatures: [], cadastralFeatures: plan.parcels || [],
                landFeature: plan.landFeature || null };
        } },
        CbDialog: { open: options => { window.openedDialog = options; return options; } },
        // Land split and present state: real arithmetic is in present-state.test.js; here the figures
        // only have to reach the right boxes.
        PresentState: {
            ops: { intersect: (a, b) => turf.intersect(a, b), areaOf: feature => planYield.geometryAreaM2(feature) },
            // A plan marked withExisting keeps one existing building beside its designs.
            groundOf: async snapshot => {
                if (snapshot.plan?.landFailure) throw new Error(snapshot.plan.landFailure);
                return { land: { publicLandM2: 1200, privateLandM2: 3400 },
                    remaining: snapshot.plan?.withExisting ? [{ ...block(null), proposalId: 'built:w1' }] : [],
                    // A plan marked cleared clears those existing buildings ({ before, after }).
                    cleared: snapshot.plan?.cleared || [] };
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
        console,
        AbortController,
        AbortSignal
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
        // A place with money: without a currency there is no price, and the sales value reads "—".
        const window = openDialog(plan, { city: { currency: { code: 'EUR' } } });
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
        expect(suffix.textContent).toBe('GBP per m² sale price');
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

    it('opens first with the exact member count for a large plan', async () => {
        const members = Array.from({ length: 113 }, (_, index) => block(`member-${index}`));
        const window = openDialog(members);
        await window.showPlanStatsModal({ content: { title: 'Courtyard' } });
        expect(slot(window, 'scope')).toContain('Courtyard');
        expect(slot(window, 'scope')).toContain('113');
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

    it('cancels delayed comparison preparation without allowing stale completion', async () => {
        const window = openDialog(plan);
        let fastResolve, slowResolve;
        window.PlanAnalysis.prepare = vi.fn(p => new Promise(resolve => {
            if (p.content.title === 'Fast') fastResolve = resolve; else slowResolve = resolve;
        }));
        const pending = window.comparePlanStats([{ cid: 'fast', content: { title: 'Fast' } }, { cid: 'slow', content: { title: 'Slow' } }]);
        await new Promise(resolve => setImmediate(resolve));
        expect(window.PlanAnalysis.prepare).toHaveBeenCalledTimes(2);
        window.openedDialog.onClose();
        fastResolve({ plan: { content: { title: 'Fast' } }, records: [], materializedFeatures: [], cadastralFeatures: [], landFeature: null, corridorFeatures: [] });
        slowResolve({ plan: { content: { title: 'Slow' } }, records: [], materializedFeatures: [], cadastralFeatures: [], landFeature: null, corridorFeatures: [] });
        await pending;
        expect(window.openedDialog.onClose).toBeTypeOf('function');
    });

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
        // A column that could not be measured says why and offers to measure it again.
        expect(rows[0]).toEqual(['', 'Present state', 'Two blocks', 'One block', 'BrokenNot measured: Parcel coverage is unavailable.Measure again']);
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
        expect(rows).toHaveLength(1 + 27);
        expect(rows.find(row => row[0].startsWith('Public land')).slice(1, 3)).toEqual(['300', '1,200']);
        expect(rows.find(row => row[0].startsWith('Private land')).slice(1, 3)).toEqual(['600', '3,400']);

        const swap = (function find(node) { if (node.dataset && 'planCompareSwap' in node.dataset) return node; for (const child of node.children) { const hit = find(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        swap.listeners.click.forEach(fn => fn());
        expect(swap.getAttribute('aria-pressed')).toBe('true');
        rows = rowsOf(tableOf(window));
        expect(rows).toHaveLength(1 + 4);
        expect(rows[0]).toHaveLength(1 + 27);
        expect(rows[0][0]).toBe('Plan');
        expect(rows[1][0]).toBe('Present state');
        expect(rows[2][0]).toBe('Two blocks');
        expect(rows[0].findIndex(label => label.startsWith('Buildings'))).toBeGreaterThan(0);
        swap.listeners.click.forEach(fn => fn());
    });

    it('measures every plan on one parcel they stand on, and on all their land again', async () => {
        // Two parcels splitting the block down the middle; each design stands on both.
        const parcel = (id, ring) => ({ type: 'Feature', id, properties: { parcelId: id, parcelNumber: id }, geometry: { type: 'Polygon', coordinates: ring } });
        const west = parcel('W-1', rect(15.8850, 43.7350, 15.8860, 43.7365));
        const east = parcel('E-1', rect(15.8860, 43.7350, 15.8870, 43.7365));
        const onBoth = cid => ({ ...block(cid), cadastreParcelIds: ['W-1', 'E-1'] });
        const window = openDialog(plan);
        await window.comparePlanStats([
            { content: { title: 'Two blocks' }, records: [onBoth('d-1'), onBoth('d-2')], parcels: [west, east] },
            { content: { title: 'One block' }, records: [onBoth('d-1')], parcels: [west, east] }
        ]);
        const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
        await settle();
        const find = key => (function walk(node) { if (node.dataset && key in node.dataset) return node; for (const child of node.children) { const hit = walk(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        const scope = find('planCompareScope');
        expect(scope.children.map(option => option.value)).toEqual(['all', 'parcel:0', 'parcel:1']);
        expect(scope.children[0].textContent).toBe('All their land');
        expect(scope.children[1].textContent).toMatch(/^Parcel E-1 \([\d,]+ m²\)$/);
        const floorArea = () => rowsOf(tableOf(window)).find(row => row[0].startsWith('Gross floor area')).slice(2).map(digits);
        const whole = floorArea();
        expect(whole[0]).toBeGreaterThan(0);
        // The cells are rounded to whole square metres.
        expect(Math.abs(whole[0] - whole[1] * 2)).toBeLessThanOrEqual(1);

        scope.value = 'parcel:1';
        scope.listeners.change.forEach(fn => fn());
        await settle();
        const onWest = floorArea();
        // Half of each building stands on the west parcel.
        expect(onWest[0] / whole[0]).toBeCloseTo(0.5, 1);
        expect(onWest[1] / whole[1]).toBeCloseTo(0.5, 1);
        expect(find('planCompareBasis')).not.toBeNull();
        const note = (function walk(node) { if (String(node.className || '').includes('plan-compare__scope-note')) return node; for (const child of node.children) { const hit = walk(child); if (hit) return hit; } return null; })(window.openedDialog.body);
        expect(note.hidden).toBe(false);

        scope.value = 'all';
        scope.listeners.change.forEach(fn => fn());
        await settle();
        expect(floorArea()).toEqual(whole);
        expect(note.hidden).toBe(true);
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
            'Count apartments directly when there is an estimated layout. Otherwise: gross floor area × 80 % net × 75 % housing ÷ 65 m² per apartment. People = apartments × 2.4.');
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

describe('Compare plans as a decision sheet', () => {
    const textOf = node => node.textContent + node.children.map(textOf).join('');
    const rowsOf = table => table.children.map(tr => tr.children.map(textOf));
    const find = (window, test) => (function walk(node) { if (test(node)) return node; for (const child of node.children) { const hit = walk(child); if (hit) return hit; } return null; })(window.openedDialog.body);
    const tableOf = window => find(window, node => node.dataset?.planCompare === 'plans-as-columns');
    const row = (window, label) => rowsOf(tableOf(window)).find(cells => cells[0].startsWith(label));
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
    const land = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: SIBENIK } };
    const ROUND = 'bafkreigmrraldkjtmcgcxfkq6gdhx55uyi3k7sbxjjqs27tzyeuakl634m';
    const SPONSOR = '4EXtquCoNRBXvfVgDRfBSXSWzrBctcqLwwUau96Umeqk';
    const round = { cid: ROUND, planCid: 'plan-1', onchain: { chain: 'solana', cluster: 'devnet', account: 'J9uyaoKFhkmi7XTtxZQ6VoJiDDLvTWoNkKwx1GfjEbK9', status: 'active' },
        content: { title: 'Developer round', sponsor: SPONSOR, deadline: '2027-11-24T12:00:00.000Z',
            rule: { electorate: 'investors', binding: true, lens: ['m8gLfyPspP6ABSNA4ZMFYCzzRGjNLBmrKKwKrGqbUfR', 'Bd3bVJQDjbUkJVDWtqBSHyyJQ7bkJKbTcSvzRJVqd4zY'] },
            funding: { targetUsdcAtomic: '2500000000' } } };
    function decisionWindow({ funding = null, permitted = null } = {}) {
        const window = openDialog(plan);
        window.getBackendBase = () => 'https://api.test';
        window.fetch = async () => { throw new Error('no network'); };
        window.AgreementRecord = require('../../frontend/js/agreement-record.js');
        window.AgreementBridge = require('../../frontend/js/solana/agreement-bridge.js');
        window.DesignMemberships = { fetchPage: async ({ planCid, offset }) => ({ items: planCid === 'plan-1' && offset === 0 ? [round] : [], nextOffset: null }),
            localAgreements: () => [] };
        const fundingModel = require('../../frontend/js/solana/funding-progress.js');
        window.FundingProgress = { isCrowdfunding: fundingModel.isCrowdfunding, read: async rows => {
            window.fundingRead = rows.map(row => row.cid);
            return new Map(rows.map(item => [item.cid, funding || { state: 'failed', reason: 'RPC 429' }]));
        }, textOf: progress => fundingModel.progressText(progress, { t: (key, fallback, params) => fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name]),
            formatUsdc: window.AgreementRecord.formatUsdc, formatInteger: String }) };
        if (permitted) { window.PermittedCheck = {}; window.PermittedAdvisor = { checkPlan: permitted }; }
        window.FileDownload = { save: (_win, content, name) => { window.saved = { content, name }; } };
        // The decision rule in the agreement panel's own words.
        window.AgreementPanel = { ruleShort: rule => `${rule.electorate === 'investors' ? 'Developer crowdfunding' : rule.electorate} · ${rule.binding ? 'Binding' : 'Non-binding'}`,
            chainStatusText: status => status };
        return window;
    }

    it('adds the built form, demolition, build-out, Permitted limits and backing to each column', async () => {
        const window = decisionWindow({
            funding: { state: 'read', chainStatus: 'Active', raisedUsdcAtomic: 1000000000n, targetUsdcAtomic: 2500000000n, contributors: 3, apartmentsOffered: null },
            permitted: async ({ buildings }) => ({ status: 'fail', buildings: { [buildings[0].id]: 'fail', [buildings[1].id]: 'pass' } }) });
        await window.comparePlanStats([{ cid: 'plan-1', landFeature: land,
            content: { title: 'Two blocks', schedule: { 'd-1': { end: '2030-06-01' }, 'd-2': { end: '2032-01-01' } } },
            records: [block('d-1'), block('d-2')],
            cleared: [{ before: { ...block(null), proposalId: 'built:x' }, after: null }] }]);
        await settle();
        expect(row(window, 'New buildings: maximum height')[2]).toBe('17.5 m · 5 storeys');
        // Two 5-storey blocks over the same land: twice the land in floor area per storey.
        expect(row(window, 'Floor-area ratio')[2]).toBe('10.00');
        expect(row(window, 'Site coverage')[2]).toContain('100');
        expect(row(window, 'Existing buildings demolished')[2]).toMatch(/^1 whole, 0 in part · /);
        expect(row(window, 'Build-out by period')[2]).toBe('2030–2032 · 2 periods');
        expect(row(window, 'Permitted limits')[2]).toMatch(/^1 of 2 buildings break limits \(/);
        expect(row(window, 'Green area')[2]).toBe('0');
        const backing = row(window, 'Agreements backing the plan')[2];
        expect(backing).toContain('Developer round');
        expect(backing).toContain('Developer crowdfunding · Binding');
        expect(backing).toContain('Lead: 4EXt…meqk');
        expect(backing).toContain('Any 1 of 2 must confirm.');
        expect(backing).toContain('Target 2500 USDC by');
        expect(backing).toContain('1000 of 2500 USDC raised · 3 contributors');
        expect(window.fundingRead).toEqual([ROUND]);
        // The present state is the baseline: no backing or limits of its own.
        expect(row(window, 'Agreements backing the plan')[1]).toBe('—');
        const lead = find(window, node => node.tagName === 'A');
        expect(lead.href).toBe(`https://explorer.solana.com/address/${SPONSOR}?cluster=devnet`);
    });

    it('says why a figure is missing instead of a 0', async () => {
        const window = decisionWindow({ permitted: async () => ({ status: 'unavailable', buildings: {}, checks: [], reason: 'Planning sources HTTP 503' }) });
        await window.comparePlanStats([{ content: { title: 'Unpublished' }, records: [{ ...block('d-1'), buildingProposal: { buildings: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: SIBENIK } }] } }] },
            { cid: 'plan-1', content: { title: 'Published' }, records: [block('d-1')] }]);
        await settle();
        // A building that states no height has no tallest height; a plan without land has no ratios.
        expect(row(window, 'New buildings: maximum height')[2]).toBe('—');
        expect(row(window, 'Floor-area ratio')[2]).toBe('—');
        expect(row(window, 'Build-out by period')[2]).toBe('No schedule');
        expect(row(window, 'Permitted limits')[2]).toBe('Not checked: Planning sources HTTP 503');
        expect(row(window, 'Agreements backing the plan')[2]).toBe('Plan not published: no agreements');
        // A chain read that failed says so rather than reading as nothing raised.
        expect(row(window, 'Agreements backing the plan')[3]).toContain('Chain not read: RPC 429');
    });

    it('measures a column again after a passing failure, and adds it to the scope and basis choices', async () => {
        const window = decisionWindow();
        const prepare = window.PlanAnalysis.prepare;
        let failures = 1;
        window.PlanAnalysis.prepare = async (p, options) => {
            if (p.content.title === 'Flaky' && failures-- > 0) throw new Error('HTTP 500');
            return prepare(p, options);
        };
        await window.comparePlanStats([{ content: { title: 'Steady' }, records: [block('d-1')] }, { content: { title: 'Flaky' }, records: [block('d-1'), block('d-2')] }]);
        await settle();
        expect(rowsOf(tableOf(window))[0][3]).toBe('FlakyNot measured: HTTP 500Measure again');
        const basis = find(window, node => node.dataset && 'planCompareBasis' in node.dataset);
        expect(basis.children.map(option => option.value)).toEqual(['plan:0', 'saved:other']);
        const retry = find(window, node => node.dataset && 'planCompareRetry' in node.dataset);
        retry.listeners.click.forEach(fn => fn());
        await settle();
        expect(rowsOf(tableOf(window))[0][3]).toBe('Flaky');
        expect(digits(row(window, 'Buildings')[3])).toBe(2);
        expect(basis.children.map(option => option.value)).toEqual(['compared', 'plan:0', 'plan:1', 'saved:other']);
        expect(basis.value).toBe('plan:0');
    });

    it('reads a plan\'s agreements again after the index failed', async () => {
        const window = decisionWindow({ funding: { state: 'unminted' } });
        const fetchPage = window.DesignMemberships.fetchPage;
        let failures = 1;
        window.DesignMemberships.fetchPage = async options => { if (failures-- > 0) throw new Error('Membership lookup returned HTTP 500'); return fetchPage(options); };
        await window.comparePlanStats([{ cid: 'plan-1', content: { title: 'Published' }, records: [block('d-1')] }]);
        await settle();
        expect(row(window, 'Agreements backing the plan')[2]).toBe('Not read: Membership lookup returned HTTP 500Retry');
        find(window, node => node.dataset && 'planCompareBackingRetry' in node.dataset).listeners.click.forEach(fn => fn());
        await settle();
        expect(row(window, 'Agreements backing the plan')[2]).toContain('Developer round');
        expect(row(window, 'Agreements backing the plan')[2]).toContain('Not minted');
    });

    it('downloads every row with the columns\' titles and CIDs and the assumptions as CSV', async () => {
        const window = decisionWindow({ funding: { state: 'unminted' } });
        await window.comparePlanStats([{ cid: 'plan-1', content: { title: 'Two blocks, east' }, records: [block('d-1')] }, { content: { title: 'One block' }, records: [block('d-2')] }]);
        await settle();
        find(window, node => node.dataset && 'planCompareCsv' in node.dataset).listeners.click.forEach(fn => fn());
        const lines = window.saved.content.replace(/^\uFEFF/, '').trim().split('\r\n');
        expect(window.saved.name).toMatch(/^compare-plans-\d{4}-\d{2}-\d{2}\.csv$/);
        expect(lines[0]).toBe(',Present state,"Two blocks, east (plan-1)",One block');
        expect(lines.filter(line => line.startsWith('New buildings: maximum height · most storeys,'))).toHaveLength(1);
        expect(lines.find(line => line.startsWith('Agreements backing the plan,'))).toContain('Not minted');
        expect(lines).toContain('Assumptions');
        expect(lines.some(line => /^m² per apartment,65$/.test(line))).toBe(true);
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

describe('the all-in cost and profit in Plan stats', () => {
    // A euro city's starting prices (scenario assumptions): 4,000 sale, 2,000 construction, 133 land
    // per m² of land, no sale tax, 15 rent a month. The plan's land is one building's footprint.
    const eur = amount => CbFormat.formatMoney(amount, 'EUR', { missing: '—', maxFractionDigits: 0 });
    const gfaOf = records => planYield.planYield(records, { appliedOnly: true }).total.grossFloorAreaM2;
    const existing = () => ({ ...block(null), proposalId: 'built:old' });
    const land = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: SIBENIK } };
    const landM2 = planYield.geometryAreaM2(land);
    const gfa = () => gfaOf([block('d-1')]);
    async function openOn(extra = {}, currency = 'EUR') {
        const window = openDialog([block('d-1')], { city: { currency: { code: currency } } });
        await window.showPlanStatsModal({ content: { title: 'Plan' }, cleared: [], landFeature: land, ...extra });
        return window;
    }
    const slide = (window, id, value) => {
        const slider = window.document.getElementById(`${id}-slider`);
        slider.value = String(value);
        slider.listeners.input.forEach(fn => fn());
    };

    it('adds construction, the plan\'s land and the sale tax into one cost, broken down under Cost details', async () => {
        const window = await openOn();
        expect(window.document.getElementById('plan-stats-land').value).toBe('133');
        expect(window.document.getElementById('plan-stats-sale-tax').value).toBe('0');
        const total = gfa() * 2000 + landM2 * 133;
        expect(slot(window, 'total-cost')).toBe(eur(total));
        expect(slot(window, 'cost-construction')).toBe(eur(gfa() * 2000));
        expect(slot(window, 'cost-land')).toBe(eur(landM2 * 133));
        expect(slot(window, 'cost-tax')).toBe(eur(0));
        expect(slot(window, 'cost-replaced')).toBe(eur(0));
        expect(slot(window, 'profit')).toBe(eur(gfa() * 4000 - total));
    });

    it('moves the figures with each price slider, the tax as a share of the sale price', async () => {
        const window = await openOn();
        slide(window, 'plan-stats-sale-tax', 25);
        expect(window.document.getElementById('plan-stats-sale-tax').value).toBe('25');
        const tax = gfa() * 4000 * 0.25 / 1.25;
        expect(slot(window, 'cost-tax')).toBe(eur(tax));
        slide(window, 'plan-stats-construction', 3000);
        expect(window.document.getElementById('plan-stats-construction').value).toBe('3000');
        expect(slot(window, 'total-cost')).toBe(eur(gfa() * 3000 + landM2 * 133 + tax));
        expect(slot(window, 'profit')).toBe(eur(gfa() * 4000 - (gfa() * 3000 + landM2 * 133 + tax)));
    });

    it('adds the development charge on the new floor area, starting at the 0 assumption', async () => {
        const window = await openOn();
        expect(window.document.getElementById('plan-stats-dev-charge').value).toBe('0');
        expect(slot(window, 'cost-dev-charge')).toBe(eur(0));
        slide(window, 'plan-stats-dev-charge', 40);
        expect(slot(window, 'cost-dev-charge')).toBe(eur(gfa() * 40));
        expect(slot(window, 'total-cost')).toBe(eur(gfa() * 2040 + landM2 * 133));
        expect(slot(window, 'profit')).toBe(eur(gfa() * 4000 - (gfa() * 2040 + landM2 * 133)));
    });

    it('charges the value of the existing buildings the plan clears', async () => {
        const window = await openOn({ cleared: [{ before: existing(), after: null }] });
        const replaced = gfaOf([existing()]) * 4000;
        expect(slot(window, 'cost-replaced')).toBe(eur(replaced));
        expect(slot(window, 'profit')).toBe(eur(gfa() * 4000 - (gfa() * 2000 + landM2 * 133 + replaced)));
    });

    it('rents the new floor area by the month and yields it on the cost without the sale tax', async () => {
        const window = await openOn();
        expect(window.document.getElementById('plan-stats-rent').value).toBe('15');
        expect(slot(window, 'annual-rent')).toBe(eur(gfa() * 15 * 12));
        slide(window, 'plan-stats-sale-tax', 25);
        expect(slot(window, 'rent-yield')).toBe(CbFormat.formatPercent(gfa() * 180 / (gfa() * 2000 + landM2 * 133), { maxFractionDigits: 1 }));
        const rent = window.document.getElementById('plan-stats-rent');
        rent.value = '';
        rent.listeners.input.forEach(fn => fn());
        expect([slot(window, 'annual-rent'), slot(window, 'rent-yield')]).toEqual(['—', '—']);
    });

    it('takes the tax reclaimed on a tax-inclusive construction cost off the all-in cost, and lists it only then', async () => {
        const kzt = amount => CbFormat.formatMoney(amount, 'KZT', { missing: '—', maxFractionDigits: 0 });
        const rate = (metric, unit, amount, extra = {}) => ({ metric, unit, amount, currency: 'KZT', basis: 'assumption', ...extra });
        const city = { id: 'kz-test', currency: { code: 'KZT' }, economics: { sources: [{ version: 1, id: 'kz-test', name: 'Test rates',
            adapter: 'rate-table', rates: [rate('sale', 'm2-floor', 600000), rate('land', 'm2-land', 10000),
                rate('construction', 'm2-floor', 300000, { basis: 'construction-cost', asOf: '2026-10-31', taxIncluded: true }),
                rate('saleTax', 'share-of-sale', 0.16, { basis: 'statutory', asOf: '2026-01-01' })] }, 'scenario-assumptions'] } };
        const window = openDialog([block('d-1')], { city });
        await window.showPlanStatsModal({ content: { title: 'Plan' }, cleared: [], landFeature: land });
        const saleTax = gfa() * 600000 * 0.16 / 1.16, reclaimed = gfa() * 300000 * 0.16 / 1.16;
        expect(slot(window, 'cost-tax')).toBe(kzt(saleTax));
        expect(slot(window, 'cost-reclaimed')).toBe('−' + kzt(reclaimed));
        expect(slot(window, 'total-cost')).toBe(kzt(gfa() * 300000 + landM2 * 10000 + saleTax - reclaimed));
        const shown = w => w.document.querySelectorAll('[data-cost-part="cost-reclaimed"]').map(node => node.hidden);
        expect(shown(window)).toEqual([false, false]);
        // A euro city's starting construction cost includes no tax: nothing to list.
        expect(shown(await openOn())).toEqual([true, true]);
    });

    it('leaves the all-in cost and profit unknown without a land price, says so, and takes one from its slider', async () => {
        // A pound city with no authority rate has no land price.
        const window = await openOn({}, 'GBP');
        expect(window.document.getElementById('plan-stats-land').value).toBe('');
        expect([slot(window, 'total-cost'), slot(window, 'profit'), slot(window, 'cost-land')]).toEqual(['—', '—', '—']);
        expect(slot(window, 'cost-construction')).not.toBe('—');
        expect(slot(window, 'notes')).toContain('No land price for this place');
        slide(window, 'plan-stats-land', 300);
        expect(slot(window, 'cost-land')).toBe(CbFormat.formatMoney(landM2 * 300, 'GBP', { maxFractionDigits: 0 }));
        expect(slot(window, 'profit')).not.toBe('—');
        expect(slot(window, 'notes')).not.toContain('No land price');
    });

    it('reads an empty price as no price', async () => {
        const window = await openOn();
        const input = window.document.getElementById('plan-stats-construction');
        input.value = '';
        input.listeners.input.forEach(fn => fn());
        expect([slot(window, 'total-cost'), slot(window, 'profit')]).toEqual(['—', '—']);
        expect(slot(window, 'sales-value')).toBe(eur(gfa() * 4000));
    });

    it('says the profit is not known when a building it clears states no height', async () => {
        const unmeasured = existing();
        unmeasured.buildingProposal = { buildings: [{ ...unmeasured.buildingProposal.buildings[0], properties: { type: 'proposedBuilding' } }] };
        const window = await openOn({ cleared: [{ before: unmeasured, after: null }] });
        expect(slot(window, 'profit')).toBe('—');
        expect(slot(window, 'cost-construction')).not.toBe('—');
        expect(slot(window, 'notes')).toContain('The profit is not known: 1 of the existing buildings the plan clears state no height.');
    });
});
