// Suggested default floor plans for proposed buildings: a point-access core (stair wrapped around a
// lift, or an open stairwell) entered from the building's long side, two apartments per core with
// rooms, windows on every free facade and a balcony for the living room, blind party walls and
// boundary walls, one extra core per ~2 × 120 m² of floor, an optional active ground floor and a
// garage level. A floor plate 15 m deep or more (or one whose design or view asks for it) gets a
// double-loaded corridor instead: flats on both sides by a studio-to-three-bed mix, stair cores on
// the corridor by the egress limits, three-bed flats wrapping the gable ends. The output is the SAME `consensus-builder.building-floor-plans.v3` contract that
// evidence-backed reconstructions use (building-floor-plans.js validates it, three-floor-plans.js
// renders it), so a generated layout is just another source adapter. It is flagged `suggested: true`
// and its layout sources are `{ kind: 'generated' }` — a suggestion for X-ray, never part of the
// proposal. Pure: footprint + context in, a floorPlans object or warnings out. turf is the browser
// global, options.turf, or require('@turf/turf') in node; default-floor-plan-rooms.js furnishes
// the interiors. No DOM, no THREE.
(function (global) {
    'use strict';

    // A clip that throws degrades only this suggestion (an X-ray aid, never part of the proposal),
    // but it is logged and counted in clipHealth() (parcel-arrangement.js), never silently skipped.
    function reportClip(operation, error, site, operands) {
        const api = (global && global.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        if (api) return api.reportClipFailure(operation, error, { site }, operands);
        console.error(`[${new Date().toISOString()}] [clip] Polygon ${operation} failed at ${site}: ${error && error.message} — degraded`);
        return error;
    }

    const buildingUse = () => (global && global.BuildingUse) || require('./building-use.js');

    const GENERATOR_ID = 'consensus-builder.default-floor-plan.v1';
    const PLANS_SCHEMA = 'consensus-builder.building-floor-plans.v3';
    const ARCHITECTURE_SCHEMA = 'consensus-builder.floor-architecture.v1';

    // Regulation presets, selected by region (ISO 3166 alpha-2) or explicitly. Only the numbers a
    // regulation actually fixes live here; everything else is a design default in COMMON_RULES.
    //   HR: Tehnički propis o osiguranju pristupačnosti građevina osobama s invaliditetom i smanjene
    //       pokretljivosti (NN 12/2023), which applies to residential buildings with 10 or more
    //       apartments (čl. 7): stairs riser ≤ 15 cm, tread ≥ 33 cm, interior flight ≥ 110 cm (čl. 13);
    //       lift cabin ≥ 110 × 140 cm, door ≥ 90 cm (čl. 14); common corridor ≥ 150 cm (čl. 19);
    //       apartment entrance door ≥ 110 cm (čl. 24). Fire rulebook NN 29/2013 čl. 4: a building whose
    //       highest occupied floor lies above 22 m is a high-rise and needs a protected stair and a
    //       firefighting lift (čl. 44, HRN EN 81-72).
    //   generic: common international practice where no local rule is configured (IBC/DIN range).
    // A corridor's egress limits (maxDeadEndM: the corridor end farthest from a stair; maxStairSpacingM:
    // between two stairs) are design defaults of the usual European range, not cited to an article.
    const REGULATION_PRESETS = Object.freeze({
        HR: Object.freeze({ region: 'HR', regulationBasis: 'NN 12/2023 čl. 13, 14, 19, 24; NN 29/2013 čl. 4, 44',
            maxRiserM: 0.15, minTreadM: 0.33, flightWidthM: 1.10, landingDepthM: 1.50, apartmentDoorM: 1.10, liftDoorM: 0.90,
            liftCabinM: [1.10, 1.40], highRiseAboveM: 22, corridorWidthM: 1.50, maxDeadEndM: 15, maxStairSpacingM: 40 }),
        generic: Object.freeze({ region: 'generic', regulationBasis: 'generic practice (no local regulation configured)',
            maxRiserM: 0.17, minTreadM: 0.29, flightWidthM: 1.20, landingDepthM: 1.50, apartmentDoorM: 1.00, liftDoorM: 0.90,
            liftCabinM: [1.10, 1.40], highRiseAboveM: 22, corridorWidthM: 1.50, maxDeadEndM: 15, maxStairSpacingM: 40 })
    });
    // Corridor flats by count: widths along the corridor at a ~8 m row; a shallower row widens them so
    // the areas stay in range. Three-bed flats only at the gable ends, wrapping the corner.
    const CORRIDOR_MIX = Object.freeze([
        Object.freeze({ type: 'studio', share: 0.25, widthM: 4.8, areaM2: Object.freeze([30, 38]), bedrooms: 0, north: true }),
        Object.freeze({ type: 'one-bed', share: 0.40, widthM: 7.0, areaM2: Object.freeze([50, 58]), bedrooms: 1 }),
        Object.freeze({ type: 'two-bed', share: 0.30, widthM: 9.0, areaM2: Object.freeze([65, 75]), bedrooms: 2 }),
        Object.freeze({ type: 'three-bed', share: 0.05, areaM2: Object.freeze([85, 90]), bedrooms: 3, gable: true })
    ]);
    const COMMON_RULES = Object.freeze({
        halfLandingDepthM: 1.20,       // the turn between the two flights
        liftShaftOuterM: [2.00, 2.20], // a 110 × 140 cm cabin with its shaft walls
        stairEyeM: 0.25,               // open well between flights when there is no lift
        fireLobbyDepthM: 1.50,         // extra landing depth that stands in for a high-rise fire lobby
        entranceDoorM: 1.40,
        doorHeightM: 2.10,
        entranceHeightM: 2.30,
        exteriorWallM: 0.30,
        coreWallM: 0.20,
        apartmentWallM: 0.20,          // between the two apartments behind the core
        dilatationWallM: 0.25,         // between two cores' segments of one building
        slabThicknessM: 0.20,
        blindFacadeSetbackM: 3.0,      // facades closer than this to the parcel boundary stay blind
        minApartmentM2: 30,
        maxApartmentM2: 120,           // above this per apartment the floor gets another core
        minApartmentWidthM: 3.0,       // a strip beside the core narrower than this is not a room
        deepFloorPlateM: 16,           // facade-to-facade depth above which rooms lose daylight
        liftPolicy: 'auto',            // 'auto' | 'always' | 'never'
        liftFromFloors: 4,             // auto: a lift from P+3 upwards ...
        liftFromApartments: 10,        // ... or once the building reaches ten apartments
        balconies: true,
        groundFloorUse: 'auto',        // 'auto' | 'residential' | 'commercial'
        garage: 'auto',                // 'auto' | 'always' | 'never'
        garageLevels: 1,
        garageFromFloors: 4,
        garageFromUsableM2: 300,
        maxCores: 8,
        maxFloors: 60,
        minFootprintM2: 4,
        access: 'auto',                // 'auto' | 'point' | 'corridor' (building-use.js layoutAccess)
        corridorFromDepthM: 15,        // auto: a plate this deep inside its walls (two ~6.5 m rows + corridor) gets a corridor
        minCorridorRowDepthM: 5.0,     // a corridor row shallower than this holds no flat
        deepCorridorRowM: 10,          // a corridor row deeper than this leaves rooms far from the facade
        gableFlatDepthM: 4.8,          // the gable flat's depth from the end facade: hall 1.2 + rooms 3.4
        lobbyWidthM: 1.9,              // the stair lobby beside each corridor core, facade to corridor
        northFacingWithinDeg: 45,      // a facade facing within this of the pole is north-facing
        corridorMix: CORRIDOR_MIX
    });
    function rulesFor(options = {}) {
        const overrides = options.rules || {};
        const region = String(overrides.region || options.region || 'generic').toUpperCase();
        const preset = REGULATION_PRESETS[region] || REGULATION_PRESETS.generic;
        return Object.freeze({ ...COMMON_RULES, ...preset, ...overrides, region: preset.region });
    }
    const DEFAULT_RULES = rulesFor();

    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const round6 = value => Math.round(value * 1e6) / 1e6;
    const round2 = value => Math.round(value * 100) / 100;
    const EARTH_RADIUS_M = 6378137;
    const M_PER_DEG = Math.PI * EARTH_RADIUS_M / 180;

    function T(options) {
        if (options && options.turf) return options.turf;
        if (typeof turf !== 'undefined' && turf) return turf; // eslint-disable-line no-undef
        if (global && global.turf) return global.turf;
        try { return typeof require === 'function' ? require('@turf/turf') : null; } catch (_) { return null; }
    }
    function roomsModule(options) {
        if (options && options.rooms) return options.rooms;
        if (global && global.__defaultFloorPlanRooms) return global.__defaultFloorPlanRooms;
        try { return typeof require === 'function' ? require('./default-floor-plan-rooms.js') : null; } catch (_) { return null; }
    }

    // Ground metres about an anchor on turf's sphere, affine in lng/lat (same as site-plots.js).
    function makeFrame(anchorLng, anchorLat) {
        const mx = M_PER_DEG * Math.cos(anchorLat * Math.PI / 180);
        return {
            toMeters: ([lng, lat]) => [(lng - anchorLng) * mx, (lat - anchorLat) * M_PER_DEG],
            toDegrees: ([x, y]) => [anchorLng + x / mx, anchorLat + y / M_PER_DEG]
        };
    }

    function geometryOf(value) {
        const g = value && value.type === 'Feature' ? value.geometry : value;
        return g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null;
    }
    function polygonsOf(value) {
        const g = geometryOf(value);
        if (!g) return [];
        return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    }
    // Signed shoelace area of a ring (closed or not): > 0 counter-clockwise.
    function ringArea(ring) {
        let twice = 0;
        const n = ring.length;
        for (let i = 0; i < n; i++) {
            const p = ring[i], q = ring[(i + 1) % n];
            twice += p[0] * q[1] - q[0] * p[1];
        }
        return twice / 2;
    }
    function polygonsArea(value) {
        let area = 0;
        for (const rings of polygonsOf(value)) {
            rings.forEach((ring, index) => { area += (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)); });
        }
        return area;
    }
    // Drop the closing point and near-duplicate consecutive vertices.
    function cleanRing(ring, eps) {
        const out = [];
        for (const p of ring) {
            const prev = out[out.length - 1];
            if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < eps) continue;
            out.push([p[0], p[1]]);
        }
        while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < eps) out.pop();
        return out;
    }
    const closed = ring => [...ring, ring[0]];
    const rect = (t, u0, u1, v0, v1) => t.polygon([[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]]);
    const vec = (a, b) => [b[0] - a[0], b[1] - a[1]];
    const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
    const len = d => Math.hypot(d[0], d[1]);
    const unit = d => { const l = len(d); return [d[0] / l, d[1] / l]; };
    const leftNormal = d => [-d[1], d[0]];
    function strip(t, a, b, width) {
        const n = leftNormal(unit(vec(a, b)));
        return t.polygon([[add(a, n, width / 2), add(b, n, width / 2), add(b, n, -width / 2), add(a, n, -width / 2), add(a, n, width / 2)]]);
    }
    function unionAll(t, features) {
        let acc = null;
        for (const feature of features) {
            if (!feature || !feature.geometry) continue;
            if (!acc) { acc = feature; continue; }
            try { const merged = t.union(acc, feature); if (merged && merged.geometry) acc = merged; } catch (error) { reportClip('union', error, 'default-floor-plans.unionAll', [acc, feature]); }
        }
        return acc;
    }
    function differenceOrNull(t, a, b) {
        if (!a || !a.geometry) return null;
        if (!b || !b.geometry) return a;
        try { return t.difference(a, b); } catch (error) { reportClip('difference', error, 'default-floor-plans.difference', [a, b]); return null; }
    }
    function intersectOrNull(t, a, b) {
        if (!a || !a.geometry || !b || !b.geometry) return null;
        try { return t.intersect(a, b); } catch (error) { reportClip('intersect', error, 'default-floor-plans.intersect', [a, b]); return null; }
    }
    function uExtent(feature) {
        let lo = Infinity, hi = -Infinity;
        for (const rings of polygonsOf(feature)) for (const p of rings[0]) { lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
        return hi - lo;
    }
    const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    // Where neighbours stand right outside an edge, as merged [s0, s1] metre runs along it from `a`.
    // A shared wall rarely covers a whole edge, so windows and entrances keep to the free stretches.
    function partyRunsOf(t, a, b, d, inward, lengthM, neighboursM) {
        const out = [-inward[0], -inward[1]];
        const band = t.polygon([[add(a, out, 0.05), add(b, out, 0.05), add(b, out, 0.7), add(a, out, 0.7), add(a, out, 0.05)]]);
        const runs = [];
        for (const neighbour of neighboursM) {
            for (const rings of polygonsOf(intersectOrNull(t, band, neighbour))) {
                let s0 = Infinity, s1 = -Infinity;
                for (const p of rings[0]) { const s = (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]; s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
                s0 = Math.max(0, s0); s1 = Math.min(lengthM, s1);
                if (s1 - s0 > 0.05) runs.push([s0, s1]);
            }
        }
        runs.sort((x, y) => x[0] - y[0]);
        const merged = [];
        for (const run of runs) {
            const last = merged[merged.length - 1];
            if (last && run[0] <= last[1] + 0.3) last[1] = Math.max(last[1], run[1]);
            else merged.push(run.slice());
        }
        return merged;
    }

    // Risers divide the storey as evenly as the maximum riser allows; two flights share them.
    function stairRun(storeyHeightM, rules) {
        const risers = Math.max(2, Math.ceil(storeyHeightM / rules.maxRiserM - 1e-9));
        const riserM = storeyHeightM / risers;
        const first = Math.ceil(risers / 2), second = risers - first;
        return {
            risers, riserM, flights: [first, second],
            // The last riser of a flight steps onto its landing: a flight of R risers has R-1 treads.
            runM: (first - 1) * rules.minTreadM
        };
    }

    // perFloor: apartments on a storey (two per point core by default; a corridor's own count).
    function wantsLift(rules, floors, cores, highRise = false, perFloor = 2 * cores) {
        if (highRise) return true;
        if (rules.liftPolicy === 'always') return true;
        if (rules.liftPolicy === 'never') return false;
        return floors >= rules.liftFromFloors || floors * perFloor >= rules.liftFromApartments;
    }

    // Outer size of one core for this storey height, from the regulation minimums above.
    function coreDimensions(storeyHeightM, rules, lift, highRise = false) {
        const stair = stairRun(storeyHeightM, rules);
        const eyeM = lift ? rules.liftShaftOuterM[0] : rules.stairEyeM;
        const flightZoneM = Math.max(stair.runM, lift ? rules.liftShaftOuterM[1] : 0);
        const landingM = rules.landingDepthM + (highRise ? rules.fireLobbyDepthM : 0);
        const innerWidthM = 2 * rules.flightWidthM + eyeM;
        const innerDepthM = landingM + flightZoneM + rules.halfLandingDepthM;
        return {
            stair, lift, highRise, eyeM, flightZoneM, landingM, innerWidthM, innerDepthM,
            widthM: innerWidthM + 2 * rules.coreWallM,
            depthM: innerDepthM + rules.coreWallM // the front wall of the core is the facade itself
        };
    }

    function warn(list, code, severity, message, data) {
        list.push({ code, severity, message, ...(data ? { data } : {}) });
    }

    // One warning summary that callers can show without re-deriving the geometry.
    function describe(result) {
        if (result.floorPlans) return `${result.summary.cores} core(s), ${result.summary.apartmentsPerFloor} apartments per storey`;
        return result.warnings.filter(w => w.severity === 'error').map(w => w.message).join(' ') || 'No layout generated.';
    }

    // Does an edge hint {a, b} (WGS84) name this edge? Matched by midpoints, so ring cleaning cannot break it.
    function matchEdge(edges, hint, frame) {
        if (!hint || !Array.isArray(hint.a) || !Array.isArray(hint.b)) return null;
        const hintMid = midpoint(frame.toMeters(hint.a), frame.toMeters(hint.b));
        return edges.reduce((best, edge) => {
            const distance = len(vec(midpoint(edge.a, edge.b), hintMid));
            return distance < 0.5 && (!best || distance < best.distance) ? { edge, distance } : best;
        }, null)?.edge || null;
    }

    // One stair core (dog-leg flights around a lift or an open well) in a local frame: x along the
    // core's width (absolute, centred on uc), y from its open front (a facade's inner face or the
    // corridor's edge) to its rear wall. pt maps a local point to (u, v), bx a local box to a rect.
    function coreParts(t, rules, core, storeyHeightM, lift, uc, pt, bx) {
        const out = { walls: [], openings: [], cuts: [], voids: [], landings: [], stairs: [], railings: [] };
        const x0 = uc - core.innerWidthM / 2, x1 = uc + core.innerWidthM / 2; // inner faces of the side walls
        const y0 = core.landingM;                                             // start of the flight zone
        const y1 = y0 + core.flightZoneM;                                     // start of the half landing
        const y2 = y1 + rules.halfLandingDepthM;                              // inner face of the rear wall
        out.walls.push(bx(x0 - rules.coreWallM, x0, 0, y2 + rules.coreWallM));
        out.walls.push(bx(x1, x1 + rules.coreWallM, 0, y2 + rules.coreWallM));
        out.walls.push(bx(x0, x1, y2, y2 + rules.coreWallM));
        out.rect = bx(x0 - rules.coreWallM, x1 + rules.coreWallM, 0, y2 + rules.coreWallM);
        // Flights rise away from the entrance on the left and return towards it on the right.
        const run = core.stair.runM;
        const leftX = x0 + rules.flightWidthM / 2, rightX = x1 - rules.flightWidthM / 2;
        const half = core.stair.flights[0] * core.stair.riserM;
        out.stairs.push({ a: pt(leftX, y0), b: pt(leftX, y0 + run), widthM: rules.flightWidthM, steps: core.stair.flights[0], fromM: 0, toM: half });
        if (core.stair.flights[1] > 0) {
            const run2 = (core.stair.flights[1] - 1) * rules.minTreadM;
            out.stairs.push({ a: pt(rightX, y1), b: pt(rightX, Math.max(y0 + 0.05, y1 - run2)), widthM: rules.flightWidthM,
                steps: core.stair.flights[1], fromM: half, toM: storeyHeightM });
        }
        out.landings.push(bx(x0, x1, y1, y2));
        out.voids.push(bx(x0, x1, y0, y2));
        if (lift) {
            const [shaftW, shaftD] = rules.liftShaftOuterM;
            const sx0 = uc - shaftW / 2, sx1 = uc + shaftW / 2, sy0 = y0, sy1 = y0 + shaftD;
            const shaft = differenceOrNull(t, bx(sx0, sx1, sy0, sy1),
                bx(sx0 + rules.coreWallM, sx1 - rules.coreWallM, sy0 + rules.coreWallM, sy1 - rules.coreWallM));
            if (shaft) out.walls.push(shaft);
            const doorY = sy0 + rules.coreWallM / 2;
            const liftDoor = { kind: 'slidingDoor', a: pt(uc - rules.liftDoorM / 2, doorY), b: pt(uc + rules.liftDoorM / 2, doorY),
                depthM: rules.coreWallM, sillM: 0, heightM: rules.doorHeightM, room: 'lift' };
            out.openings.push(liftDoor);
            out.cuts.push(strip(t, liftDoor.a, liftDoor.b, rules.coreWallM + 0.06));
        } else {
            // An open well needs a balustrade on the edges of both flights and across the landing side.
            out.railings.push({ a: pt(x0 + rules.flightWidthM, y0), b: pt(x0 + rules.flightWidthM, y1), heightM: 1.0 });
            out.railings.push({ a: pt(x1 - rules.flightWidthM, y0), b: pt(x1 - rules.flightWidthM, y1), heightM: 1.0 });
            out.railings.push({ a: pt(x0 + rules.flightWidthM, y0), b: pt(x1 - rules.flightWidthM, y0), heightM: 1.0 });
        }
        return { ...out, x0, x1, y0, y2 };
    }

    // Point cores or a double-loaded corridor, and why: an access the design or the view states
    // (rules.access, with rules.accessBasis 'design' | 'view'), else the floor plate's depth inside
    // its exterior walls against rules.corridorFromDepthM.
    function decideAccess(rules, plateDepthM) {
        const requested = rules.access === 'point' || rules.access === 'corridor' ? rules.access : null;
        if (requested) return { access: requested, basis: rules.accessBasis === 'view' ? 'view' : 'design', plateDepthM: round2(plateDepthM) };
        return { access: plateDepthM >= rules.corridorFromDepthM - 1e-9 ? 'corridor' : 'point', basis: 'depth', plateDepthM: round2(plateDepthM) };
    }

    // Corridor flats along row segments, by count as the mix asks. The storey's flat count comes from
    // the segment lengths; the mix shares it out by largest remainder into a pool of each type. Each
    // segment, those with a `prefer` type (studios on a north side) first, takes the counts from the
    // pool whose widths fill it with the least stretch, and the widths then stretch or shrink so it
    // fills exactly. segments: [{ from, to, prefer? }] along s;
    // returns per segment { flats: [{ entry, s0, s1 }], walls: [[s0, s1]] }.
    function fillRows(segments, mix, wallM) {
        const shares = mix.reduce((sum, m) => sum + m.share, 0);
        const meanW = mix.reduce((sum, m) => sum + m.share * m.widthM, 0) / shares;
        const minW = Math.min(...mix.map(m => m.widthM));
        const lengthOf = seg => seg.to - seg.from;
        const guess = segments.map(seg => (lengthOf(seg) < 0.5 * minW ? 0 : Math.max(1, Math.round((lengthOf(seg) + wallM) / (meanW + wallM)))));
        const total = guess.reduce((sum, k) => sum + k, 0);
        const quotas = mix.map(m => m.share / shares * total);
        const pool = quotas.map(Math.floor);
        quotas.map((q, j) => [q - Math.floor(q), j]).sort((a, b) => b[0] - a[0]).slice(0, total - pool.reduce((s, n) => s + n, 0)).forEach(([, j]) => { pool[j]++; });
        // Every way of splitting k flats over the mix's types.
        const compositions = (k, parts) => (parts === 1 ? [[k]] : Array.from({ length: k + 1 }, (_, a) => compositions(k - a, parts - 1).map(rest => [a, ...rest])).flat());
        const results = new Array(segments.length);
        const order = segments.map((_, i) => i).sort((a, b) => (segments[b].prefer ? 1 : 0) - (segments[a].prefer ? 1 : 0) || a - b);
        for (const i of order) {
            const seg = segments[i];
            if (!guess[i]) { results[i] = { flats: [], walls: [] }; continue; }
            let best = null;
            for (const k of [guess[i] - 1, guess[i], guess[i] + 1]) {
                const net = lengthOf(seg) - (k - 1) * wallM;
                if (k < 1 || net <= 0) continue;
                for (const counts of compositions(k, mix.length)) {
                    const sumW = counts.reduce((sum, n, j) => sum + n * mix[j].widthM, 0);
                    const over = counts.reduce((sum, n, j) => sum + Math.max(0, n - pool[j]), 0);
                    const preferred = counts.reduce((sum, n, j) => sum + (mix[j].type === seg.prefer ? Math.min(n, pool[j]) : 0), 0);
                    const cost = Math.abs(Math.log(net / sumW)) + 0.6 * over - 0.02 * preferred;
                    if (!best || cost < best.cost - 1e-12) best = { cost, counts, scale: net / sumW };
                }
            }
            best.counts.forEach((n, j) => { pool[j] = Math.max(0, pool[j] - n); });
            // Types alternate along the row: the most numerous first, round robin.
            const left = best.counts.slice(), picks = [];
            while (left.some(n => n > 0)) mix.map((m, j) => j).sort((a, b) => left[b] - left[a] || a - b).forEach(j => { if (left[j] > 0) { picks.push(mix[j]); left[j]--; } });
            const flats = [], walls = [];
            let cursor = seg.from;
            picks.forEach((entry, index) => {
                const s1 = index === picks.length - 1 ? seg.to : cursor + entry.widthM * best.scale;
                flats.push({ entry, s0: cursor, s1 });
                if (index < picks.length - 1) walls.push([s1, s1 + wallM]);
                cursor = s1 + wallM;
            });
            results[i] = { flats, walls };
        }
        return results;
    }

    /**
     * A double-loaded corridor along the building's spine, in the generator's (u, v) frame: s runs
     * along the spine and r across it, each one of u or v, so every box stays axis-aligned. Flats sit
     * on both sides, each touching a facade and the corridor; stair cores on the corridor take a bay
     * on the north side (else the less sunny one, else the street's), as many as the dead-end and
     * stair-spacing limits ask; each free gable end takes a three-bed flat across the whole depth.
     * Returns the parts planDefaultFloorPlans assembles, or { error: { code, message } }.
     */
    function planCorridorParts(c) {
        const { t, rules, inner, edgesUV, front, sunSign, ext, storeyHeightM, floors, highRise, facadeRun } = c;
        const failWith = (code, message) => ({ error: { code, message } });
        const alongU = ext.u1 - ext.u0 >= ext.v1 - ext.v0;
        const P = (s, r) => (alongU ? [s, r] : [r, s]);
        const sAxis = alongU ? [1, 0] : [0, 1], rAxis = alongU ? [0, 1] : [1, 0];
        const box = (s0, s1, r0, r1) => {
            const a = P(Math.min(s0, s1), Math.min(r0, r1)), b = P(Math.max(s0, s1), Math.max(r0, r1));
            return rect(t, Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]));
        };
        const clip = feature => intersectOrNull(t, inner, feature);
        const wall = rules.exteriorWallM, wc = rules.apartmentWallM, cw = rules.corridorWidthM, doorM = rules.apartmentDoorM;
        const [sLo, sHi] = alongU ? [ext.u0, ext.u1] : [ext.v0, ext.v1];
        const [rLo, rHi] = alongU ? [ext.v0, ext.v1] : [ext.u0, ext.u1];
        const S0 = sLo + wall, S1 = sHi - wall, R0 = rLo + wall, R1 = rHi - wall;
        const c0 = (R0 + R1) / 2 - cw / 2, c1 = c0 + cw, rMid = (c0 + c1) / 2;
        const rowDepthM = c0 - wc - R0;
        if (rowDepthM < rules.minCorridorRowDepthM) {
            return failWith('corridor-too-shallow', `The floor plate is too shallow for a corridor: each side keeps ${rowDepthM.toFixed(1)} m, under ${rules.minCorridorRowDepthM} m.`);
        }
        // The long sides: their facades, whether neighbours stand against them, and how far they face the pole.
        const cos30 = Math.cos(30 * Math.PI / 180);
        const facing = (axis, sign) => edgesUV.filter(edge => sign * (edge.inward[0] * axis[0] + edge.inward[1] * axis[1]) >= cos30);
        const mostly = (list, key) => { const total = list.reduce((sum, e) => sum + e.lengthM, 0); return total > 0 && list.reduce((sum, e) => sum + (e[key] ? e.lengthM : 0), 0) >= total / 2; };
        const rWorld = alongU ? front.inward : front.d;
        const northCos = Math.cos(rules.northFacingWithinDeg * Math.PI / 180);
        const sides = [-1, 1].map(sign => {
            const edges = facing(rAxis, -sign); // the low-r facade's inward normal points +r
            return { sign, key: sign < 0 ? 'lo' : 'hi', party: !edges.length || mostly(edges, 'party'), front: edges.some(e => e.isFront),
                pole: sunSign * sign * rWorld[1], facadeR: sign < 0 ? R0 : R1, edgeR: sign < 0 ? c0 : c1,
                rowR: sign < 0 ? [R0, c0 - wc] : [c1 + wc, R1], ey: [-sign * rAxis[0], -sign * rAxis[1]] };
        });
        const open = sides.filter(side => !side.party);
        if (!open.length) return failWith('corridor-no-facade', 'Neighbours stand against both long sides; a corridor building needs a free facade.');
        let coreSide = open.find(side => side.pole >= northCos) || null, coreBasis = 'north';
        if (!coreSide) {
            const [a, b] = open;
            if (b && Math.abs(a.pole - b.pole) > 0.2) { coreSide = a.pole > b.pole ? a : b; coreBasis = 'less-sunny'; }
            else { coreSide = open.find(side => side.front) || a; coreBasis = 'street'; }
        }
        const otherSide = sides.find(side => side !== coreSide);
        const rowMix = (rules.corridorMix || CORRIDOR_MIX).filter(m => !m.gable && m.share > 0)
            .map(m => ({ ...m, widthM: Math.min(m.widthM * 1.3, Math.max(m.widthM, (m.areaM2[0] + m.areaM2[1]) / 2 / rowDepthM)) }));
        const gableEntry = (rules.corridorMix || CORRIDOR_MIX).find(m => m.gable) || null;
        if (!rowMix.length) return failWith('corridor-no-mix', 'The corridor flat mix names no row flats.');
        const minW = Math.min(...rowMix.map(m => m.widthM));

        // --- the stair cores: lift, size, and how many the corridor's length asks -------------------
        const perFloorGuess = Math.max(2, Math.round(2 * (S1 - S0) / 7));
        const lift = wantsLift(rules, floors, 1, highRise, perFloorGuess);
        const core = coreDimensions(storeyHeightM, rules, lift, highRise);
        if (core.depthM > rowDepthM + wc + 1e-9) {
            return failWith('corridor-core-too-deep', `A ${core.widthM.toFixed(1)} × ${core.depthM.toFixed(1)} m stair core does not fit a ${rowDepthM.toFixed(1)} m corridor row.`);
        }
        const bayW = core.widthM + rules.lobbyWidthM;
        const ends = [-1, 1].map(sign => { const edges = facing(sAxis, -sign); return edges.length > 0 && !mostly(edges, 'party') && !mostly(edges, 'blind'); });
        const gW = rules.gableFlatDepthM;
        const roomForGables = count => (S1 - S0) - count * (gW + wc) >= bayW + 2 * minW;
        const gables = gableEntry ? [ends[0] && roomForGables(ends[1] ? 2 : 1), ends[1] && roomForGables(ends[0] ? 2 : 1)] : [false, false];
        const Sa = S0 + (gables[0] ? gW + wc : 0), Sb = S1 - (gables[1] ? gW + wc : 0), Lc = Sb - Sa;
        if (Lc < bayW + minW) return failWith('corridor-too-short', `A ${Lc.toFixed(1)} m corridor holds no stair core and flat.`);
        const D = rules.maxDeadEndM, Smax = rules.maxStairSpacingM;
        let stairs = Lc <= 2 * D ? 1 : 1 + Math.ceil((Lc - 2 * D) / Smax - 1e-9);
        if (highRise || Lc > Smax) stairs = Math.max(2, stairs);
        stairs = Math.min(stairs, rules.maxCores);
        const endGap = stairs === 1 ? Lc / 2 : Math.min(D, Lc / (2 * stairs));
        const centres = stairs === 1 ? [Sa + Lc / 2] : Array.from({ length: stairs }, (_, i) => Sa + endGap + i * (Lc - 2 * endGap) / (stairs - 1));
        // Each bay: the core on the corridor and a lobby beside it, towards the middle of the building.
        const bays = centres.map(p => {
            const lobbyHigh = p <= Sa + Lc / 2;
            let q0 = lobbyHigh ? p - core.widthM / 2 : p - core.widthM / 2 - rules.lobbyWidthM;
            let q1 = q0 + bayW;
            if (q0 < Sa) { q1 += Sa - q0; q0 = Sa; }
            if (q1 > Sb) { q0 -= q1 - Sb; q1 = Sb; }
            const cs0 = lobbyHigh ? q0 : q1 - core.widthM;
            return { q0, q1, cs0, cs1: cs0 + core.widthM, uc: cs0 + core.widthM / 2, lobbyHigh };
        });
        for (let i = 1; i < bays.length; i++) {
            if (bays[i].q0 < bays[i - 1].q1 + minW) return failWith('corridor-cores-crowded', 'The stair cores the corridor needs leave no room for flats between them.');
        }
        // A gap too short for a flat joins the neighbouring lobby.
        const gapLimit = 0.6 * minW;
        if (bays[0].q0 - Sa > 1e-6 && bays[0].q0 - Sa < gapLimit) bays[0].q0 = Sa;
        if (Sb - bays[bays.length - 1].q1 > 1e-6 && Sb - bays[bays.length - 1].q1 < gapLimit) bays[bays.length - 1].q1 = Sb;
        for (let i = 1; i < bays.length; i++) if (bays[i].q0 - bays[i - 1].q1 < gapLimit) bays[i - 1].q1 = bays[i].q0;

        // --- cores, lobbies and entrances -------------------------------------------------------------
        const parts = { coreWalls: [], coreOpenings: [], coreCuts: [], entranceOpenings: [], entranceCuts: [], voids: [], landings: [], stairs: [],
            coreRailings: [], coreRects: [], dividerWalls: [], apartmentDoors: [], apartmentDoorCuts: [] };
        const side = coreSide;
        const pt = (x, y) => P(x, side.edgeR + side.sign * y);
        const bx = (x0, x1, y0, y1) => box(x0, x1, side.edgeR + side.sign * y0, side.edgeR + side.sign * y1);
        const rowBox = (rowSide, s0, s1) => box(s0, s1, rowSide.rowR[0], rowSide.rowR[1]);
        for (const bay of bays) {
            const built = coreParts(t, rules, core, storeyHeightM, lift, bay.uc, pt, bx);
            parts.coreWalls.push(...built.walls); parts.coreOpenings.push(...built.openings); parts.coreCuts.push(...built.cuts);
            parts.voids.push(...built.voids); parts.landings.push(...built.landings); parts.stairs.push(...built.stairs);
            parts.coreRailings.push(...built.railings); parts.coreRects.push(built.rect);
            // The bay's walls against the flats beside it; the core's own side wall stands where it reaches.
            const fullRow = [side.rowR[0], side.rowR[1]];
            if (bay.q0 > Sa + 1e-6) parts.dividerWalls.push(differenceOrNull(t, clip(box(bay.q0, bay.q0 + wc, fullRow[0], fullRow[1])), built.rect));
            if (bay.q1 < Sb - 1e-6) parts.dividerWalls.push(differenceOrNull(t, clip(box(bay.q1 - wc, bay.q1, fullRow[0], fullRow[1])), built.rect));
            // The ground-floor entrance: through the facade into the lobby beside the core.
            const lobby = bay.lobbyHigh ? [bay.cs1, bay.q1 - wc] : [bay.q0 + wc, bay.cs0];
            const doorS = (lobby[0] + lobby[1]) / 2, doorR = side.facadeR + side.sign * wall / 2;
            const entrance = { kind: 'glazedDoor', a: P(doorS - rules.entranceDoorM / 2, doorR), b: P(doorS + rules.entranceDoorM / 2, doorR),
                depthM: wall, sillM: 0, heightM: Math.min(rules.entranceHeightM, storeyHeightM - rules.slabThicknessM - 0.3), room: 'entrance' };
            parts.entranceOpenings.push(entrance);
            parts.entranceCuts.push(strip(t, entrance.a, entrance.b, wall + 0.06));
        }
        // --- the corridor's walls, and the gable walls that close it -----------------------------------
        const coreSegments = [];
        let cursor = Sa;
        for (const bay of bays) { if (bay.q0 - cursor > 1e-6) coreSegments.push({ from: cursor, to: bay.q0 }); cursor = bay.q1; }
        if (Sb - cursor > 1e-6) coreSegments.push({ from: cursor, to: Sb });
        const corridorWall = (rowSide, s0, s1) => clip(box(s0, s1, rowSide.sign < 0 ? c0 - wc : c1, rowSide.sign < 0 ? c0 : c1 + wc));
        coreSegments.forEach(seg => parts.dividerWalls.push(corridorWall(coreSide, seg.from, seg.to)));
        parts.dividerWalls.push(corridorWall(otherSide, Sa, Sb));
        if (gables[0]) parts.dividerWalls.push(clip(box(Sa - wc, Sa, R0, R1)));
        if (gables[1]) parts.dividerWalls.push(clip(box(Sb, Sb + wc, R0, R1)));

        // --- flats: rows on both sides, then the gable ends ----------------------------------------------
        const studio = rowMix.find(m => m.north) || null;
        const northCore = coreBasis === 'north';
        const rows = [
            ...coreSegments.map(seg => ({ ...seg, rowSide: coreSide, prefer: northCore && studio ? studio.type : null })),
            { from: Sa, to: Sb, rowSide: otherSide, prefer: null }
        ];
        const filled = fillRows(rows, rowMix, wc);
        const apartments = [];
        const facadeFlag = polygon => {
            // Single aspect towards the pole: every free facade the flat touches faces north.
            if (!facadeRun) return null;
            const touched = c.facades.filter(f => !f.party && !f.blind && facadeRun(t, polygon, f, wall));
            return touched.length && touched.every(f => -f.sun >= northCos) ? 'north-single-aspect' : null;
        };
        const addFlat = (entry, polygon, env, door, into) => {
            if (!polygon || polygonsArea(polygon) < rules.minApartmentM2 * 0.5) return;
            apartments.push({ unitId: `flat-${apartments.length + 1}`, type: entry.type, polygon, areaM2: polygonsArea(polygon), env, flag: facadeFlag(polygon) });
            const opening = { kind: 'door', ...door, depthM: wc, sillM: 0, heightM: rules.doorHeightM, hinge: door.b, openTip: add(door.b, into, doorM), room: 'apartment' };
            parts.apartmentDoors.push(opening);
            parts.apartmentDoorCuts.push(strip(t, opening.a, opening.b, wc + 0.06));
        };
        rows.forEach((row, index) => {
            const rowSide = row.rowSide, rDoor = rowSide.edgeR + rowSide.sign * wc / 2;
            filled[index].walls.forEach(([s0, s1]) => parts.dividerWalls.push(clip(rowBox(rowSide, s0, s1))));
            for (const flat of filled[index].flats) {
                const env = { layout: 'row', origin: P(flat.s0, rowSide.facadeR), ex: sAxis, ey: rowSide.ey, widthM: flat.s1 - flat.s0,
                    depthM: rowDepthM, doorX: [0.35, 0.35 + doorM], bedrooms: flat.entry.bedrooms, balconyOnFront: true };
                // The entrance door swings into the flat, away from the corridor.
                addFlat(flat.entry, clip(rowBox(rowSide, flat.s0, flat.s1)), env,
                    { a: P(flat.s0 + 0.35, rDoor), b: P(flat.s0 + 0.35 + doorM, rDoor) }, [-rowSide.ey[0], -rowSide.ey[1]]);
            }
        });
        // The living room takes the sunnier corner of a gable flat.
        const livingAtEnd = sides[1].pole < sides[0].pole;
        [[gables[0], S0, Sa - wc, Sa - wc / 2, sAxis], [gables[1], S1, Sb + wc, Sb + wc / 2, [-sAxis[0], -sAxis[1]]]].forEach(([present, facadeS, wallS, doorS, ey]) => {
            if (!present) return;
            const env = { layout: 'gable', origin: P(facadeS, R0), ex: rAxis, ey, widthM: R1 - R0, depthM: Math.abs(wallS - facadeS),
                doorX: [rMid - R0 - doorM / 2, rMid - R0 + doorM / 2], bedrooms: gableEntry.bedrooms, livingAtEnd, balconyOnFront: true };
            addFlat(gableEntry, clip(box(facadeS, wallS, R0, R1)), env,
                { a: P(doorS, rMid - doorM / 2), b: P(doorS, rMid + doorM / 2) }, [-ey[0], -ey[1]]);
        });
        if (!apartments.length) return failWith('corridor-no-flats', 'No corridor flat fits this floor plate.');

        const deadEndM = Math.max(bays[0].uc - Sa, Sb - bays[bays.length - 1].uc);
        const maxStairGapM = bays.slice(1).reduce((max, bay, i) => Math.max(max, bay.uc - bays[i].uc), 0);
        const mix = {};
        apartments.forEach(apartment => { mix[apartment.type] = (mix[apartment.type] || 0) + 1; });
        return {
            ...parts, dividerWalls: parts.dividerWalls.filter(Boolean), access: 'corridor', cores: bays.length, lift, core, dilatations: [], apartments,
            corridor: { lengthM: round2(Lc), widthM: cw, stairs: bays.length, deadEndM: round2(deadEndM), maxStairGapM: round2(maxStairGapM),
                rowDepthM: round2(rowDepthM), coreSide: coreBasis, gables: gables.filter(Boolean).length, mix,
                spine: [P(Sa, rMid), P(Sb, rMid)], stairCentres: bays.map(bay => P(bay.uc, rMid)) },
            garageVRange: [ext.v0 + wall, ext.v1 - wall]
        };
    }

    /**
     * Plan the default layout of one building (one parcel slice).
     * @param {object} input
     *   footprint     WGS84 Polygon/MultiPolygon Feature or geometry (the building on ONE parcel)
     *   floors        integer storeys above ground (≥ 1)
     *   storeyHeightM floor-to-floor height (default 3.0)
     *   neighbours    footprints (WGS84) of buildings touching this one: shared edges become party walls
     *   blindEdges    [{a, b}] edges (WGS84) that must stay without openings (near a parcel boundary)
     *   front         { a: [lng,lat], b: [lng,lat], basis? } the entrance edge, or null
     *   typology      'block' | 'row' | 'parcel' | 'single' | undefined (used by the ground-floor rule)
     *   buildingId    stable id used in floor/apartment ids (default 'building')
     * @param {object} options { turf, rooms, region, rules: partial overrides of the rules, validate(fn) }
     * @returns {{ floorPlans: object|null, warnings: object[], summary: object }}
     */
    function planDefaultFloorPlans(input, options = {}) {
        const t = T(options);
        if (!t) throw new Error('default-floor-plans: turf is not available');
        const rooms = roomsModule(options);
        const rules = rulesFor(options);
        const warnings = [];
        const summary = { cores: 0, apartmentsPerFloor: 0, apartmentAreasM2: [], lift: false, highRise: false, coreM: null,
            frontBasis: null, frontEdge: null, region: rules.region, groundFloorUse: 'residential', garageLevels: 0, rooms: 0 };
        const fail = () => ({ floorPlans: null, warnings, summary });

        // --- storeys ---------------------------------------------------------------------------
        const floors = Number.isInteger(input.floors) ? input.floors : null;
        if (!floors || floors < 1) {
            warn(warnings, 'floors-unknown', 'error', 'The number of storeys is unknown.');
            return fail();
        }
        if (floors > rules.maxFloors) {
            warn(warnings, 'too-many-floors', 'error', `More than ${rules.maxFloors} storeys are not modelled.`);
            return fail();
        }
        const storeyHeightM = finite(input.storeyHeightM) && input.storeyHeightM > 0 ? input.storeyHeightM : 3.0;
        if (storeyHeightM < 2.5 || storeyHeightM > 6) {
            warn(warnings, 'storey-height-implausible', 'error', `A storey height of ${storeyHeightM.toFixed(2)} m is outside 2.5–6 m.`);
            return fail();
        }
        const topFloorM = (floors - 1) * storeyHeightM;
        const highRise = topFloorM > rules.highRiseAboveM;
        summary.highRise = highRise;

        // --- footprint ring in ground metres --------------------------------------------------
        const polygons = polygonsOf(input.footprint);
        if (!polygons.length) {
            warn(warnings, 'invalid-footprint', 'error', 'The footprint is not a polygon.');
            return fail();
        }
        if (polygons.length > 1) warn(warnings, 'multipolygon-largest-part', 'notice', 'Only the largest part of a multi-part footprint is laid out.');
        const outerLngLat = polygons.map(rings => rings[0]).reduce((best, ring) => {
            const area = Math.abs(ringArea(ring.map(p => [p[0] * 1e5, p[1] * 1e5])));
            return !best || area > best.area ? { ring, area } : best;
        }, null).ring;
        const anchor = outerLngLat.reduce((s, p) => [s[0] + p[0] / outerLngLat.length, s[1] + p[1] / outerLngLat.length], [0, 0]);
        const frame = makeFrame(anchor[0], anchor[1]);
        const sunSign = anchor[1] >= 0 ? 1 : -1; // the sunny side faces the equator
        let ringM = cleanRing(outerLngLat.map(frame.toMeters), 0.02);
        if (ringM.length < 3 || Math.abs(ringArea(ringM)) < rules.minFootprintM2) {
            warn(warnings, 'invalid-footprint', 'error', 'The footprint is too small or degenerate.');
            return fail();
        }
        if (ringArea(ringM) < 0) ringM = ringM.slice().reverse(); // interior on the left of every edge

        // Exterior walls: the footprint minus its inward offset. The offset is geodesic (turf.buffer in
        // WGS84) and then expressed in the same metre frame, so wall thickness is true metres.
        const bufferedLngLat = t.buffer(t.polygon([closed(ringM.map(frame.toDegrees))]), -rules.exteriorWallM, { units: 'meters' });
        const innerPolygons = polygonsOf(bufferedLngLat).map(rings => rings.map(ring => ring.map(frame.toMeters)));
        if (!innerPolygons.length) {
            warn(warnings, 'too-small-for-walls', 'error', 'Too small to hold exterior walls.');
            return fail();
        }

        // --- party walls, blind walls and the front edge ------------------------------------------
        const neighboursM = (input.neighbours || []).flatMap(polygonsOf).map(rings => t.polygon(rings.map(ring => ring.map(frame.toMeters))));
        const edges = ringM.map((a, index) => {
            const b = ringM[(index + 1) % ringM.length];
            const d = unit(vec(a, b));
            const inward = leftNormal(d);
            const lengthM = len(vec(a, b));
            // A party wall is an edge mostly against a neighbour: it takes no entrance and no end ramp.
            const partyRuns = partyRunsOf(t, a, b, d, inward, lengthM, neighboursM);
            const party = partyRuns.reduce((sum, run) => sum + run[1] - run[0], 0) >= lengthM / 2;
            return { index, a, b, d, inward, lengthM, party, partyRuns, blind: false, sun: sunSign * inward[1] };
        });
        for (const hint of input.blindEdges || []) {
            const edge = matchEdge(edges, hint, frame);
            if (edge) edge.blind = true;
        }
        const exterior = edges.filter(edge => !edge.party);
        if (!exterior.length) {
            warn(warnings, 'no-exterior-edge', 'error', 'Every edge is a party wall; there is no facade for an entrance.');
            return fail();
        }
        let front = null, frontBasis = 'longest';
        if (input.front && Array.isArray(input.front.a) && Array.isArray(input.front.b)) {
            const match = matchEdge(edges, input.front, frame);
            if (match && !match.party) { front = match; frontBasis = input.front.basis || 'user'; match.blind = false; }
            else if (match) warn(warnings, 'front-is-party-wall', 'notice', 'The chosen front is a party wall; the longest facade is used instead.');
            else warn(warnings, 'front-not-found', 'notice', 'The chosen front does not match an edge of this building; the longest facade is used instead.');
        }
        if (!front) {
            const open = exterior.filter(edge => !edge.blind);
            front = (open.length ? open : exterior).reduce((best, edge) => (edge.lengthM > best.lengthM ? edge : best), (open.length ? open : exterior)[0]);
            front.blind = false;
            if (!input.front) warn(warnings, 'front-assumed-longest', 'notice', 'No street data: the entrance faces the longest facade.');
        }
        summary.frontBasis = frontBasis;
        summary.frontEdge = { a: frame.toDegrees(front.a), b: frame.toDegrees(front.b), lengthM: front.lengthM };

        // --- the layout frame: u along the front edge, v into the building -----------------------
        const toUV = p => { const r = vec(front.a, p); return [r[0] * front.d[0] + r[1] * front.d[1], r[0] * front.inward[0] + r[1] * front.inward[1]]; };
        const fromUV = ([u, v]) => add(add(front.a, front.d, u), front.inward, v);
        const ringUV = ringM.map(toUV);
        const us = ringUV.map(p => p[0]), vs = ringUV.map(p => p[1]);
        // Balconies stand outside the footprint, so the registration frame keeps a margin for them.
        const margin = rules.balconies ? 1.7 : 0;
        const umin = Math.min(...us) - margin, umax = Math.max(...us) + margin, vmin = Math.min(...vs) - margin, vmax = Math.max(...vs) + margin;
        const W = umax - umin, H = vmax - vmin;
        if (W - 2 * margin < 1 || H - 2 * margin < 1) {
            warn(warnings, 'invalid-footprint', 'error', 'The footprint is narrower than one metre.');
            return fail();
        }
        const fp = t.polygon([closed(ringUV)]);
        const inner = innerPolygons.length === 1
            ? t.polygon(innerPolygons[0].map(ring => ring.map(toUV)))
            : t.multiPolygon(innerPolygons.map(rings => rings.map(ring => ring.map(toUV))));
        const edgesUV = edges.map(edge => {
            const a = toUV(edge.a), b = toUV(edge.b), d = unit(vec(a, b));
            return { ...edge, a, b, d, inward: leftNormal(d), isFront: edge.index === front.index };
        });
        const footprintUmin = Math.min(...us), footprintUmax = Math.max(...us), footprintVmin = Math.min(...vs), footprintVmax = Math.max(...vs);
        const usableM2 = polygonsArea(inner);
        const exteriorWalls = differenceOrNull(t, fp, inner);
        const facades = edgesUV.map(edge => ({ index: edge.index, a: edge.a, b: edge.b, d: edge.d, inward: edge.inward, lengthM: edge.lengthM,
            party: edge.party, partyRuns: edge.partyRuns, blind: edge.blind, isFront: edge.isFront, sun: edge.sun }));

        // --- access: point cores, or a double-loaded corridor along a deep plate ------------------
        const decision = decideAccess(rules, Math.min(footprintUmax - footprintUmin, footprintVmax - footprintVmin) - 2 * rules.exteriorWallM);
        if (decision.access === 'corridor') {
            const corridorParts = planCorridorParts({ t, rules, inner, edgesUV, facades, front, sunSign, storeyHeightM, floors, highRise,
                ext: { u0: footprintUmin, u1: footprintUmax, v0: footprintVmin, v1: footprintVmax }, facadeRun: rooms ? rooms.facadeRun : null });
            if (!corridorParts.error) {
                const rowM = corridorParts.corridor.rowDepthM;
                if (rowM > rules.deepCorridorRowM) warn(warnings, 'deep-corridor-rows', 'notice', `Each corridor row is ${Math.round(rowM)} m deep; rooms far from the facade get little daylight.`);
                return finish(corridorParts);
            }
            warn(warnings, corridorParts.error.code, 'notice', `${corridorParts.error.message} The layout uses point access instead.`);
            decision.fallback = corridorParts.error.code;
        }

        // --- how many cores, and their size ------------------------------------------------------
        let cores = Math.max(1, Math.min(rules.maxCores, Math.ceil(usableM2 / (2 * rules.maxApartmentM2))));
        const lift = wantsLift(rules, floors, cores, highRise);
        const core = coreDimensions(storeyHeightM, rules, lift, highRise);
        summary.lift = lift;
        summary.coreM = [round2(core.widthM), round2(core.depthM)];
        if (highRise) warn(warnings, 'high-rise', 'notice', `The top floor lies ${Math.round(topFloorM)} m up, above ${rules.highRiseAboveM} m: a protected stair with a fire lobby and a firefighting lift are assumed.`);
        const noCoreFits = detail => {
            warn(warnings, 'core-does-not-fit', 'error',
                `Too small to fit a minimum ${lift ? 'stair and lift' : 'stair'} core of ${summary.coreM[0]} × ${summary.coreM[1]} m behind the front facade.`,
                { coreM: summary.coreM, cores, ...detail });
            return fail();
        };

        // Entrance facades are the exterior edges facing the way the front edge faces (within 30°):
        // a jogged or stepped street facade is several of them, each with its own building line. The
        // cores are spread evenly along their total length, so an end bump-out past the facade does
        // not claim a core of its own, and one core cannot stand on another.
        // Only the stretches no neighbour stands against can take an entrance.
        const spans = edgesUV.filter(edge => !edge.blind && edge.inward[1] > Math.cos(30 * Math.PI / 180))
            .flatMap(edge => rooms.freeRuns(edge, [0, edge.lengthM], core.widthM).map(([s0, s1]) => {
                const ends = [add(edge.a, edge.d, s0), add(edge.a, edge.d, s1)];
                const [p, q] = ends[0][0] <= ends[1][0] ? ends : [ends[1], ends[0]];
                return { index: edge.index, from: p[0], to: q[0], length: q[0] - p[0],
                    vAt: u => p[1] + (u - p[0]) * (q[1] - p[1]) / Math.max(1e-9, q[0] - p[0]) };
            })).sort((a, b) => a.from - b.from);
        const frontLengthM = spans.reduce((sum, span) => sum + span.length, 0);
        if (!spans.length) return noCoreFits({ frontLengthM });
        const byFrontage = Math.max(1, Math.floor(frontLengthM / (core.widthM + 2 * rules.minApartmentWidthM)));
        if (cores > byFrontage) {
            cores = byFrontage;
            warn(warnings, 'cores-limited-by-frontage', 'notice', `The street facade takes ${cores} core(s); apartments run larger than ${rules.maxApartmentM2} m².`);
        }
        const coreOuter = (uc, vFront) => rect(t, uc - core.widthM / 2, uc + core.widthM / 2, vFront, vFront + core.depthM);
        const fits = feature => {
            const clip = intersectOrNull(t, inner, feature);
            return clip && polygonsArea(clip) >= 0.995 * polygonsArea(feature);
        };
        const placed = [];
        for (let k = 0; k < cores; k++) {
            // The ideal position along the concatenated facades, mapped back to one facade's run.
            const target = frontLengthM * (k + 0.5) / cores;
            let offset = 0, home = spans[spans.length - 1], local = home.length / 2;
            for (const span of spans) {
                if (target <= offset + span.length) { home = span; local = target - offset; break; }
                offset += span.length;
            }
            const minU = placed.length ? placed[placed.length - 1].uc + core.widthM + 1.0 : -Infinity; // a metre of wall between cores
            let found = null;
            for (const span of [home, ...spans.filter(span => span !== home)]) {
                const lo = span.from + core.widthM / 2, hi = span.to - core.widthM / 2;
                if (hi < lo - 1e-9 || hi < minU - 1e-9) continue;
                const centre = Math.min(hi, Math.max(lo, minU, span === home ? span.from + local : lo));
                const candidates = [centre];
                for (let step = 0.5; step <= (hi - lo) + 1e-9; step += 0.5) candidates.push(centre + step, centre - step);
                for (const u of candidates) {
                    if (u < lo - 1e-9 || u > hi + 1e-9 || u < minU - 1e-9) continue;
                    const vFront = span.vAt(u) + rules.exteriorWallM;
                    if (fits(coreOuter(u, vFront))) { found = { k, uc: u, vFront, edgeIndex: span.index }; break; }
                }
                if (found) break;
            }
            if (!found) return noCoreFits({ segment: k, frontLengthM });
            placed.push(found);
        }
        // Each core's segment runs to the midpoints between it and its neighbours; the outer ones
        // take the building's ends, bump-outs included.
        placed.forEach((block, i) => {
            block.s0 = i === 0 ? footprintUmin : (placed[i - 1].uc + block.uc) / 2;
            block.s1 = i === placed.length - 1 ? footprintUmax : (block.uc + placed[i + 1].uc) / 2;
        });

        // --- the cores: walls, voids, stairs, lift, entrance -------------------------------------
        const coreWalls = [], coreOpenings = [], coreCuts = [], entranceOpenings = [], entranceCuts = [];
        const voids = [], landings = [], stairs = [], coreRailings = [], blocks = [], coreRects = [];
        for (const { k, uc, vFront, edgeIndex, s0, s1 } of placed) {
            // The core's front is the facade's inner face; y runs into the building.
            const built = coreParts(t, rules, core, storeyHeightM, lift, uc, (x, y) => [x, vFront + y], (x0, x1, y0, y1) => rect(t, x0, x1, vFront + y0, vFront + y1));
            coreWalls.push(...built.walls); coreOpenings.push(...built.openings); coreCuts.push(...built.cuts);
            voids.push(...built.voids); landings.push(...built.landings); stairs.push(...built.stairs); coreRailings.push(...built.railings);
            coreRects.push(built.rect);
            const { x0, x1 } = built, y0 = vFront + built.y0, y2 = vFront + built.y2;
            // The building entrance: a glazed door through this segment's facade into the hall, ground floor only.
            const doorV = vFront - rules.exteriorWallM / 2;
            const entrance = { kind: 'glazedDoor', a: [uc - rules.entranceDoorM / 2, doorV], b: [uc + rules.entranceDoorM / 2, doorV],
                depthM: rules.exteriorWallM, sillM: 0, heightM: Math.min(rules.entranceHeightM, storeyHeightM - rules.slabThicknessM - 0.3), room: 'entrance' };
            entranceOpenings.push(entrance);
            entranceCuts.push(strip(t, entrance.a, entrance.b, rules.exteriorWallM + 0.06));
            blocks.push({ k, uc, s0, s1, x0, x1, edgeIndex, backY: y2 + rules.coreWallM, hallY0: vFront, hallY1: y0 });
        }
        // Dilatation walls split the building into one segment per core.
        const dilatations = placed.slice(1).map(({ s0 }) => intersectOrNull(t, inner, rect(t, s0 - rules.dilatationWallM / 2, s0 + rules.dilatationWallM / 2, vmin - 1, vmax + 1))).filter(Boolean);

        // --- apartments ---------------------------------------------------------------------------
        let remaining = inner;
        for (const block of blocks) remaining = differenceOrNull(t, remaining, rect(t, block.x0 - rules.coreWallM, block.x1 + rules.coreWallM, block.hallY0, block.backY));
        for (const wall of dilatations) remaining = differenceOrNull(t, remaining, wall);
        const apartments = [], dividerWalls = [], apartmentDoors = [], apartmentDoorCuts = [];
        for (const block of blocks) {
            const divider = intersectOrNull(t, inner, rect(t, block.uc - rules.apartmentWallM / 2, block.uc + rules.apartmentWallM / 2, block.backY, vmax + 1));
            const segment = rect(t, block.s0, block.s1, vmin - 1, vmax + 1);
            const inSegment = intersectOrNull(t, remaining, segment);
            const left = intersectOrNull(t, inSegment, rect(t, block.s0, block.uc - rules.apartmentWallM / 2, vmin - 1, vmax + 1));
            const right = intersectOrNull(t, inSegment, rect(t, block.uc + rules.apartmentWallM / 2, block.s1, vmin - 1, vmax + 1));
            const areaL = left ? polygonsArea(left) : 0, areaR = right ? polygonsArea(right) : 0;
            const besideCore = side => { const clip = intersectOrNull(t, side, rect(t, block.s0, block.s1, block.hallY0, block.backY)); return clip ? uExtent(clip) : 0; };
            const wideEnough = side => { const w = besideCore(side); return w === 0 || w >= rules.minApartmentWidthM; };
            const two = left && right && areaL >= rules.minApartmentM2 && areaR >= rules.minApartmentM2 && wideEnough(left) && wideEnough(right);
            if (two) {
                if (divider) { dividerWalls.push(divider); remaining = differenceOrNull(t, remaining, divider); }
                apartments.push({ block, side: 'left', polygon: left, areaM2: areaL }, { block, side: 'right', polygon: right, areaM2: areaR });
            } else if (inSegment && polygonsArea(inSegment) >= rules.minApartmentM2) {
                apartments.push({ block, side: 'whole', polygon: inSegment, areaM2: polygonsArea(inSegment) });
                warn(warnings, 'single-apartment-per-core', 'notice', 'Too narrow for two apartments beside the core; one apartment per floor.');
            } else {
                warn(warnings, 'no-room-for-apartments', 'error',
                    `Only ${Math.round(inSegment ? polygonsArea(inSegment) : 0)} m² remain beside the core; no apartment of ${rules.minApartmentM2} m² fits.`);
                return fail();
            }
            // Apartment entrance doors open from the hall into each apartment beside the core.
            for (const apartment of apartments.filter(apartment => apartment.block === block)) {
                const onLeft = apartment.side !== 'right';
                const wallX = onLeft ? block.x0 - rules.coreWallM / 2 : block.x1 + rules.coreWallM / 2;
                const y0 = block.hallY0 + 0.35, y1 = y0 + rules.apartmentDoorM;
                if (y1 > block.hallY1 - 0.05) continue;
                const door = { kind: 'door', a: [wallX, y0], b: [wallX, y1], depthM: rules.coreWallM, sillM: 0, heightM: rules.doorHeightM,
                    hinge: [wallX, y1], openTip: [wallX + (onLeft ? -rules.apartmentDoorM : rules.apartmentDoorM), y1], room: 'apartment' };
                apartmentDoors.push(door);
                apartmentDoorCuts.push(strip(t, door.a, door.b, rules.coreWallM + 0.06));
            }
        }
        const depthM = footprintVmax - blocks[0].hallY0;
        if (depthM > rules.deepFloorPlateM) warn(warnings, 'deep-floor-plate', 'notice', `The floor plate is ${Math.round(depthM)} m deep; rooms in the middle get little daylight.`);
        for (const apartment of apartments) {
            const block = apartment.block, right = apartment.side === 'right';
            apartment.unitId = `core-${block.k + 1}-${apartment.side}`;
            apartment.env = {
                side: apartment.side,
                coreSideU: right ? block.x1 + rules.coreWallM : block.x0 - rules.coreWallM,
                dividerU: right ? block.uc + rules.apartmentWallM / 2 : block.uc - rules.apartmentWallM / 2,
                farU: right ? block.s1 : block.s0,
                vFront: block.hallY0, backY: block.backY, vb: footprintVmax - rules.exteriorWallM, doorNearU: block.uc
            };
        }
        return finish({ access: 'point', cores, lift, core, coreWalls, coreOpenings, coreCuts, entranceOpenings, entranceCuts, voids, landings, stairs,
            coreRailings, coreRects, dividerWalls, dilatations, apartments, apartmentDoors, apartmentDoorCuts,
            garageVRange: [blocks[0].hallY0, footprintVmax - rules.exteriorWallM] });

        // The furnished storeys and the floor-plan contract, the same for either access.
        function finish(parts) {
            const { cores, lift, core, coreWalls, coreOpenings, coreCuts, entranceOpenings, entranceCuts, voids, landings, stairs,
                coreRailings, coreRects, dividerWalls, dilatations, apartments, apartmentDoors, apartmentDoorCuts } = parts;
            const corridor = parts.access === 'corridor' ? parts.corridor : null;
            summary.lift = lift;
            summary.coreM = [round2(core.widthM), round2(core.depthM)];
            summary.access = parts.access;
            summary.accessBasis = decision.basis;
            summary.plateDepthM = decision.plateDepthM;
            if (decision.fallback) summary.accessFallback = decision.fallback;
            summary.flaggedFlats = apartments.filter(apartment => apartment.flag).length;
            function accessReason() {
                const mode = parts.access === 'corridor' ? 'Corridor access' : 'Point access';
                if (decision.fallback) return `Point access: a corridor does not fit this floor plate (${decision.fallback}).`;
                if (decision.basis === 'view') return `${mode}, as chosen in the view.`;
                if (decision.basis === 'design') return `${mode}, as the design states.`;
                return `${mode}: the floor plate is ${decision.plateDepthM} m deep inside its walls (${parts.access === 'corridor' ? 'at least' : 'under'} ${rules.corridorFromDepthM} m).`;
            }

            // --- ground-floor use and the garage ------------------------------------------------------
            const groundFloorUse = rules.groundFloorUse === 'auto'
                ? buildingUse().autoGroundFloorUse(input.typology, floors) : rules.groundFloorUse;
            summary.groundFloorUse = groundFloorUse;
            const garageLevels = rules.garage === 'never' ? 0 : rules.garage === 'always' ? Math.max(1, rules.garageLevels)
                : (floors >= rules.garageFromFloors && usableM2 >= rules.garageFromUsableM2 ? Math.max(1, rules.garageLevels) : 0);
            let garage = null;
            if (garageLevels && rooms) {
                const endEdge = edgesUV.find(edge => !edge.party && Math.abs(edge.inward[0]) > Math.cos(35 * Math.PI / 180));
                const farEnd = endEdge ? { u: endEdge.inward[0] > 0 ? footprintUmin + rules.exteriorWallM : footprintUmax - rules.exteriorWallM, dir: endEdge.inward[0] > 0 ? -1 : 1 } : null;
                if (farEnd) {
                    garage = rooms.garageLayout({ t, inner, cores: coreRects, uRange: [footprintUmin + rules.exteriorWallM, footprintUmax - rules.exteriorWallM],
                        vRange: parts.garageVRange, storeyHeightM, farEnd });
                    garage.notices.forEach(code => warn(warnings, code, 'notice', code === 'garage-ramp-steep' ? `The garage ramp is steeper than 15 % (${garage.ramp?.slope ?? '?'} %).` : 'No room for a garage ramp inside the building; the garage level has no ramp.'));
                } else {
                    garage = { columns: [], ramp: null, notices: [] };
                }
            }
            summary.garageLevels = garage ? garageLevels : 0;

            // --- furnish each apartment on the typical floor and on the ground floor ------------------
            const wallHeightM = storeyHeightM - rules.slabThicknessM;
            function furnish(isGround) {
                const result = { partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [], units: [], rooms: 0 };
                if (!rooms) return result;
                for (const apartment of apartments) {
                    let polygon = apartment.polygon;
                    if (isGround && garage && garage.ramp) polygon = differenceOrNull(t, polygon, garage.ramp.polygon) || polygon;
                    const env = {
                        ...apartment.env, t, facades, wallM: rules.exteriorWallM, wallHeightM, isGround, balconies: rules.balconies,
                        bayWidthM: finite(rules.facadeBayWidthM) ? rules.facadeBayWidthM : null
                    };
                    // Point-access apartments are furnished front to back; corridor flats from the corridor out.
                    const furnished = isGround && groundFloorUse === 'commercial' ? rooms.furnishShop(polygon, env)
                        : apartment.env.layout ? rooms.furnishCorridorFlat(polygon, env) : rooms.furnishApartment(polygon, env);
                    result.partitions.push(...furnished.partitions);
                    result.openings.push(...furnished.openings);
                    result.cuts.push(...furnished.cuts);
                    result.balconySlabs.push(...furnished.balconySlabs);
                    result.railings.push(...furnished.railings);
                    result.rooms += furnished.rooms.length;
                    result.units.push({ apartment, kind: isGround && groundFloorUse === 'commercial' ? 'shop' : 'apartment',
                        rooms: furnished.rooms.map(room => ({ kind: room.kind, areaM2: room.areaM2 })) });
                }
                return result;
            }
            const typical = furnish(false);
            const ground = furnish(true);
            if (!rooms) warn(warnings, 'rooms-unavailable', 'notice', 'Room layouts are unavailable; apartments stay undivided.');

            // --- assemble the layouts -----------------------------------------------------------------
            const uv = ([u, v]) => [round6(Math.min(1, Math.max(0, (u - umin) / W))), round6(Math.min(1, Math.max(0, (v - vmin) / H)))];
            const polygonData = feature => polygonsOf(feature)
                .filter(rings => Math.abs(ringArea(rings[0])) >= 0.01)
                .map(rings => rings.filter((ring, index) => index === 0 || Math.abs(ringArea(ring)) >= 0.01)
                    .map(ring => cleanRing(ring, 0.004).map(uv)).filter(ring => ring.length >= 3));
            const polygonsData = features => features.flatMap(polygonData);
            const openingData = o => ({ kind: o.kind, a: uv(o.a), b: uv(o.b), depthM: o.depthM, sillM: o.sillM, heightM: Math.min(o.heightM, wallHeightM - o.sillM),
                ...(o.hinge ? { hinge: uv(o.hinge), openTip: uv(o.openTip) } : {}), ...(o.room ? { room: o.room } : {}) });
            const stairData = stairs.map(s => ({ ...s, a: uv(s.a), b: uv(s.b) }));
            const railData = list => list.map(r => ({ ...r, a: uv(r.a), b: uv(r.b) }));
            const structural = [exteriorWalls, ...coreWalls, ...dilatations];
            const wallsOf = (extraWalls, cuts) => differenceOrNull(t, unionAll(t, [...structural, ...extraWalls]), unionAll(t, cuts));
            const typicalWalls = wallsOf([...dividerWalls, ...typical.partitions], [...coreCuts, ...apartmentDoorCuts, ...typical.cuts]);
            const groundWalls = wallsOf([...dividerWalls, ...ground.partitions], [...coreCuts, ...apartmentDoorCuts, ...ground.cuts, ...entranceCuts]);
            const slabTypical = differenceOrNull(t, fp, unionAll(t, voids));
            const slabGround = garage && garage.ramp ? differenceOrNull(t, fp, garage.ramp.polygon) : fp;
            const parameters = {
                storeyHeightM, floors, cores, lift, highRise, frontBasis, region: rules.region, groundFloorUse, garageLevels: summary.garageLevels,
                access: parts.access, accessBasis: decision.basis, plateDepthM: decision.plateDepthM, ...(decision.fallback ? { accessFallback: decision.fallback } : {}),
                ...(corridor ? { corridor: { lengthM: corridor.lengthM, widthM: corridor.widthM, stairs: corridor.stairs, deadEndM: corridor.deadEndM,
                    maxStairGapM: corridor.maxStairGapM, coreSide: corridor.coreSide, mix: corridor.mix } } : {}),
                rules: { maxRiserM: rules.maxRiserM, minTreadM: rules.minTreadM, flightWidthM: rules.flightWidthM, landingDepthM: rules.landingDepthM,
                    liftShaftOuterM: rules.liftShaftOuterM, exteriorWallM: rules.exteriorWallM, coreWallM: rules.coreWallM,
                    maxApartmentM2: rules.maxApartmentM2, minApartmentM2: rules.minApartmentM2, blindFacadeSetbackM: rules.blindFacadeSetbackM, balconies: rules.balconies }
            };
            const architecture = (walls, slabs, openingList, railings, extra = {}) => ({
                schema: ARCHITECTURE_SCHEMA,
                dimensionsM: [Math.round(W * 1e4) / 1e4, Math.round(H * 1e4) / 1e4],
                wallHeightM: Math.round(wallHeightM * 1000) / 1000,
                slabThicknessM: rules.slabThicknessM,
                walls: polygonData(walls),
                slabs: polygonsData(slabs),
                landings: polygonsData(landings),
                openings: openingList.map(openingData),
                stairs: stairData,
                railings: railData(railings),
                ...extra,
                inference: { wallFootprints: 'generated default', openings: 'generated default', verticalDimensions: 'estimated', glazingTypes: 'assumed',
                    stairRise: `${core.stair.risers} risers of ${Math.round(core.stair.riserM * 1000)} mm, treads ${Math.round(rules.minTreadM * 1000)} mm` },
                quality: { floorAreaM2: round2(polygonsArea(fp)), usableAreaM2: round2(usableM2), cores, lift, highRise }
            });
            const source = { kind: 'generated', generator: GENERATOR_ID, parameters };
            const buildingId = typeof input.buildingId === 'string' && input.buildingId ? input.buildingId : 'building';
            const layouts = [{ id: `${buildingId}:default-ground`, source,
                architecture: architecture(groundWalls, [slabGround, ...ground.balconySlabs], [...coreOpenings, ...apartmentDoors, ...ground.openings, ...entranceOpenings],
                    [...coreRailings, ...ground.railings, ...(garage && garage.ramp ? garage.ramp.railings : [])]) }];
            if (floors > 1) layouts.push({ id: `${buildingId}:default-typical`, source,
                architecture: architecture(typicalWalls, [slabTypical, ...typical.balconySlabs], [...coreOpenings, ...apartmentDoors, ...typical.openings], [...coreRailings, ...typical.railings]) });
            if (garage) {
                const garageWalls = differenceOrNull(t, unionAll(t, [...structural, ...garage.columns]), unionAll(t, coreCuts));
                layouts.push({ id: `${buildingId}:default-garage`, source,
                    architecture: architecture(garageWalls, [fp], coreOpenings, [...coreRailings, ...(garage.ramp ? garage.ramp.railings : [])],
                        garage.ramp ? { platforms: garage.ramp.platforms.map(p => ({ rings: polygonData(p.polygon)[0], elevationM: Math.round(p.elevationM * 1000) / 1000 })).filter(p => p.rings) } : {}) });
            }
            // A corridor flat also says its type (studio … three-bed) and, when it has one, its flag.
            const unitList = (furnished, level) => furnished.units.map(unit => ({
                id: `${unit.apartment.unitId}-${level}`, areaM2: Math.round(unit.apartment.areaM2 * 10) / 10, kind: unit.kind, rooms: unit.rooms,
                ...(unit.kind === 'apartment' && unit.apartment.type ? { type: unit.apartment.type } : {}),
                ...(unit.kind === 'apartment' && unit.apartment.flag ? { flag: unit.apartment.flag } : {})
            }));
            const storeyList = [];
            for (let level = 0 - summary.garageLevels; level < floors; level++) {
                const isGarage = level < 0, isGround = level === 0;
                const layout = isGarage ? layouts[layouts.length - 1] : layouts[isGround ? 0 : Math.min(1, layouts.length - 1)];
                const units = isGarage ? [] : unitList(isGround ? ground : typical, level);
                storeyList.push({
                    id: `${buildingId}:default-storey-${level}`, level, elevationM: Math.round(level * storeyHeightM * 1000) / 1000,
                    elevationBasis: 'estimated', layoutId: layout.id,
                    units: isGarage ? [{ id: `garage-${level}`, kind: 'garage', areaM2: round2(usableM2) }] : units
                });
            }
            // Corners keep a tenth of a millimetre: a sixth decimal of a degree is already a decimetre.
            const corners = [[umin, vmin], [umax, vmin], [umax, vmax], [umin, vmax]].map(p => frame.toDegrees(fromUV(p)).map(value => Math.round(value * 1e9) / 1e9));
            const floorPlans = {
                schema: PLANS_SCHEMA,
                suggested: true,
                generator: { id: GENERATOR_ID, parameters, warnings: warnings.slice() },
                registration: {
                    corners,
                    basis: 'Generated default layout on the oriented bounding rectangle of the proposed footprint (plus a balcony margin); the u axis follows the entrance facade.',
                    accuracy: 'generated', frontBasis, frontEdge: summary.frontEdge
                },
                layouts,
                storeys: storeyList,
                notes: [
                    corridor
                        ? `A suggested default layout, not part of the proposal: a double-loaded corridor ${corridor.lengthM} m long with ${cores} stair core(s) and ${apartments.length} flats per storey (${Object.entries(corridor.mix).map(([type, n]) => `${n} ${type}`).join(', ')}).`
                        : 'A suggested default layout, not part of the proposal: a point-access core entered from the long side with two apartments per core.',
                    accessReason(),
                    corridor ? `Egress: the corridor's dead end runs ${corridor.deadEndM} m to a stair (at most ${rules.maxDeadEndM} m)${cores > 1 ? `, stairs stand at most ${corridor.maxStairGapM} m apart (at most ${rules.maxStairSpacingM} m)` : ''}.` : null,
                    summary.flaggedFlats ? `${summary.flaggedFlats} flat(s) per storey face only north (single aspect), shown in red.` : null,
                    `Stair: ${core.stair.risers} risers of ${Math.round(core.stair.riserM * 1000)} mm with ${Math.round(rules.minTreadM * 1000)} mm treads and ${Math.round(rules.flightWidthM * 100)} cm flights (${rules.regulationBasis}).`,
                    lift ? `Lift shaft ${rules.liftShaftOuterM[0]} × ${rules.liftShaftOuterM[1]} m for a ${Math.round(rules.liftCabinM[0] * 100)} × ${Math.round(rules.liftCabinM[1] * 100)} cm cabin.` : 'No lift: an open stairwell, below the storey and apartment thresholds for one.',
                    highRise ? `High-rise above ${rules.highRiseAboveM} m: protected stair with a fire lobby and a firefighting lift assumed.` : null,
                    'Rooms, windows and balconies are placed by rule; party walls and facades within the boundary setback stay blind.',
                    groundFloorUse === 'commercial' ? 'Ground floor shown as shops with storefront glazing.' : null,
                    summary.garageLevels ? `${summary.garageLevels} garage level(s) with a ramp inside the building.` : null
                ].filter(Boolean)
            };
            const validate = typeof options.validate === 'function' ? options.validate
                : (global.__buildingFloorPlans && global.__buildingFloorPlans.validateFloorPlans);
            if (validate) {
                const errors = validate(floorPlans);
                if (errors.length) throw new Error(`default-floor-plans produced an invalid model: ${errors.join('; ')}`);
            }
            summary.cores = cores;
            summary.heightM = floors * storeyHeightM;
            summary.apartmentsPerFloor = typical.units.filter(unit => unit.kind === 'apartment').length;
            summary.apartmentAreasM2 = typical.units.filter(unit => unit.kind === 'apartment').map(unit => Math.round(unit.apartment.areaM2 * 10) / 10);
            summary.rooms = typical.rooms;
            summary.shopsOnGround = ground.units.filter(unit => unit.kind === 'shop').length;
            // The flats' outlines on the ground (WGS84), for flags and checks, and the corridor's spine and stairs.
            const toLngLat = p => frame.toDegrees(fromUV(p)).map(value => Math.round(value * 1e9) / 1e9);
            summary.flats = apartments.map(apartment => ({ id: apartment.unitId, type: apartment.type || null, areaM2: round2(apartment.areaM2),
                flag: apartment.flag || null, rings: polygonsOf(apartment.polygon).map(rings => rings[0].map(toLngLat)) }));
            if (corridor) summary.corridor = { ...corridor, spine: corridor.spine.map(toLngLat), stairCentres: corridor.stairCentres.map(toLngLat) };
            return { floorPlans, warnings, summary };
        }
    }

    const api = { GENERATOR_ID, DEFAULT_RULES, COMMON_RULES, REGULATION_PRESETS, CORRIDOR_MIX, rulesFor, planDefaultFloorPlans, stairRun, coreDimensions, wantsLift,
        decideAccess, fillRows, describe,
        // The clip helpers, exported so their failure reporting is tested directly.
        _clip: { unionAll, differenceOrNull, intersectOrNull } };
    global.__defaultFloorPlans = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
