// The cross-section of a road placed into a parcel (docs/road-in-parcel.md): the lanes the author
// chose (the core) stay as chosen, and the sidewalks and verges at the edges fill the room the
// parcel leaves, so the road's land is exactly the parcel. A bounded road (definition.bound)
// keeps its land through every edit: a node may move and the lanes may change only while the
// lanes still fit, and the edges are re-filled after each change. Pure: the frame, the clearance
// rays and the profile helpers come from the browser globals or require() in node, so the browser
// and the MCP server measure and refuse alike (backend/test/corridor-site-fit.test.js).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__corridorSiteFit = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
    'use strict';

    const SIDEWALK_MAX_M = 3;     // a pavement grows to this, a verge takes the rest
    const SIDEWALK_MIN_M = 1.5;   // what a chosen set of lanes must leave on each side
    const TREE_VERGE_M = 2;       // a verge this wide gets trees, a narrower one grass
    const MIN_VERGE_M = 0.5;      // a narrower verge is added to the pavement instead
    const MIN_EDGE_M = 0.25;      // a narrower edge is left to the parcel's fill
    const OUTSIDE_TOLERANCE_M = 0.5;
    const EDGE_TYPES = new Set(['sidewalk', 'verge']);

    // Angel's arterial between its verges: cycleways, two lanes each way (the outer for buses) and
    // a planted median, 20 m; with 3 m pavements and 2 m tree verges it is the Schelling plan's
    // 30 m arterial (schelling-streets.js ARTERIAL_STRIPS).
    const ARTERIAL_CORE = Object.freeze([
        { type: 'cycleway', width: 2, direction: 'backward' },
        { type: 'driving', width: 3.5, direction: 'backward' }, { type: 'driving', width: 3.25, direction: 'backward' },
        { type: 'median', width: 2.5, landscape: 'grass' },
        { type: 'driving', width: 3.25, direction: 'forward' }, { type: 'driving', width: 3.5, direction: 'forward' },
        { type: 'cycleway', width: 2, direction: 'forward' }
    ]);
    const ARTERIAL_FROM_M = 30;
    const SHARED_FROM_M = 3.5;
    const LOCAL_FROM_M = 7;

    const round3 = value => Math.round(value * 1000) / 1000;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const clone = value => JSON.parse(JSON.stringify(value));

    function fromGlobalOrRequire(globalKey, modulePath, pick) {
        const found = global && global[globalKey];
        if (found) {
            if (!pick || typeof found === 'function') return found;
            if (typeof found[pick] === 'function') return found[pick];
        }
        if (typeof require === 'function') {
            const loaded = require(modulePath);
            return pick ? loaded[pick] : loaded;
        }
        throw new Error(`corridor-site-fit: ${globalKey} is not available`);
    }
    const segmentEntries = definition => fromGlobalOrRequire('corridorSegmentEntries', '../corridor-profile.js', 'corridorSegmentEntries')(definition);
    const clearanceSamples = (points, obstacles, options) => fromGlobalOrRequire('corridorClearanceSamples', '../corridor-clearance.js', 'corridorClearanceSamples')(points, obstacles, options);
    const presets = () => {
        if (global && global.CORRIDOR_PROFILE_PRESETS) return global.CORRIDOR_PROFILE_PRESETS;
        if (typeof require === 'function') return require('../corridor-profile.js').CORRIDOR_PROFILE_PRESETS;
        throw new Error('corridor-site-fit: CORRIDOR_PROFILE_PRESETS is not available');
    };
    const frames = () => fromGlobalOrRequire('__metricFrame', '../metric-frame.js');

    const widthOf = strips => round3(strips.reduce((sum, strip) => sum + Number(strip.width || 0), 0));

    // ---- cores and edges -----------------------------------------------------------------------

    // The lanes between the outer pavements and verges of a cross-section.
    function coreOf(profile) {
        const strips = (profile && Array.isArray(profile.strips)) ? profile.strips : (Array.isArray(profile) ? profile : []);
        let first = 0;
        let last = strips.length - 1;
        while (first <= last && EDGE_TYPES.has(strips[first].type)) first += 1;
        while (last >= first && EDGE_TYPES.has(strips[last].type)) last -= 1;
        return strips.slice(first, last + 1).map(strip => ({ ...strip }));
    }

    // The automatic lanes for a street `widthM` wide, the Schelling local street generalised:
    // two lanes (2.75 m under 10 m, else 3.25 m), a parking lane each side once 8 m are left beside
    // them, the arterial from 30 m, one shared lane from 3.5 m, nothing narrower.
    function coreFor(widthM) {
        const width = Number(widthM);
        if (!(width >= SHARED_FROM_M)) return null;
        if (width >= ARTERIAL_FROM_M) return ARTERIAL_CORE.map(strip => ({ ...strip }));
        if (width < LOCAL_FROM_M) return [{ type: 'driving', width: 3, direction: 'both' }];
        const lane = width < 10 ? 2.75 : 3.25;
        const parking = width - 2 * lane >= 8 ? 2 : 0;
        const core = [];
        if (parking) core.push({ type: 'parking', width: parking });
        core.push({ type: 'driving', width: lane, direction: 'backward' }, { type: 'driving', width: lane, direction: 'forward' });
        if (parking) core.push({ type: 'parking', width: parking });
        return core;
    }

    // One side's edge, outermost first: a pavement up to 3 m, then a verge with the rest.
    function edgesFor(sideM) {
        const side = round3(Number(sideM));
        if (!(side >= MIN_EDGE_M)) return [];
        let sidewalk = Math.min(side, SIDEWALK_MAX_M);
        let verge = round3(side - sidewalk);
        if (verge < MIN_VERGE_M) { sidewalk = side; verge = 0; }
        const out = [{ type: 'sidewalk', width: round3(sidewalk) }];
        if (verge > 0) out.push({ type: 'verge', width: verge, landscape: verge >= TREE_VERGE_M ? 'trees' : 'grass' });
        return out;
    }

    // `core` with its edges filled out to `widthM`, centred, or null when the lanes do not fit.
    function profileAround(core, widthM) {
        const side = (Number(widthM) - widthOf(core)) / 2;
        if (!(side >= -1e-6)) return null;
        const edge = edgesFor(side);
        return { strips: [...edge, ...core.map(strip => ({ ...strip })), ...edge.slice().reverse().map(strip => ({ ...strip }))] };
    }

    // The automatic cross-section of a street `widthM` wide (the Schelling streets use it too).
    function autoProfile(widthM) {
        const core = coreFor(widthM);
        return core ? profileAround(core, widthM) : null;
    }

    // An arm `widthM` wide with the author's lanes (`core`) or the automatic ones: the profile,
    // whether it fits, and the width the lanes need. A chosen core must leave 1.5 m of pavement
    // each side; the automatic one is sized to the street.
    function fitArm(widthM, core = null) {
        const width = Number(widthM);
        if (!core) {
            const auto = coreFor(width);
            if (!auto) return { profile: null, fits: false, requiredM: SHARED_FROM_M };
            return { profile: profileAround(auto, width), fits: true, requiredM: widthOf(auto) };
        }
        const requiredM = round3(widthOf(core) + 2 * SIDEWALK_MIN_M);
        if (!(width + 1e-6 >= requiredM)) return { profile: null, fits: false, requiredM };
        return { profile: profileAround(core, width), fits: true, requiredM };
    }

    // The lanes of the road presets (corridor-profile.js) that fit a street `widthM` wide, keyed by
    // the preset's total width, narrowest first.
    function corePresetsFor(widthM) {
        return Object.keys(presets())
            .map(Number)
            .sort((a, b) => a - b)
            .map(key => ({ key: String(key), core: coreOf({ strips: presets()[key] }) }))
            .filter(entry => entry.core.length && fitArm(widthM, entry.core).fits);
    }

    // ---- a bounded road ------------------------------------------------------------------------

    const isBounded = definition => !!(definition && definition.bound && definition.bound.site
        && ['Polygon', 'MultiPolygon'].includes(definition.bound.site.type));

    function siteRings(site, frame) {
        const polygons = site.type === 'Polygon' ? [site.coordinates] : site.coordinates;
        return polygons.flatMap(rings => rings.map(ring => ring.map(position => frame.toMetric(position))));
    }

    function frameOf(definition) {
        const api = frames();
        const provenance = definition && definition.constructionFrame;
        if (provenance && provenance.kind === api.CONTRACT.KIND) return api.frameFromProvenance(provenance);
        const positions = [];
        segmentEntries(definition).forEach(entry => entry.points.forEach(p => positions.push([p.lng, p.lat])));
        return api.frameFor(positions);
    }

    // The room each stretch of a bounded road has: twice the nearest boundary of its site, measured
    // square to the centre line every 2 m, so lanes centred on the line fit its narrowest part.
    // Stations where the room jumps (a crossing street, an opening) are not the street's width and
    // are left out: those whose two sides together exceed 1.5 times the stretch's median.
    function availableWidths(definition, frame = frameOf(definition)) {
        const obstacles = [{ id: 'site', kind: 'site', rings: siteRings(definition.bound.site, frame) }];
        return segmentEntries(definition).map((entry, index) => {
            const xy = entry.points.map(p => frame.toMetric([p.lng, p.lat]));
            const samples = clearanceSamples(xy, obstacles, { stationStep: 2, maxDistance: 200 })
                .filter(sample => sample.left && sample.right);
            const key = entry.segmentId !== null ? entry.segmentId : `#${index}`;
            if (!samples.length) return { key, segmentId: entry.segmentId, index, widthM: 0 };
            const sums = samples.map(sample => sample.left.distance + sample.right.distance).sort((a, b) => a - b);
            const median = sums[Math.floor(sums.length / 2)];
            const room = Math.min(...samples
                .filter(sample => sample.left.distance + sample.right.distance <= 1.5 * median + 1e-6)
                .map(sample => Math.min(sample.left.distance, sample.right.distance)));
            return { key, segmentId: entry.segmentId, index, widthM: round3(2 * room) };
        });
    }

    function insideRings(rings, point) {
        let inside = false;
        rings.forEach(ring => {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
                const a = ring[i];
                const b = ring[j];
                if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
            }
        });
        return inside;
    }

    function distanceToRings(rings, point) {
        let best = Infinity;
        rings.forEach(ring => {
            for (let i = 0; i < ring.length; i += 1) {
                const a = ring[i];
                const b = ring[(i + 1) % ring.length];
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const len2 = dx * dx + dy * dy;
                const t = len2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2)) : 0;
                best = Math.min(best, Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)));
            }
        });
        return best;
    }

    /**
     * What keeps a bounded road from being saved as it is: a centre-line node outside its site
     * (`outside-site`, beyond 0.5 m), or a stretch whose lanes need more room than the site leaves
     * there (`core-too-wide` with requiredM and availableM). Empty for a road that fits.
     */
    function boundedRoadIssues(definition, frame = frameOf(definition)) {
        if (!isBounded(definition)) return [];
        const issues = [];
        const rings = siteRings(definition.bound.site, frame);
        segmentEntries(definition).forEach(entry => entry.points.forEach(point => {
            const xy = frame.toMetric([point.lng, point.lat]);
            if (!insideRings(rings, xy) && distanceToRings(rings, xy) > OUTSIDE_TOLERANCE_M) {
                if (!issues.some(issue => issue.code === 'outside-site')) issues.push({ code: 'outside-site', at: { lat: point.lat, lng: point.lng } });
            }
        }));
        if (issues.length) return issues;
        const entries = segmentEntries(definition);
        availableWidths(definition, frame).forEach(room => {
            const core = coreOf(entries[room.index].profile);
            const requiredM = widthOf(core);
            if (requiredM > room.widthM + 1e-6) {
                issues.push({ code: 'core-too-wide', segmentId: room.segmentId, requiredM, availableM: room.widthM });
            }
        });
        return issues;
    }

    /**
     * A bounded road's cross-sections re-filled to its site: every stretch keeps its lanes and gets
     * new edges for the room it has now (after a node moved or the lanes changed). Every stretch
     * gets an id and its own profile, so each can be re-filled on its own. Returns a new definition;
     * a stretch whose lanes no longer fit keeps its old edges (boundedRoadIssues names it).
     */
    function refitBounded(definition, frame = frameOf(definition)) {
        if (!isBounded(definition)) return definition;
        const next = clone(definition);
        const entries = segmentEntries(next);
        const ids = entries.map((entry, index) => entry.segmentId !== null ? entry.segmentId : `b${index + 1}`);
        const used = new Set();
        ids.forEach((id, index) => { if (used.has(id)) ids[index] = `${id}-${index + 1}`; used.add(ids[index]); });
        const profiles = {};
        const rooms = availableWidths({ ...next, segmentIds: ids }, frame);
        entries.forEach((entry, index) => {
            const core = coreOf(entry.profile);
            const refilled = core.length ? profileAround(core, rooms[index].widthM) : null;
            profiles[ids[index]] = refilled || clone(entry.profile);
        });
        next.segmentIds = ids;
        next.profile = clone(profiles[ids[0]]);
        next.segmentProfiles = profiles;
        next.width = widthOf(next.profile.strips);
        return next;
    }

    return Object.freeze({
        SIDEWALK_MAX_M, SIDEWALK_MIN_M, TREE_VERGE_M, ARTERIAL_CORE,
        coreOf, coreFor, edgesFor, profileAround, autoProfile, fitArm, corePresetsFor, widthOf,
        isBounded, availableWidths, boundedRoadIssues, refitBounded, frameOf
    });
});
