// A seeded, repeatable build-out scenario for what a plan permits but does not date: each
// unscheduled member (or, for an urban rule, each parcel's building) gets a start month drawn from a
// yearly start rate and a duration from its floor area. A simulation is shown, never stored in a plan
// (docs/buildout-timeline.md). Pure and DOM-free.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildoutSimulation = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const S = () => (root && root.BuildoutSchedule) || require('./buildout-schedule.js');
    const DEFAULTS = Object.freeze({
        startsPerYear: 0.25,      // share of the sites still waiting that start within a year
        baseMonths: 6,            // site works and fit-out of the smallest building
        monthsPer1000M2: 3,       // added per 1000 m² of floor area
        maxMonths: 48,
        horizonYears: 30          // a site still waiting this long starts then
    });

    // FNV-1a over the text, then mulberry32: every site draws from its own stream, so adding a site
    // never moves another's dates.
    function hash(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return h >>> 0;
    }
    function random(seed, key) {
        let a = hash(`${seed}:${key}`);
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function durationMonths(floorAreaM2, options) {
        const area = typeof floorAreaM2 === 'number' && Number.isFinite(floorAreaM2) && floorAreaM2 > 0 ? floorAreaM2 : 0;
        return Math.min(options.maxMonths, Math.max(1, Math.round(options.baseMonths + area / 1000 * options.monthsPer1000M2)));
    }

    // items: [{ key, floorAreaM2 }] → { [key]: { start, end } } from the start month on.
    function simulate(items, { seed, start, ...overrides } = {}) {
        const options = { ...DEFAULTS, ...overrides };
        const first = S().monthIndex(start);
        if (first === null) throw new Error('A simulated build-out needs a start month (YYYY-MM).');
        // A constant yearly hazard, spread over months: P(start this month | waiting) = h.
        const h = 1 - Math.pow(1 - Math.min(Math.max(options.startsPerYear, 0.001), 0.999), 1 / 12);
        const horizon = options.horizonYears * 12;
        const result = {};
        for (const item of items) {
            const draw = random(seed, item.key);
            const waited = Math.min(horizon, Math.floor(Math.log(1 - draw()) / Math.log(1 - h)));
            const begin = first + waited;
            result[item.key] = { start: S().monthOf(begin), end: S().monthOf(begin + durationMonths(item.floorAreaM2, options) - 1) };
        }
        return result;
    }

    // The sites of a plan: an urban rule's buildings one by one (one per parcel), any other member
    // whole. Members the plan already dates keep their window. area(geometry) gives m².
    function sitesOf(plan, designs, { area }) {
        const dated = plan.schedule || {};
        const sites = [];
        for (const { cid, content } of designs) {
            if (dated[cid]) continue;
            const buildings = content.geometry?.buildings || [];
            const floorArea = building => area(building.geometry) * (Number.isFinite(building.properties?.floors) ? building.properties.floors : 1);
            if (content.geometry?.ruleMassing && buildings.length) {
                buildings.forEach((building, index) => sites.push({ key: `${cid}#${index}`, cid, building: index, floorAreaM2: floorArea(building) }));
            } else {
                sites.push({ key: cid, cid, building: null, floorAreaM2: buildings.reduce((sum, b) => sum + floorArea(b), 0) });
            }
        }
        return sites;
    }

    // The scenario as the time control reads it: the plan's own windows plus simulated ones per
    // member, and per building for urban rules (a rule's member window spans its buildings').
    function scenario(plan, designs, { seed, start, area, ...options }) {
        const sites = sitesOf(plan, designs, { area });
        const windows = simulate(sites, { seed, start, ...options });
        const schedule = { ...(plan.schedule || {}) }, buildings = {};
        for (const site of sites) {
            const window = windows[site.key];
            if (site.building === null) { schedule[site.cid] = window; continue; }
            (buildings[site.cid] ||= {})[site.building] = window;
            const span = schedule[site.cid];
            schedule[site.cid] = span ? { start: span.start < window.start ? span.start : window.start, end: span.end > window.end ? span.end : window.end } : window;
        }
        return { schedule, buildings };
    }

    return Object.freeze({ DEFAULTS, simulate, sitesOf, scenario, durationMonths });
});
