// A road placed into a parcel, as the OSM form the corridor import turns into road records
// (docs/road-in-parcel.md): the site's street graph (corridor-site-centreline.js), every arm fitted
// to the room it has (corridor-site-fit.js), stretches cut where the fitted cross-section changes,
// crossings shared as nodes. One road per connected part of the site, bounded by that part. Pure:
// the browser tool (road-in-parcel.js) and the MCP constructor (intent-design.js) build the same
// roads from the same site (backend/test/road-in-site.test.js).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__roadInSite = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    function fromGlobalOrRequire(globalKey, modulePath) {
        if (global && global[globalKey]) return global[globalKey];
        if (typeof require === 'function') return require(modulePath);
        throw new Error(`road-in-site: ${globalKey} is not available`);
    }
    const centreline = () => fromGlobalOrRequire('__corridorSiteCentreline', './corridor-site-centreline.js');
    const fit = () => fromGlobalOrRequire('__corridorSiteFit', './corridor-site-fit.js');
    const osmForm = () => fromGlobalOrRequire('__corridorOsmForm', '../corridor-osm-form.js');
    const frames = () => fromGlobalOrRequire('__metricFrame', '../metric-frame.js');

    // Arms are grouped by the room they have, to the nearest half metre: the author picks lanes per
    // group. A group's width is the narrowest of its arms, which the lanes must fit.
    const groupKey = widthM => (Math.round(Number(widthM) * 2) / 2).toFixed(1);

    function positionsOf(site) {
        const out = [];
        const polygons = site.type === 'Polygon' ? [site.coordinates] : site.coordinates;
        polygons.forEach(rings => rings.forEach(ring => ring.forEach(p => out.push([p[0], p[1]]))));
        return out;
    }

    function sitePolygons(site) {
        const geometry = site && site.type === 'Feature' ? site.geometry : site;
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error('road-in-site: the site must be a Polygon or MultiPolygon');
        return { geometry, polygons: geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates };
    }

    // Lines that share a node are one network: the networks, as lists of lines.
    function networksOf(lines) {
        const parent = lines.map((_, i) => i);
        const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        const owner = new Map();
        lines.forEach((line, i) => line.nodeKeys.forEach(key => {
            if (owner.has(key)) parent[find(i)] = find(owner.get(key)); else owner.set(key, i);
        }));
        const groups = new Map();
        lines.forEach((line, i) => {
            const key = find(i);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(line);
        });
        return [...groups.values()];
    }

    // One polygon holding streets that do not meet (a strip whose slanted boundary narrows one
    // street to nothing before the next begins) is shared out: each network takes the ground its
    // arms cover, and each piece left over goes whole to the network it borders most. The lands
    // are disjoint and together are the polygon, so each network is a road of its own (a road is
    // one connected stretch, road-drawing.js). Null without turf, or when the split fails.
    // Clipping leaves float noise along edges two shapes share, and a land whose outline strays
    // from the parcel's by a hair leaves the parcel slivers it cannot arrange. So the bands reach just
    // past the kerbs (the polygon's own edge bounds them, and no edge is shared), and the largest
    // network's land is the polygon less the others: its outline keeps the polygon's vertices.
    function splitByNetworks(networks, coordinates, frame, turf) {
        if (!turf || networks.length < 2) return null;
        const feature = geometry => ({ type: 'Feature', properties: {}, geometry });
        const unionAll = list => list.reduce((merged, next) => (merged ? turf.union(merged, next) || merged : next), null);
        const flatten = geometry => (!geometry ? [] : geometry.type === 'Polygon' ? [geometry.coordinates]
            : geometry.type === 'MultiPolygon' ? geometry.coordinates : []).map(rings => feature({ type: 'Polygon', coordinates: rings }));
        const area = f => (f ? turf.area(f) : 0);
        const site = feature({ type: 'Polygon', coordinates });
        try {
            const cores = networks.map(lines => {
                const rects = [];
                lines.forEach(line => line.arms.forEach((arm, k) => {
                    const a = frame.toMetric([line.points[k].lng, line.points[k].lat]);
                    const b = frame.toMetric([line.points[k + 1].lng, line.points[k + 1].lat]);
                    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
                    if (!(length > 0) || !(arm.widthM > 0)) return;
                    const half = arm.widthM / 2 + 0.05;
                    const n = [-(b[1] - a[1]) / length * half, (b[0] - a[0]) / length * half];
                    const ring = [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]]
                        .map(p => frame.toLngLat(p));
                    rects.push(feature({ type: 'Polygon', coordinates: [[...ring, ring[0]]] }));
                }));
                const band = unionAll(rects);
                return band ? turf.intersect(site, band) : null;
            });
            if (cores.some(core => !core)) return null;
            const leftover = turf.difference(site, unionAll(cores.map(core => feature(core.geometry))));
            const lands = cores.map(core => [feature(core.geometry)]);
            flatten(leftover && leftover.geometry).filter(piece => area(piece) > 0.01).forEach(piece => {
                const reach = turf.buffer(piece, 0.0005, { units: 'kilometers' });
                const shared = cores.map(core => area(turf.intersect(reach, core)));
                const best = shared.indexOf(Math.max(...shared));
                lands[best].push(piece);
            });
            const own = lands.map(list => unionAll(list));
            const largest = own.reduce((top, land, k) => (area(land) > area(own[top]) ? k : top), 0);
            const others = unionAll(own.filter((_, k) => k !== largest).map(land => feature(land.geometry)));
            own[largest] = turf.difference(site, others);
            if (!own[largest]) return null;
            return own.map(land => land.geometry);
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [road-in-site] the site could not be shared out between its streets`, error);
            return null;
        }
    }

    /**
     * The roads a site holds. `options`: `skipUnreadable` (leave out parts that do not read as
     * streets, as `skipped` issues), `cores` ({ [groupKey]: core strips } the author chose; a
     * group not named gets `core`, the lanes for every street, else the automatic lanes), `turn`
     * (a lone square street runs the other way),
     * `drivingSide` ('right' | 'left'). Returns { groups: [{ key, widthM, count, fits, requiredM }],
     * roads: [{ site, form, wayIds }], issues: [{ code, ... }] }, where `form` is an OSM form
     * (corridor-import.js recordsFromImport) and `site` the bound of that road: the part, or its share
     * of the part when the part holds streets that do not meet (`options.turf` or the global turf
     * shares it out; without it that part is `disconnected`). Any issue means
     * nothing may be placed: `not-a-grid`, `square` (placeable, but the street could run either
     * way), `disconnected`, `too-narrow`, `core-too-wide`.
     */
    function roadsInSite(site, options = {}) {
        const { geometry, polygons } = sitePolygons(site);
        const frame = options.frame || frames().frameFor(positionsOf(geometry));
        const graph = centreline().streetGraphOfSite(geometry, frame, { turn: options.turn === true });
        const cores = options.cores || {};
        const drivingSide = options.drivingSide === 'left' ? 'left' : 'right';
        const issues = [];
        const groups = new Map();
        const roads = [];
        let nodeId = 0;
        let wayId = 0;

        graph.parts.forEach((part, partIndex) => {
            // `skipUnreadable`: a part that does not read as streets is left out (and named), not a
            // reason to place nothing (several selected strips, one of them ragged where a pool
            // boundary cuts it).
            const skip = issue => options.skipUnreadable && ['not-a-grid', 'disconnected'].includes(issue.code);
            part.issues.forEach(issue => issues.push(skip(issue) ? { code: 'skipped', reason: issue.code, part: partIndex } : { ...issue, part: partIndex }));
            if (!part.lines.length) return;
            const networks = networksOf(part.lines);
            const lands = networks.length > 1
                ? splitByNetworks(networks, polygons[partIndex], frame, options.turf || global.turf || null)
                : [{ type: 'Polygon', coordinates: polygons[partIndex] }];
            if (!lands) {
                issues.push(options.skipUnreadable ? { code: 'skipped', reason: 'disconnected', part: partIndex } : { code: 'disconnected', part: partIndex });
                return;
            }
            networks.forEach((lines, index) => {
                const unit = { lines, site: lands[index] };
                const nodes = new Map();
                const elements = [];
                const wayIds = [];
                const nodeFor = (key, point) => {
                    if (!nodes.has(key)) {
                        nodeId += 1;
                        nodes.set(key, nodeId);
                        elements.push({ type: 'node', id: nodeId, lat: point.lat, lon: point.lng });
                    }
                    return nodes.get(key);
                };
                unit.lines.forEach(line => {
                    // Fit each arm, then cut the line where the fitted cross-section changes.
                    const fitted = line.arms.map(arm => {
                        const key = groupKey(arm.widthM);
                        const core = Array.isArray(cores[key]) ? cores[key] : (Array.isArray(options.core) ? options.core : null);
                        const result = fit().fitArm(arm.widthM, core);
                        const group = groups.get(key) || { key, widthM: Infinity, count: 0, lengthM: 0, fits: true, requiredM: 0 };
                        group.widthM = Math.min(group.widthM, Math.round(arm.widthM * 100) / 100);
                        group.count += 1;
                        group.lengthM += arm.lengthM;
                        group.fits = group.fits && result.fits;
                        group.requiredM = Math.max(group.requiredM, result.requiredM);
                        groups.set(key, group);
                        return result;
                    });
                    let start = 0;
                    for (let k = 1; k <= fitted.length; k += 1) {
                        const same = k < fitted.length && JSON.stringify(fitted[k].profile) === JSON.stringify(fitted[start].profile);
                        if (same) continue;
                        const profile = fitted[start].profile;
                        if (profile) {
                            wayId += 1;
                            const ids = [];
                            for (let p = start; p <= k; p += 1) ids.push(nodeFor(line.nodeKeys[p], line.points[p]));
                            const tags = {
                                highway: 'residential',
                                'cb:segment': `s${wayId}`,
                                ...osmForm().laneTagsOf(profile, drivingSide)
                            };
                            if (drivingSide === 'left') tags.driving_side = 'left';
                            elements.push({ type: 'way', id: wayId, nodes: ids, tags });
                            wayIds.push(wayId);
                        }
                        start = k;
                    }
                });
                if (wayIds.length) roads.push({ site: unit.site, form: { elements }, wayIds });
            });
        });

        const groupList = [...groups.values()].sort((a, b) => a.widthM - b.widthM);
        groupList.forEach(group => {
            if (group.fits) return;
            issues.push(group.widthM < 3.5
                ? { code: 'too-narrow', key: group.key, widthM: group.widthM }
                : { code: 'core-too-wide', key: group.key, widthM: group.widthM, requiredM: group.requiredM });
        });
        return { groups: groupList, roads, issues };
    }

    // Issues that stop a placement (a lone square is placeable, the author may turn it; a skipped
    // part is left out).
    const blocking = issues => (issues || []).filter(issue => issue.code !== 'square' && issue.code !== 'skipped');

    // The view definition of one planned road, bounded by its site: what recordsFromImport makes of
    // its form plus the bound (for the MCP constructor, which builds records without the import).
    function boundedDefinition(road) {
        const definition = osmForm().definitionFromOsmForm(road.form);
        if (!definition) throw new Error('road-in-site: the planned road has no stretches');
        definition.bound = { site: JSON.parse(JSON.stringify(road.site)) };
        return definition;
    }

    return Object.freeze({ roadsInSite, blocking, boundedDefinition, groupKey });
});
