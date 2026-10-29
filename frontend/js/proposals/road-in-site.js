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

    // Lines that share a node are one network.
    function connected(lines) {
        const parent = lines.map((_, i) => i);
        const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        const owner = new Map();
        lines.forEach((line, i) => line.nodeKeys.forEach(key => {
            if (owner.has(key)) parent[find(i)] = find(owner.get(key)); else owner.set(key, i);
        }));
        return new Set(lines.map((_, i) => find(i))).size <= 1;
    }

    /**
     * The roads a site holds. `options`: `skipUnreadable` (leave out parts that do not read as
     * streets, as `skipped` issues), `cores` ({ [groupKey]: core strips } the author chose; a
     * group not named gets `core`, the lanes for every street, else the automatic lanes), `turn`
     * (a lone square street runs the other way),
     * `drivingSide` ('right' | 'left'). Returns { groups: [{ key, widthM, count, fits, requiredM }],
     * roads: [{ site, form, wayIds }], issues: [{ code, ... }] }, where `form` is an OSM form
     * (corridor-import.js recordsFromImport) and `site` the bound of that road. Any issue means
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
            if (!connected(part.lines)) {
                issues.push(options.skipUnreadable ? { code: 'skipped', reason: 'disconnected', part: partIndex } : { code: 'disconnected', part: partIndex });
                return;
            }
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
            part.lines.forEach(line => {
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
            if (wayIds.length) roads.push({ site: { type: 'Polygon', coordinates: polygons[partIndex] }, form: { elements }, wayIds });
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
