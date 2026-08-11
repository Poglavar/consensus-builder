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

const require = createRequire(import.meta.url);
const planYield = require('../../frontend/js/proposals/plan-yield.js');
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

function makeWindow(proposals) {
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
        requestAnimationFrame: fn => fn(),
        proposalStorage: { getAllProposals: () => proposals }
    };
    window.window = window;
    return window;
}

function openDialog(proposals) {
    const window = makeWindow(proposals);
    vm.runInNewContext(source, {
        window,
        globalThis: window,
        document: window.document,
        proposalStorage: window.proposalStorage,
        requestAnimationFrame: window.requestAnimationFrame,
        console
    });
    return window;
}

const rect = (lon0, lat0, lon1, lat1) => [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]];
const SIBENIK = rect(15.8850, 43.7350, 15.8870, 43.7365);

function block(epochYear) {
    return {
        applied: true,
        epochYear,
        buildingProposal: {
            parentParcelIds: ['HR-330264-628'],
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
    plan = [block(2035), block(2045), block(null), { applied: false, buildingProposal: { buildings: [] } }];
});

describe('opening the dialog', () => {
    it('builds it and fills every figure, without throwing', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal();

        ['resulting-parcels', 'buildings', 'floor-area', 'apartments', 'people', 'jobs', 'sales-value']
            .forEach(key => expect(slot(window, key), key).not.toBe('—'));
        expect(window.document.getElementById('plan-stats-modal').style.display).toBe('flex');
    });

    it('counts the applied proposals and says how many it left out', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal();

        expect(slot(window, 'scope')).toContain('3');
        expect(slot(window, 'scope')).toContain('4');
    });

    it('agrees with plan-yield rather than computing its own answer', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal();

        const expected = planYield.planYield(plan.filter(p => p.applied), { appliedOnly: true });
        expect(digits(slot(window, 'apartments'))).toBe(expected.total.apartments);
        expect(digits(slot(window, 'people'))).toBe(expected.total.people);
        expect(digits(slot(window, 'buildings'))).toBe(expected.total.buildings);
    });

    it('counts the parcels the plan leaves standing, not the ones the map drew', async () => {
        // Three building proposals on the same parcel, no map loaded at all: one parcel standing,
        // and an average it honestly declines to state.
        const window = openDialog(plan);
        await window.showPlanStatsModal();

        expect(slot(window, 'resulting-parcels')).toBe('1');
        expect(slot(window, 'notes')).toMatch(/1/);
    });
});

describe('changing an assumption', () => {
    it('moves every derived figure at once', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal();

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
        await window.showPlanStatsModal();

        const floorArea = slot(window, 'floor-area');
        const input = window.document.getElementById('plan-stats-housing-share');
        input.value = '40';
        input.listeners.input.forEach(fn => fn());

        expect(slot(window, 'floor-area')).toBe(floorArea);
    });
});

describe('the period table', () => {
    it('lists each epoch plus the undated proposals', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal();

        const table = window.document.querySelector('[data-plan-stat="epoch-table"]');
        const rows = table.children[0].children;
        expect(rows).toHaveLength(4);                    // header + 2035 + 2045 + no period
        expect(rows[1].children[0].textContent).toBe('2035');
        expect(rows[2].children[0].textContent).toBe('2045');
        expect(rows[3].children[0].textContent).toBe('no period');
    });

    it('switches to standing totals, where the undated ones are already inside each year', async () => {
        const window = openDialog(plan);
        await window.showPlanStatsModal();

        const toggle = window.document.querySelector('[data-epoch-view="cumulative"]');
        toggle.listeners.click.forEach(fn => fn());

        const rows = window.document.querySelector('[data-plan-stat="epoch-table"]').children[0].children;
        expect(rows).toHaveLength(3);                    // header + 2035 + 2045, no separate undated row
        const added = digits(rows[1].children[1].textContent);
        const standing = digits(rows[2].children[1].textContent);
        expect(standing).toBeGreaterThan(added);
    });

    it('stays hidden when no proposal carries an epoch', async () => {
        const window = openDialog([block(null)]);
        await window.showPlanStatsModal();

        expect(window.document.querySelector('[data-plan-stat="epoch-section"]').style.display).toBe('none');
    });
});

describe('when the arithmetic module did not load', () => {
    it('says so instead of showing zeros', async () => {
        const window = makeWindow(plan);
        delete window.__planYield;
        vm.runInNewContext(source, {
            window, globalThis: window, document: window.document,
            proposalStorage: window.proposalStorage,
            requestAnimationFrame: window.requestAnimationFrame, console
        });
        await window.showPlanStatsModal();

        expect(slot(window, 'scope')).toMatch(/unavailable/i);
        expect(slot(window, 'apartments')).toBe('—');
    });
});
