// The streets of a Schelling intervention: the chosen blocks and every street that bounds one, as
// the OSM form the corridor import turns into road records (corridor-import.js recordsFromImport).
// Pure: lattice indices in, OSM elements out, so a stranger choosing the same blocks gets the same
// streets (backend/test/schelling-streets.test.js).
(function (root, factory) {
    // The grid and the street fit load later than this file in index.html, so they are looked up
    // when first used.
    const grid = () => (root && root.SchellingGrid) || require('../parcels/schelling-grid.js');
    const fit = () => (root && root.__corridorSiteFit) || require('../proposals/corridor-site-fit.js');
    const api = factory(grid, fit);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SchellingStreets = api;
})(typeof window !== 'undefined' ? window : null, function (grid, fit) {
    'use strict';

    // Angel's arterial: two lanes each way (the outer one for buses), a planted median, cycleways,
    // verges with trees and wide pavements, 30 m in all. Strips run left of travel to right.
    const ARTERIAL_STRIPS = Object.freeze([
        { type: 'sidewalk', width: 3 }, { type: 'verge', width: 2, landscape: 'trees' },
        { type: 'cycleway', width: 2, direction: 'backward' },
        { type: 'driving', width: 3.5, direction: 'backward' }, { type: 'driving', width: 3.25, direction: 'backward' },
        { type: 'median', width: 2.5, landscape: 'grass' },
        { type: 'driving', width: 3.25, direction: 'forward' }, { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'cycleway', width: 2, direction: 'forward' },
        { type: 'verge', width: 2, landscape: 'trees' }, { type: 'sidewalk', width: 3 }
    ]);

    // A local street of any width: two lanes, a parking lane each side once there is room for one
    // beside a 2 m pavement, and the rest to the pavements up to 3 m, beyond that to a verge. The
    // same fit a road placed into a parcel gets (corridor-site-fit.js autoProfile).
    function localStrips(widthM) {
        const width = Number(widthM);
        if (!(width >= 7)) throw new RangeError('A local street needs at least 7 m.');
        return fit().autoProfile(width).strips;
    }

    function profileFor(plan, roadClass) {
        const strips = roadClass === 'arterial' ? ARTERIAL_STRIPS : localStrips(plan.streetWidthM);
        return { strips: strips.map(strip => ({ ...strip })) };
    }

    const cellKey = cell => `${cell.i}:${cell.j}`;

    // The unit edges around the chosen cells, each once: the east-west edge on parallel j between
    // meridians i and i+1, and the north-south edge on meridian i between parallels j and j+1.
    function edgesOf(cells) {
        const ew = new Map();
        const ns = new Map();
        const add = (map, line, from) => {
            if (!map.has(line)) map.set(line, new Set());
            map.get(line).add(from);
        };
        cells.forEach(({ i, j }) => {
            add(ew, j, i); add(ew, j + 1, i);
            add(ns, i, j); add(ns, i + 1, j);
        });
        return { ew, ns };
    }

    // Consecutive edges on one line become one street: [from, to] in lattice steps.
    function runsOf(map) {
        const runs = [];
        [...map.keys()].sort((a, b) => a - b).forEach(line => {
            const steps = [...map.get(line)].sort((a, b) => a - b);
            let start = steps[0];
            let previous = steps[0];
            for (let k = 1; k <= steps.length; k += 1) {
                if (k < steps.length && steps[k] === previous + 1) { previous = steps[k]; continue; }
                runs.push({ line, from: start, to: previous + 1 });
                start = steps[k];
                previous = steps[k];
            }
        });
        return runs;
    }

    // The streets bounding the cells: one per run of a lattice line, with every lattice node along
    // it, so streets that cross or meet share their junction node.
    function streetsOf(plan, cells) {
        const unique = [...new Map(cells.map(cell => [cellKey(cell), cell])).values()];
        if (!unique.length) return [];
        const { ew, ns } = edgesOf(unique);
        const streets = [];
        runsOf(ew).forEach(({ line: j, from, to }) => {
            const nodes = [];
            for (let i = from; i <= to; i += 1) nodes.push({ i, j });
            streets.push({ axis: 'EW', line: j, from, to, roadClass: grid().isArterialLat(plan, j) ? 'arterial' : 'local', nodes });
        });
        runsOf(ns).forEach(({ line: i, from, to }) => {
            const nodes = [];
            for (let j = from; j <= to; j += 1) nodes.push({ i, j });
            streets.push({ axis: 'NS', line: i, from, to, roadClass: grid().isArterialLon(plan, i) ? 'arterial' : 'local', nodes });
        });
        return streets;
    }

    // Streets that share a node are one road (one proposal record); separate patches are separate roads.
    function networksOf(streets) {
        const parent = streets.map((_, index) => index);
        const find = index => (parent[index] === index ? index : (parent[index] = find(parent[index])));
        const owner = new Map();
        streets.forEach((street, index) => street.nodes.forEach(node => {
            const key = cellKey(node);
            if (owner.has(key)) parent[find(index)] = find(owner.get(key)); else owner.set(key, index);
        }));
        const groups = new Map();
        streets.forEach((street, index) => {
            const rootIndex = find(index);
            if (!groups.has(rootIndex)) groups.set(rootIndex, []);
            groups.get(rootIndex).push(street);
        });
        return [...groups.values()];
    }

    // Street length along the centre line, by class, in metres.
    function lengthOf(plan, street) {
        const steps = street.to - street.from;
        return steps * (street.axis === 'EW' ? plan.local.cellLonM : plan.local.cellLatM);
    }

    function summary(plan, cells) {
        const unique = [...new Map(cells.map(cell => [cellKey(cell), cell])).values()];
        const streets = streetsOf(plan, unique);
        const lengthM = { arterial: 0, local: 0 };
        streets.forEach(street => { lengthM[street.roadClass] += lengthOf(plan, street); });
        const blockAreaM2 = unique.reduce((sum, { i, j }) => sum + grid().blockOf(plan, i, j).properties.area_m2, 0);
        return { blocks: unique.length, streets: streets.length, roads: networksOf(streets).length, lengthM, blockAreaM2 };
    }

    // The import shape recordsFromImport reads: one OSM form, one road per connected network.
    // `laneTags(profile)` turns a cross-section into OSM lane tags (corridorProfileToOsmTags).
    function importForm(plan, cells, { laneTags } = {}) {
        if (typeof laneTags !== 'function') throw new TypeError('importForm needs laneTags(profile).');
        const tagsByClass = {
            arterial: { highway: 'primary', ...laneTags(profileFor(plan, 'arterial')) },
            local: { highway: 'residential', ...laneTags(profileFor(plan, 'local')) }
        };
        const elements = [];
        const nodeIds = new Map();
        const roads = [];
        let nextId = 1;
        const node = ({ i, j }) => {
            const key = `${i}:${j}`;
            if (!nodeIds.has(key)) {
                nodeIds.set(key, nextId);
                elements.push({ type: 'node', id: nextId++, lat: grid().latOfLine(plan, j), lon: grid().lonOfLine(plan, i) });
            }
            return nodeIds.get(key);
        };
        networksOf(streetsOf(plan, cells)).forEach((streets, index) => {
            const wayIds = streets.map(street => {
                const id = nextId++;
                elements.push({ type: 'way', id, nodes: street.nodes.map(node), tags: { ...tagsByClass[street.roadClass] } });
                return id;
            });
            roads.push({ id: `schelling-${index + 1}`, name: null, wayIds });
        });
        return { form: { elements }, roads };
    }

    return { ARTERIAL_STRIPS, localStrips, profileFor, streetsOf, networksOf, summary, importForm };
});
