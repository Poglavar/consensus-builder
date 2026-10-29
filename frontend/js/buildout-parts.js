// Which parts of a design the model view draws while it is planned or under construction: built
// floors, scaffold, crane and pit of a building, the laid share of a road, the covered share of a
// park, square or lake. Pure and DOM-free; three-mode.js draws what it returns
// (docs/buildout-timeline.md, model view).
(function (root, factory) {
    const schedule = typeof module === 'object' && module.exports ? require('./buildout-schedule.js') : root.BuildoutSchedule;
    const api = factory(schedule);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildoutParts = api;
})(typeof window !== 'undefined' ? window : null, function (schedule) {
    'use strict';
    const AREA_STEPS = 10;

    // Storeys of a building `heightM` tall at `floorHeightM` per storey; at least one.
    function storeys(heightM, floorHeightM) {
        const h = Number(heightM), f = Number(floorHeightM);
        if (!Number.isFinite(h) || h <= 0 || !Number.isFinite(f) || f <= 0) return 1;
        return Math.max(1, Math.round(h / f));
    }

    // A building site at a state: the floors standing, an excavation pit while none stand, a
    // scaffold around the top built floor and a crane while it rises. null = not there yet.
    function buildingSite(totalFloors, state) {
        if (!state || state.phase === 'built') return { floors: totalFloors, pit: false, scaffold: false, crane: false };
        if (state.phase === 'planned') return null;
        const floors = schedule.builtFloors(totalFloors, state);
        return { floors, pit: floors === 0, scaffold: floors > 0, crane: true };
    }

    // Progress in tenths: roads and grounds are redrawn only when it crosses one.
    function areaStep(progress, steps = AREA_STEPS) {
        const p = Number(progress);
        if (!Number.isFinite(p) || p <= 0) return 0;
        return Math.min(steps, Math.floor(p * steps + 1e-9));
    }
    const areaShare = (progress, steps = AREA_STEPS) => areaStep(progress, steps) / steps;

    // What a design draws at a state, as a key: the model view redraws a design only when it changes.
    // `buildings` lists its buildings as { floors, state } (a building of a simulated urban rule has
    // its own state, any other its design's); `area` says whether it has a road or a ground to lay.
    function siteKey(state, { buildings = [], area = false } = {}) {
        if (!state || state.phase === 'built') return 'built';
        if (state.phase === 'planned') return 'planned';
        const parts = buildings.map(({ floors, state: own }) => {
            const at = own || state;
            return at.phase === 'built' ? 'b' : at.phase === 'planned' ? 'p' : schedule.builtFloors(floors, at);
        });
        if (area) parts.push(`a${areaStep(state.progress)}`);
        return `construction:${parts.join(',')}`;
    }

    // Two site maps (id → { key, phase }) compared: the ids whose drawing changed, and whether the
    // set of designs not yet started or the set not yet built changed.
    function diffSites(before, after) {
        const changed = new Set();
        const ids = new Set([...before.keys(), ...after.keys()]);
        let plannedChanged = false, unbuiltChanged = false;
        for (const id of ids) {
            const a = before.get(id), b = after.get(id);
            if (a?.key !== b?.key) changed.add(id);
            if ((a?.phase === 'planned') !== (b?.phase === 'planned')) plannedChanged = true;
            if (!!a !== !!b) unbuiltChanged = true;
        }
        return { changed, plannedChanged, unbuiltChanged };
    }

    // The first `share` of the total length of a set of polyline runs, and the rest. Runs are laid
    // in order; `distance(a, b)` measures, `lerp(a, b, t)` makes a point between two. Each result
    // keeps the run's index: laid[i] / rest[i] is null when nothing of run i is in it.
    function splitRunsAtShare(runs, share, { distance, lerp }) {
        const lengths = runs.map(points => {
            let length = 0;
            for (let i = 1; i < (points?.length || 0); i++) length += distance(points[i - 1], points[i]);
            return length;
        });
        const total = lengths.reduce((sum, length) => sum + length, 0);
        let budget = Math.min(1, Math.max(0, Number(share) || 0)) * total;
        const laid = [], rest = [];
        runs.forEach((points, index) => {
            if (!Array.isArray(points) || points.length < 2) { laid.push(null); rest.push(null); return; }
            if (budget >= lengths[index] - 1e-9) { laid.push(points); rest.push(null); budget -= lengths[index]; return; }
            if (budget <= 1e-9) { laid.push(null); rest.push(points); return; }
            let walked = 0;
            for (let i = 1; i < points.length; i++) {
                const step = distance(points[i - 1], points[i]);
                if (walked + step < budget) { walked += step; continue; }
                const cut = lerp(points[i - 1], points[i], step > 0 ? (budget - walked) / step : 0);
                laid.push([...points.slice(0, i), cut]);
                rest.push([cut, ...points.slice(i)]);
                break;
            }
            budget = 0;
        });
        return { laid, rest };
    }

    // ---- a ground split by a north–south line: the covered west part holds `share` of its area ----
    const polygonsOf = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
    function ringArea(ring) {
        let sum = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
        return Math.abs(sum) / 2;
    }
    const polygonArea = rings => rings.reduce((sum, ring, i) => sum + (i === 0 ? 1 : -1) * ringArea(ring), 0);
    // Sutherland–Hodgman against the half-plane x ≤ cut (west) or x ≥ cut; a closed ring in, a closed
    // ring out (or null).
    function clipRing(ring, cut, west) {
        const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
        const out = [];
        for (let i = 0; i < open.length; i++) {
            const a = open[i], b = open[(i + 1) % open.length];
            const aIn = west ? a[0] <= cut : a[0] >= cut, bIn = west ? b[0] <= cut : b[0] >= cut;
            if (aIn) out.push(a);
            if (aIn !== bIn) {
                const t = (cut - a[0]) / (b[0] - a[0]);
                out.push([cut, a[1] + (b[1] - a[1]) * t]);
            }
        }
        if (out.length < 3) return null;
        out.push(out[0]);
        return out;
    }
    function clip(polygons, cut, west) {
        return polygons.map(rings => {
            const outer = clipRing(rings[0], cut, west);
            return outer ? [outer, ...rings.slice(1).map(ring => clipRing(ring, cut, west)).filter(Boolean)] : null;
        }).filter(Boolean);
    }
    const geometryOf = polygons => !polygons.length ? null
        : polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
    const area = polygons => polygons.reduce((sum, rings) => sum + polygonArea(rings), 0);
    // { covered, bare }: the ground's geometry west and east of the line; either is null when empty.
    function groundShares(geometry, share) {
        const polygons = polygonsOf(geometry);
        const s = Number(share);
        if (!polygons.length) return { covered: null, bare: null };
        if (!Number.isFinite(s) || s <= 0) return { covered: null, bare: geometry };
        if (s >= 1) return { covered: geometry, bare: null };
        const xs = polygons.flatMap(rings => rings[0].map(point => point[0]));
        let lo = Math.min(...xs), hi = Math.max(...xs);
        const target = area(polygons) * s;
        for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2;
            if (area(clip(polygons, mid, true)) < target) lo = mid; else hi = mid;
        }
        return { covered: geometryOf(clip(polygons, hi, true)), bare: geometryOf(clip(polygons, hi, false)) };
    }

    return Object.freeze({ AREA_STEPS, storeys, buildingSite, areaStep, areaShare, siteKey, diffSites, splitRunsAtShare, groundShares });
});
