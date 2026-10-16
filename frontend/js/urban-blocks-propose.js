// Turn a block breakup into road proposals: each cut's connector is a new street (an alley it
// extends is road that already exists), streets that meet form one road, and every road becomes an
// OSM form that the corridor import turns into records (corridor-import.js recordsFromImport).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UrbanBlocksPropose = api;
})(typeof self !== 'undefined' ? self : null, function () {
    'use strict';
    // Within this of another street's span, a street end meets it as a T junction.
    const JOIN_M = 0.05;
    // Node identity: coordinates equal to about a centimetre are one node.
    const nodeKey = point => point.map(value => Math.round(value * 1e7)).join(',');

    function newStreets(cuts) {
        return cuts.map(cut => {
            const { splitPath: path, connectorIndex: index } = cut?.properties || {};
            if (!Array.isArray(path) || !Number.isInteger(index) || !path[index] || !path[index + 1]) {
                throw new Error('A split has no street geometry.');
            }
            return [path[index], path[index + 1]];
        });
    }

    // The new streets as ways grouped into connected roads. A street ending on another's span splits
    // that span there, so the two share the junction node.
    function streetNetworks(cuts) {
        const streets = newStreets(cuts);
        if (!streets.length) return [];
        const latitude = streets[0][0][1] * Math.PI / 180, metresPerDegree = 111320;
        const metres = point => [point[0] * metresPerDegree * Math.cos(latitude), point[1] * metresPerDegree];
        const junctions = streets.map(() => []);
        streets.forEach((street, i) => street.forEach(end => streets.forEach((host, j) => {
            if (i === j) return;
            const a = metres(host[0]), b = metres(host[1]), e = metres(end);
            const span = [b[0] - a[0], b[1] - a[1]], lengthM = Math.hypot(...span);
            if (!lengthM) return;
            const t = ((e[0] - a[0]) * span[0] + (e[1] - a[1]) * span[1]) / (lengthM * lengthM);
            const offsetM = Math.hypot(a[0] + t * span[0] - e[0], a[1] + t * span[1] - e[1]);
            if (offsetM < JOIN_M && t * lengthM > JOIN_M && (1 - t) * lengthM > JOIN_M) junctions[j].push({ t, point: end });
        })));
        const ways = streets.map((street, i) => [street[0], ...junctions[i].sort((x, y) => x.t - y.t).map(item => item.point), street[1]]
            .filter((point, k, list) => !k || nodeKey(point) !== nodeKey(list[k - 1])));
        const parent = ways.map((_, i) => i);
        const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
        const owner = new Map();
        ways.forEach((way, i) => way.forEach(point => {
            const key = nodeKey(point);
            if (owner.has(key)) parent[find(i)] = find(owner.get(key)); else owner.set(key, i);
        }));
        const groups = new Map();
        ways.forEach((way, i) => {
            const root = find(i);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root).push(way);
        });
        return [...groups.values()];
    }

    // The import shape recordsFromImport reads: one OSM form, and one road per connected network.
    // `tags` are every new way's tags (its highway class and cross-section).
    function importForm(cuts, { tags = {} } = {}) {
        const elements = [], nodeIds = new Map(), roads = [];
        let nextId = 1;
        const node = point => {
            const key = nodeKey(point);
            if (!nodeIds.has(key)) {
                nodeIds.set(key, nextId);
                elements.push({ type: 'node', id: nextId++, lat: point[1], lon: point[0] });
            }
            return nodeIds.get(key);
        };
        streetNetworks(cuts).forEach((ways, index) => {
            const wayIds = ways.map(points => {
                const id = nextId++;
                elements.push({ type: 'way', id, nodes: points.map(node), tags: { ...tags } });
                return id;
            });
            roads.push({ id: `street-${index + 1}`, name: null, wayIds });
        });
        return { form: { elements }, roads };
    }

    return { streetNetworks, importForm };
});
