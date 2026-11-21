// Bike access and length-weighted infrastructure quality for an exact plan revision.
(function (root, factory) {
    const load = (value, file) => value || (typeof require === 'function' ? require(file) : null);
    const api = factory(load(root.ActiveTravelNetwork, './active-travel-network.js'),
        load(root.corridorStripSpans && root, '../corridor-profile.js'));
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.HareCycling = api;
})(typeof window !== 'undefined' ? window : globalThis, function (travel, profiles) {
    'use strict';
    const { CATEGORIES, dist, minus, offset, level, nodeKey } = travel;
    const WEIGHTS = Object.freeze({ protected: 100, painted: 70, slow: 40, fast: 15, prohibited: 0 });
    const TIERS = Object.freeze([...Object.keys(WEIGHTS), 'unknown']);
    const SLOW_KMH = 30;
    const SPEED = 15 / 3.6;
    const MOTOR = new Set(['driving', 'bus']);
    const DIRECTION = { forward: 1, backward: -1, both: 0 };
    const ACCESS_DENIED = new Set(['no', 'private', 'dismount', 'use_sidepath']);
    const CYCLE_ALLOWED = new Set(['yes', 'designated', 'permissive', 'official']);
    const NON_STREET = new Set(['footway', 'path', 'pedestrian', 'bridleway', 'steps', 'track']);
    const FREEWAY = new Set(['motorway', 'motorway_link', 'trunk_link']);
    const PHYSICAL = new Set(['kerb', 'curb', 'bollard', 'flex_post', 'planter', 'grass_verge', 'verge', 'median', 'jersey_barrier', 'vertical_panel', 'guard_rail']);

    function postedSpeed(raw) {
        const match = /^(\d+(?:\.\d+)?)\s*(km\/?h|kph|mph)?$/i.exec(String(raw ?? '').trim());
        return match ? Number(match[1]) * (match[2]?.toLowerCase() === 'mph' ? 1.609344 : 1) : null;
    }

    const midpoint = strip => (strip.left + strip.right) / 2;
    const supports = (strip, direction) => !DIRECTION[strip.direction] || DIRECTION[strip.direction] === direction;
    const directionsOf = value => value === '-1' ? [-1] : ['yes', '1', 'true'].includes(value) ? [1] : [1, -1];
    const allowed = value => CYCLE_ALLOWED.has(value);
    const sideTag = (tags, key, side, suffix = '') => tags[`${key}:${side}${suffix}`] ?? tags[`${key}:both${suffix}`] ?? tags[`${key}${suffix}`];
    const hasPhysicalDivider = value => String(value ?? '').split(/[;|]/).some(token => PHYSICAL.has(token.trim().toLowerCase()));

    function grade(entry) {
        const { tags, profile, definition } = entry;
        const strips = profiles.corridorStripSpans(profile);
        const motors = strips.filter(s => MOTOR.has(s.type));
        const bikes = strips.filter(s => s.type === 'cycleway');
        const rail = strips.some(s => s.type === 'rail') || definition.kind === 'track';
        const cycleCrossing = (tags.cycleway === 'crossing' || tags.footway === 'crossing')
            && (tags.highway === 'cycleway' || allowed(tags.bicycle));
        const road = motors.length > 0 && !rail && !NON_STREET.has(tags.highway);
        const traffic = tags.oneway != null || tags.junction === 'roundabout'
            ? directionsOf(tags.oneway ?? 'yes') : [1, -1].filter(direction => motors.some(strip => supports(strip, direction)));
        const bikeDirections = tags['oneway:bicycle'] != null ? directionsOf(tags['oneway:bicycle'])
            : road ? traffic : directionsOf(tags.oneway);
        // Separate footpaths enter the cycle graph only with stated riding access. Rails still
        // obstruct unrecorded connectors at grade.
        const bikePath = !rail && !road && tags.highway !== 'steps' && (bikes.length > 0 || allowed(tags.bicycle));
        if (!road && !bikePath) return { road, barrier: rail, paths: [], coverage: [] };
        const prohibited = ACCESS_DENIED.has(tags.bicycle) || (!allowed(tags.bicycle)
            && (ACCESS_DENIED.has(tags.access) || FREEWAY.has(tags.highway) || tags.motorroad === 'yes'));
        const offStreet = side => sideTag(tags, 'cycleway', side) === 'track'
            || hasPhysicalDivider(sideTag(tags, 'cycleway', side, ':separation'));
        const adjacentTraffic = (lane, direction) => {
            const sameSide = motors.filter(strip => supports(strip, direction));
            const candidates = sameSide.length ? sameSide : motors;
            const nearest = candidates.reduce((best, strip) =>
                !best || Math.abs(midpoint(strip) - midpoint(lane)) < Math.abs(midpoint(best) - midpoint(lane)) ? strip : best, null);
            return nearest && strips.slice(Math.min(lane.index, nearest.index) + 1, Math.max(lane.index, nearest.index))
                .some(strip => strip.type === 'verge' || strip.type === 'median');
        };
        const access = [], coverage = [];
        const metadata = definition.metadata || {};
        for (const direction of [1, -1]) {
            const dirName = direction === 1 ? 'forward' : 'backward';
            const sideDenied = ACCESS_DENIED.has(tags[`bicycle:${dirName}`]);
            const options = bikes.filter(strip => supports(strip, direction)).flatMap(strip => {
                const side = midpoint(strip) >= 0 ? 'left' : 'right';
                const type = sideTag(tags, 'cycleway', side);
                if (road && ['no', 'separate', 'shared_lane', 'share_busway', 'shoulder', 'crossing'].includes(type)) return [];
                return [{ type: !road || offStreet(side) || adjacentTraffic(strip, direction) ? 'protected' : 'painted', offset: midpoint(strip) }];
            });
            // A signed contraflow lane permits its own direction unless an explicit bicycle
            // direction rule forbids it. A prohibited carriageway cannot be entered.
            const permittedDirection = bikeDirections.includes(direction) || (road && options.length && tags['oneway:bicycle'] == null);
            if (!permittedDirection) continue;
            if (prohibited || sideDenied) {
                coverage.push('prohibited');
                continue;
            }
            let chosen = options.sort((a, b) => WEIGHTS[b.type] - WEIGHTS[a.type])[0];
            if (!chosen && bikePath) chosen = { type: 'protected', offset: 0 };
            if (!chosen && road) {
                const speed = postedSpeed(tags[`maxspeed:${dirName}`] ?? tags.maxspeed ?? metadata.maxspeed ?? metadata.speedLimitKmh);
                const slow = speed != null ? speed <= SLOW_KMH : tags.highway === 'living_street';
                chosen = { type: slow ? 'slow' : speed != null ? 'fast' : 'unknown', offset: 0 };
            }
            if (chosen) {
                access.push({ ...chosen, direction, separated: chosen.type === 'protected' && !cycleCrossing });
                coverage.push(chosen.type);
            }
        }
        const [a, b] = access;
        const paths = b && a.offset === b.offset && a.type === b.type ? [{ ...a, direction: 0 }] : access;
        return { barrier: road || rail, paths, coverage, cycleCrossing };
    }

    function crossesArm(a, b, arm) {
        const cross = (p, q) => p[0] * q[1] - p[1] * q[0];
        const u = minus(a, arm.xy), v = minus(b, arm.xy);
        const sideA = cross(arm.dir, u), sideB = cross(arm.dir, v);
        if (sideA * sideB >= -0.01) return false;
        const ratio = sideA / (sideA - sideB);
        const x = u[0] + (v[0] - u[0]) * ratio, y = u[1] + (v[1] - u[1]) * ratio;
        return x * arm.dir[0] + y * arm.dir[1] >= -0.05;
    }

    function network(entries, frame) {
        const paths = [], streets = [], links = [], gaps = [], segments = [], nodes = new Map();
        const pointXY = p => frame.latLngToMetric(p.lat, p.lng);
        for (const entry of entries) {
            const { points } = entry, design = grade(entry);
            if (!design.barrier && !design.coverage.length) continue;
            for (let i = 1; i < points.length; i++) {
                const from = points[i - 1], to = points[i], a = pointXY(from), b = pointXY(to);
                const metres = dist(a, b);
                if (metres < 0.05) continue;
                const dir = minus(b, a).map(value => value / metres);
                const atGround = !level(from) && !level(to);
                if (design.barrier) streets.push({ a, b, atGround });
                if (design.coverage.length) segments.push({ a, b, metres, tiers: design.coverage });
                const lanes = design.paths.map(lane => ({ ...lane, a: offset(a, dir, lane.offset), b: offset(b, dir, lane.offset),
                    ground: atGround, levels: [level(from), level(to)], splits: [] }));
                paths.push(...lanes);
                for (const [point, xy, atEnd] of [[from, a, false], [to, b, true]]) {
                    const key = nodeKey(point);
                    if (!nodes.has(key)) nodes.set(key, { arms: [], tags: [], level: level(point) });
                    const node = nodes.get(key);
                    node.tags.push(point.tags || {});
                    node.arms.push({ xy, dir: atEnd ? dir.map(value => -value) : dir, atEnd, metres, lanes,
                        barrier: design.barrier, cycleCrossing: design.cycleCrossing });
                }
            }
        }
        for (const { arms, tags, level: nodeLevel } of nodes.values()) {
            const linked = arms.flatMap(arm => arm.lanes.map(path => ({ arm, path, t: arm.atEnd ? 1 : 0,
                probe: offset(arm.xy, arm.dir, arm.atEnd ? -path.offset : path.offset, Math.min(arm.metres / 2, 8)),
                arrive: arm.atEnd ? path.direction >= 0 : path.direction <= 0,
                depart: arm.atEnd ? path.direction <= 0 : path.direction >= 0 })));
            const allowedCrossing = !tags.some(tag => tag.crossing === 'no')
                && (tags.some(tag => (tag.highway === 'crossing' || tag.crossing || tag.cycleway === 'crossing') && allowed(tag.bicycle))
                    || arms.some(arm => arm.cycleCrossing));
            const barrier = arms.filter(arm => arm.barrier);
            let missing = null;
            for (const a of linked) for (const b of linked) {
                if (a.path === b.path || !a.arrive || !b.depart) continue;
                // A standalone track meeting the centre of a through street needs a connection
                // too. Treating its end as both kerbs would bypass a missing crossing via the road.
                const joinsRoadCentre = (off, on) => off.path.separated && !off.arm.barrier && on.arm.barrier && on.path.offset === 0;
                const turnsAcross = ((a.path.separated || b.path.separated)
                    && barrier.some(arm => crossesArm(a.probe, b.probe, arm)))
                    || (barrier.length > 1 && (joinsRoadCentre(a, b) || joinsRoadCentre(b, a)));
                if (tags.some(tag => ACCESS_DENIED.has(tag.bicycle)) || (turnsAcross && !allowedCrossing)) {
                    missing ||= { kind: 'crossing-gap', points: [a.probe, b.probe] };
                    continue;
                }
                links.push({ a, b, direction: 1, delay: turnsAcross ? 8 : 0 });
            }
            if (missing) gaps.push(missing);
            else if (arms.length === 1 && linked.some(edge => edge.path.separated)) {
                const { path, t } = linked.find(edge => edge.path.separated);
                const end = t ? path.b : path.a;
                let nearest = null, metres = 15;
                for (const candidate of paths) {
                    if (arms[0].lanes.includes(candidate) || candidate.levels.some(value => value !== nodeLevel)) continue;
                    const direction = minus(candidate.b, candidate.a), delta = minus(end, candidate.a);
                    const ratio = Math.min(1, Math.max(0, (delta[0] * direction[0] + delta[1] * direction[1]) / dist(candidate.a, candidate.b) ** 2));
                    const point = travel.lerp(candidate.a, candidate.b, ratio), distance = dist(end, point);
                    if (distance > 0.1 && distance < metres) { nearest = point; metres = distance; }
                }
                if (nearest) gaps.push({ kind: 'unlinked-end', points: [end, nearest] });
            }
        }
        return { paths, streets, links, gaps, segments };
    }

    function evaluate(plan, designs) {
        const result = travel.assess(plan, designs, network, SPEED, 1.2);
        const { homes, destinations, connectedHomes, unstatedUse, lngLat, selectTrip } = result;
        const { segments = [], gaps } = result.network;
        const lengths = Object.fromEntries(TIERS.map(type => [type, 0]));
        for (const segment of segments) for (const type of segment.tiers) lengths[type] += segment.metres;
        const scoredM = Object.keys(WEIGHTS).reduce((sum, type) => sum + lengths[type], 0);
        const score = scoredM ? Math.round(Object.entries(WEIGHTS).reduce((sum, [type, weight]) => sum + lengths[type] * weight, 0) / scoredM) : null;
        const categories = Object.fromEntries(CATEGORIES.map(category => {
            const available = destinations.filter(row => row.category === category);
            return [category, { destinations: available.length, reachableDestinations: available.filter(place => place.reachable).length,
                reachableHomes: available.length ? homes.filter(row => row.routes[category]).length : null }];
        }));
        return { score, scoredM, lengths, categories, homes, destinations, connectedHomes, unstatedUse, selectTrip,
            gaps: gaps.map(gap => ({ kind: gap.kind, points: gap.points.map(lngLat) })),
            segments: segments.map(({ a, b, metres, tiers }) => ({ metres, tiers, points: [lngLat(a), lngLat(b)] })) };
    }

    return Object.freeze({ evaluate, CATEGORIES, TIERS, WEIGHTS });
});
