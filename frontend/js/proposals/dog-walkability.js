// Walking assessment for the Dog critic.
(function (root, factory) {
    const load = (value, file) => value || (typeof require === 'function' ? require(file) : null);
    const api = factory(load(root.ActiveTravelNetwork, './active-travel-network.js'),
        load(root.corridorSegmentEntries && root, '../corridor-profile.js'), load(root.__corridorJunction, '../corridor-junction.js'));
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DogWalkability = api;
})(typeof window !== 'undefined' ? window : globalThis, function (travel, profiles, junctions) {
    'use strict';
    const { CATEGORIES, dist, minus, lerp, offset, level, nodeKey } = travel;
    const SPEED = 1.2;
    const CROSSING_SECONDS = 15;
    const DENIED = new Set(['no', 'private']);
    const FOOTWAYS = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street']);
    const denied = tags => DENIED.has(tags.foot) || (!tags.foot && DENIED.has(tags.access));
    const crossingAllowed = tags => tags.crossing !== 'no' && tags['crossing:markings'] !== 'no';
    const taggedCrossing = tags => (tags.highway === 'crossing' || !!tags.crossing) && crossingAllowed(tags) && !denied(tags);

    function network(entries, frame) {
        const streets = [], groups = new Map(), paths = [], links = [], gaps = [];
        const pointXY = p => frame.latLngToMetric(p.lat, p.lng);
        for (const { points, tags, profile } of entries) {
            const spans = profiles.corridorStripSpans(profile);
            const walk = !denied(tags);
            const sidewalkOnly = spans.length && spans.every(s => s.type === 'sidewalk');
            const shared = walk && (sidewalkOnly || FOOTWAYS.has(tags.highway));
            const strips = walk ? spans.filter(s => s.type === 'sidewalk') : [];
            const left = strips.find(s => s.left + s.right > 0);
            const right = strips.findLast(s => s.left + s.right < 0);
            const sides = shared ? [0] : [left, right].filter(Boolean).map(s => (s.left + s.right) / 2);
            const edges = profiles.corridorProfileEdges(profile);
            for (let i = 1; i < points.length; i++) {
                const from = points[i - 1], to = points[i], a = pointXY(from), b = pointXY(to);
                const length = dist(a, b);
                if (length < 0.05) continue;
                const dir = minus(b, a).map(value => value / length);
                const edge = { a, b, atGround: !level(from) && !level(to), shared, dir, length, sides, edges, tags, pathRows: [] };
                if (!shared) {
                    streets.push(edge);
                    if (!sides.length) gaps.push({ kind: 'no-sidewalk', points: [a, b] });
                }
                edge.pathRows = sides.map(side => ({ a: offset(a, dir, side), b: offset(b, dir, side), splits: [],
                    ground: edge.atGround, side, edge }));
                paths.push(...edge.pathRows);
                for (const [p, xy, direction, end] of [[from, a, dir, 0], [to, b, dir.map(v => -v), 1]]) {
                    const key = nodeKey(p);
                    if (!groups.has(key)) groups.set(key, { xy, tags: [], arms: [] });
                    const group = groups.get(key);
                    group.tags.push(p.tags || {});
                    group.arms.push({ dir: direction, reversed: !!end, edge, end, edges, length, hasSidewalk: sides.length > 0,
                        angle: Math.atan2(direction[1], direction[0]) });
                }
            }
        }
        const endpoint = (arm, side, along = 0) => {
            const path = arm.edge.pathRows.find(p => arm.edge.shared || Math.sign(p.side) === side * (arm.end ? -1 : 1));
            return path && { path, t: arm.end ? 1 - along / arm.length : along / arm.length };
        };
        for (const { xy, tags, arms } of groups.values()) {
            if (arms.length < 2 && !tags.some(taggedCrossing)) continue;
            arms.sort((a, b) => a.angle - b.angle);
            // Turns follow the corner between adjacent arms. Opposite sidewalks stay separate.
            if (arms.length > 1) arms.forEach((arm, index) => {
                const next = arms[(index + 1) % arms.length];
                const a = endpoint(arm, 1), b = endpoint(next, -1);
                if (a && b) links.push({ a, b, delay: 0 });
            });
            const roadArms = arms.filter(arm => !arm.edge.shared);
            const model = roadArms.length >= 3 ? junctions.buildJunction(xy, roadArms) : null;
            const crossingStations = new Map(model?.arms.map(arm => [arm.source, arm.crossingStation]) || []);
            const allowed = tags.every(crossingAllowed);
            for (const arm of roadArms) {
                const marked = allowed && tags.some(taggedCrossing);
                const modeled = allowed && crossingAllowed(arm.edge.tags) ? crossingStations.get(arm) : null;
                const crossing = marked ? Math.min(1, arm.length / 2) : modeled;
                if (crossing == null && roadArms.length < 3) continue;
                const a = endpoint(arm, 1, crossing ?? 0), b = endpoint(arm, -1, crossing ?? 0);
                if (!a || !b) continue;
                if (crossing == null) gaps.push({ kind: 'crossing-gap', points: [lerp(a.path.a, a.path.b, a.t), lerp(b.path.a, b.path.b, b.t)] });
                else links.push({ a, b, delay: CROSSING_SECONDS });
            }
        }
        return { paths, streets, links, gaps };
    }

    function evaluate(plan, designs) {
        const read = travel.assess(plan, designs, (entries, frame) => network(entries.filter(row =>
            row.definition.kind !== 'track' && (!profiles.corridorProfileHasRail(row.profile)
                || profiles.corridorStripSpans(row.profile).some(strip => strip.type === 'sidewalk'))), frame), SPEED);
        const { homes, connectedHomes, unstatedUse, network: { paths, gaps }, lngLat, selectTrip } = read;
        const destinations = read.destinations.map(({ reachable, ...place }) => place);
        const categories = Object.fromEntries(CATEGORIES.map(category => {
            const available = destinations.filter(row => row.category === category);
            const times = homes.map(row => row.routes[category]?.seconds ?? Infinity);
            return [category, { destinations: available.length, connectedDestinations: available.filter(row => row.connected).length,
                within5: times.filter(seconds => seconds <= 300).length, within10: times.filter(seconds => seconds <= 600).length,
                noRoute: available.length ? times.filter(seconds => !Number.isFinite(seconds)).length : null }];
        }));
        const measured = CATEGORIES.map(category => categories[category]).filter(row => row.destinations);
        return { categories, homes, destinations, unstatedUse, connectedHomes,
            score: paths.length && measured.length && homes.length ? Math.round(100 * measured.reduce((sum, row) => sum + row.within10, 0) / (measured.length * homes.length)) : null,
            pathCount: paths.length, paths: paths.map(path => [lngLat(path.a), lngLat(path.b)]),
            gaps: gaps.map(gap => ({ kind: gap.kind, points: gap.points.map(lngLat) })),
            route: (id, category) => selectTrip(id, category).coordinates };
    }

    return Object.freeze({ evaluate, CATEGORIES });
});
