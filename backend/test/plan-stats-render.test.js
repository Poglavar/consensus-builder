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

// Mirrors PLAN_STATS_RERENDER_MS in plan-stats.js; the source is an IIFE-local constant.
const PLAN_STATS_RERENDER_MS_FOR_TEST = 10000;
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

function makeWindow(proposals, { search = '', getProposals = null } = {}) {
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
    // Timers are collected rather than run, and the clock is the test's to move, so the
    // deep-link's follow loop is stepped deliberately — no sleeping, no flake, and its
    // give-up rules are reachable at all (with a real clock they never fire in a test that
    // finishes in milliseconds, which makes any assertion about them decoration).
    const timers = [];
    let clock = 1_000_000;
    const RealDate = Date;
    function FakeDate(...args) { return new RealDate(...args); }
    FakeDate.now = () => clock;
    FakeDate.prototype = RealDate.prototype;
    const window = {
        document,
        console,
        __planYield: planYield,
        requestAnimationFrame: fn => fn(),
        location: { search },
        setTimeout: fn => { timers.push(fn); return timers.length; },
        proposalStorage: { getAllProposals: getProposals || (() => proposals) }
    };
    window.window = window;
    window.__timers = timers;
    window.__tick = () => { const due = timers.splice(0); due.forEach(fn => fn()); };
    window.__advance = ms => { clock += ms; };
    window.__Date = FakeDate;
    return window;
}

function openDialog(proposals, options = {}) {
    const window = makeWindow(proposals, options);
    vm.runInNewContext(source, {
        window,
        globalThis: window,
        document: window.document,
        proposalStorage: window.proposalStorage,
        requestAnimationFrame: window.requestAnimationFrame,
        setTimeout: window.setTimeout,
        URLSearchParams,
        Date: window.__Date,
        console
    });
    return window;
}

// The dialog binds itself on DOMContentLoaded; the tests above call showPlanStatsModal directly,
// so only the deep-link tests need the event actually fired.
const fireReady = window => (window.document.listeners.DOMContentLoaded || []).forEach(fn => fn());
const isOpen = window => window.document.getElementById('plan-stats-modal')?.style.display === 'flex';

const rect = (lon0, lat0, lon1, lat1) => [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]];
const SIBENIK = rect(15.8850, 43.7350, 15.8870, 43.7365);

function block(epochYear) {
    return {
        applied: true,
        epochYear,
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

// A report that quotes these figures needs to link to them, not to a button the reader has to
// find. The link is only worth anything if it opens the dialog with the plan actually in it —
// so the wait is what these tests are really about.
describe('?planStats deep link', () => {
    it('opens the dialog on load, with no click', async () => {
        const window = openDialog(plan, { search: '?planStats=1' });
        fireReady(window);
        await Promise.resolve();
        await Promise.resolve();

        expect(isOpen(window)).toBe(true);
        expect(digits(slot(window, 'apartments'))).toBeGreaterThan(0);
    });

    it('stays shut without the parameter, and when it is switched off', async () => {
        for (const search of ['', '?city=sibenik', '?planStats=0', '?planStats=false']) {
            const window = openDialog(plan, { search });
            fireReady(window);
            await Promise.resolve();
            expect(isOpen(window), search || '(no query)').toBe(false);
        }
    });

    // The one that matters, and it is not hypothetical: on the real Sibenik plan the first
    // proposals appear with NONE of them applied yet, so a dialog opened then reports a plan
    // of zeros that is indistinguishable from a genuinely empty one — and quotable.
    it('never opens on a plan with nothing applied yet', async () => {
        let visible = [];
        const window = openDialog(plan, { search: '?planStats=1', getProposals: () => visible });
        fireReady(window);
        await Promise.resolve();
        expect(isOpen(window)).toBe(false);

        visible = plan.map(p => ({ ...p, applied: false }));   // present, none applied — the real state
        window.__tick();
        await Promise.resolve();
        window.__tick();
        await Promise.resolve();
        expect(isOpen(window), 'opened while nothing was applied').toBe(false);

        visible = plan;
        window.__tick();
        await Promise.resolve();
        await Promise.resolve();
        expect(isOpen(window)).toBe(true);
        expect(digits(slot(window, 'people'))).toBe(
            planYield.planYield(plan.filter(p => p.applied), { appliedOnly: true }).total.people
        );
    });

    // A quiet gap mid-stream is indistinguishable from the end of it, so an early open cannot
    // be ruled out — it is made harmless instead: the figures re-render as the rest lands.
    it('corrects itself when the rest of the plan lands after it opened', async () => {
        let visible = plan.slice(0, 1);
        const window = openDialog(plan, { search: '?planStats=1', getProposals: () => visible });
        fireReady(window);
        await Promise.resolve();
        await Promise.resolve();

        expect(isOpen(window)).toBe(true);
        const partial = digits(slot(window, 'people'));
        expect(partial).toBeGreaterThan(0);

        visible = plan;                          // the rest of the stream arrives
        window.__advance(PLAN_STATS_RERENDER_MS_FOR_TEST);   // past the re-render floor
        window.__tick();
        await Promise.resolve();
        await Promise.resolve();

        const full = planYield.planYield(plan.filter(p => p.applied), { appliedOnly: true }).total.people;
        expect(digits(slot(window, 'people'))).toBe(full);
        expect(full).toBeGreaterThan(partial);
    });
});

// Following the plan must not fight the reader: once they close the dialog it has to stay
// closed, however much the plan keeps moving behind it.
describe('?planStats deep link, after the reader closes it', () => {
    it('stops re-opening once dismissed', async () => {
        let visible = plan.slice(0, 1);
        const window = openDialog(plan, { search: '?planStats=1', getProposals: () => visible });
        fireReady(window);
        await Promise.resolve();
        await Promise.resolve();
        expect(isOpen(window)).toBe(true);

        window.document.getElementById('plan-stats-modal').style.display = 'none';   // reader closes it
        visible = plan;                                                              // plan keeps loading
        window.__tick();
        await Promise.resolve();
        await Promise.resolve();

        expect(isOpen(window), 'reopened a dialog the reader had closed').toBe(false);
    });
});

// The store empties and refills while proposals are applied. Measuring "the plan went quiet"
// against the RENDERED snapshot let that lull read as the end of loading, and the follower gave
// up at 0 applied — never seeing the rest of the plan arrive. Reproduced against the real plan:
// the dialog froze at 2.861 apartments while the store climbed past 159 applied proposals.
describe('?planStats deep link, across a lull', () => {
    it('keeps following after the store briefly empties', async () => {
        let visible = plan.slice(0, 1);
        const window = openDialog(plan, { search: '?planStats=1', getProposals: () => visible });
        fireReady(window);
        await Promise.resolve();
        await Promise.resolve();
        const partial = digits(slot(window, 'people'));
        expect(partial).toBeGreaterThan(0);

        // The store empties. That IS the plan moving, so it must restart the quiet countdown.
        window.__advance(15000);
        visible = [];
        window.__tick();
        await Promise.resolve();
        expect(digits(slot(window, 'people')), 'wiped the figures on an empty store').toBe(partial);

        // Ten more seconds of nothing: 25 s since the last RENDER, but only 10 s since the last
        // CHANGE. Counting from the render is what killed the follower here.
        window.__advance(10000);
        window.__tick();
        await Promise.resolve();

        visible = plan;
        window.__advance(2000);
        window.__tick();
        await Promise.resolve();
        await Promise.resolve();

        expect(digits(slot(window, 'people'))).toBe(
            planYield.planYield(plan.filter(p => p.applied), { appliedOnly: true }).total.people
        );
    });

    it('does stop once the plan really has gone quiet', async () => {
        let visible = plan.slice(0, 1);
        const window = openDialog(plan, { search: '?planStats=1', getProposals: () => visible });
        fireReady(window);
        await Promise.resolve();
        await Promise.resolve();
        const partial = digits(slot(window, 'people'));

        window.__advance(25000);                 // nothing changes for longer than the quiet window
        window.__tick();
        await Promise.resolve();
        expect(window.__timers.length, 'kept polling forever').toBe(0);

        visible = plan;                          // too late — it has stopped watching
        window.__tick();
        await Promise.resolve();
        expect(digits(slot(window, 'people'))).toBe(partial);
    });
});

// Throttling re-renders while the plan applies (a 299-proposal plan takes ~18 minutes, one
// proposal at a time, on this same thread) creates its own hazard: the LAST change is the one
// most likely to be skipped, and stopping on it leaves a stale figure on screen — quotable and
// wrong, which is the failure this whole path exists to avoid.
describe('?planStats deep link, re-render throttle', () => {
    it('does not recompute on every single change while the plan applies', async () => {
        let visible = plan.slice(0, 1);
        const window = openDialog(plan, { search: '?planStats=1', getProposals: () => visible });
        fireReady(window);
        await Promise.resolve();
        await Promise.resolve();
        const first = digits(slot(window, 'people'));

        // A change arrives well inside the throttle window: seen, but not drawn.
        window.__advance(2000);
        visible = plan;
        window.__tick();
        await Promise.resolve();
        await Promise.resolve();
        expect(digits(slot(window, 'people')), 'redrew inside the throttle window').toBe(first);

        // Past the floor, the figures catch up.
        window.__advance(PLAN_STATS_RERENDER_MS_FOR_TEST);
        window.__tick();
        await Promise.resolve();
        await Promise.resolve();
        expect(digits(slot(window, 'people'))).toBe(
            planYield.planYield(plan.filter(p => p.applied), { appliedOnly: true }).total.people
        );
    });

    it('draws the final state before it stops following', async () => {
        let visible = plan.slice(0, 1);
        const window = openDialog(plan, { search: '?planStats=1', getProposals: () => visible });
        fireReady(window);
        await Promise.resolve();
        await Promise.resolve();
        const partial = digits(slot(window, 'people'));

        // The last change lands inside the throttle window, then the plan goes quiet forever.
        window.__advance(2000);
        visible = plan;
        window.__tick();
        await Promise.resolve();
        expect(digits(slot(window, 'people'))).toBe(partial);   // skipped, as designed

        window.__advance(25000);                                 // quiet long enough to give up
        window.__tick();
        await Promise.resolve();
        await Promise.resolve();

        expect(window.__timers.length, 'kept polling').toBe(0);
        expect(digits(slot(window, 'people')), 'stopped on a stale figure').toBe(
            planYield.planYield(plan.filter(p => p.applied), { appliedOnly: true }).total.people
        );
    });
});
