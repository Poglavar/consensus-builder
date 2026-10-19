// Suggested default floor plans for proposed buildings: a point-access core (stair wrapped around a
// lift, or an open stairwell) entered from the building's long side, two apartments per core with
// rooms, windows on every free facade and a balcony for the living room, blind party walls and
// boundary walls, one extra core per ~2 × 120 m² of floor, an optional active ground floor and a
// garage level. The output is the SAME `consensus-builder.building-floor-plans.v2` contract that
// evidence-backed reconstructions use (building-floor-plans.js validates it, three-floor-plans.js
// renders it), so a generated layout is just another source adapter. It is flagged `suggested: true`
// and its layout sources are `{ kind: 'generated' }` — a suggestion for X-ray, never part of the
// proposal. Pure: footprint + context in, a floorPlans object or warnings out. turf is the browser
// global, options.turf, or require('@turf/turf') in node; default-floor-plan-rooms.js furnishes
// the interiors. No DOM, no THREE.
(function (global) {
    'use strict';

    const GENERATOR_ID = 'consensus-builder.default-floor-plan.v1';
    const PLANS_SCHEMA = 'consensus-builder.building-floor-plans.v2';
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
    const REGULATION_PRESETS = Object.freeze({
        HR: Object.freeze({ region: 'HR', regulationBasis: 'NN 12/2023 čl. 13, 14, 19, 24; NN 29/2013 čl. 4, 44',
            maxRiserM: 0.15, minTreadM: 0.33, flightWidthM: 1.10, landingDepthM: 1.50, apartmentDoorM: 1.10, liftDoorM: 0.90,
            liftCabinM: [1.10, 1.40], highRiseAboveM: 22 }),
        generic: Object.freeze({ region: 'generic', regulationBasis: 'generic practice (no local regulation configured)',
            maxRiserM: 0.17, minTreadM: 0.29, flightWidthM: 1.20, landingDepthM: 1.50, apartmentDoorM: 1.00, liftDoorM: 0.90,
            liftCabinM: [1.10, 1.40], highRiseAboveM: 22 })
    });
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
        minFootprintM2: 4
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
            try { const merged = t.union(acc, feature); if (merged && merged.geometry) acc = merged; } catch (_) { }
        }
        return acc;
    }
    function differenceOrNull(t, a, b) {
        if (!a || !a.geometry) return null;
        if (!b || !b.geometry) return a;
        try { return t.difference(a, b); } catch (_) { return null; }
    }
    function intersectOrNull(t, a, b) {
        if (!a || !a.geometry || !b || !b.geometry) return null;
        try { return t.intersect(a, b); } catch (_) { return null; }
    }
    function uExtent(feature) {
        let lo = Infinity, hi = -Infinity;
        for (const rings of polygonsOf(feature)) for (const p of rings[0]) { lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
        return hi - lo;
    }
    const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

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

    function wantsLift(rules, floors, cores, highRise = false) {
        if (highRise) return true;
        if (rules.liftPolicy === 'always') return true;
        if (rules.liftPolicy === 'never') return false;
        return floors >= rules.liftFromFloors || floors * 2 * cores >= rules.liftFromApartments;
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
        if (result.floorPlans) return `${result.summary.cores} core(s), ${result.summary.apartmentsPerFloor} apartments per floor`;
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
            const probe = t.point(add(midpoint(a, b), inward, -0.35)); // just outside this edge
            const party = neighboursM.some(polygon => { try { return t.booleanPointInPolygon(probe, polygon); } catch (_) { return false; } });
            return { index, a, b, d, inward, lengthM: len(vec(a, b)), party, blind: false, sun: sunSign * inward[1] };
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
        const footprintUmin = Math.min(...us), footprintUmax = Math.max(...us), footprintVmax = Math.max(...vs);

        // --- how many cores, and their size ------------------------------------------------------
        const usableM2 = polygonsArea(inner);
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
        const spans = edgesUV.filter(edge => !edge.party && !edge.blind && edge.inward[1] > Math.cos(30 * Math.PI / 180) && edge.lengthM >= core.widthM)
            .map(edge => {
                const [p, q] = edge.a[0] <= edge.b[0] ? [edge.a, edge.b] : [edge.b, edge.a];
                return { index: edge.index, from: p[0], to: q[0], length: q[0] - p[0],
                    vAt: u => p[1] + (u - p[0]) * (q[1] - p[1]) / Math.max(1e-9, q[0] - p[0]) };
            }).sort((a, b) => a.from - b.from);
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
        const exteriorWalls = differenceOrNull(t, fp, inner);
        const coreWalls = [], coreOpenings = [], coreCuts = [], entranceOpenings = [], entranceCuts = [];
        const voids = [], landings = [], stairs = [], coreRailings = [], blocks = [], coreRects = [];
        for (const { k, uc, vFront, edgeIndex, s0, s1 } of placed) {
            const x0 = uc - core.innerWidthM / 2, x1 = uc + core.innerWidthM / 2; // inner faces of the side walls
            const y0 = vFront + core.landingM;                                     // start of the flight zone
            const y1 = y0 + core.flightZoneM;                                       // start of the half landing
            const y2 = y1 + rules.halfLandingDepthM;                                // inner face of the rear wall
            coreWalls.push(rect(t, x0 - rules.coreWallM, x0, vFront, y2 + rules.coreWallM));
            coreWalls.push(rect(t, x1, x1 + rules.coreWallM, vFront, y2 + rules.coreWallM));
            coreWalls.push(rect(t, x0, x1, y2, y2 + rules.coreWallM));
            coreRects.push(rect(t, x0 - rules.coreWallM, x1 + rules.coreWallM, vFront, y2 + rules.coreWallM));
            // Flights rise away from the entrance on the left and return towards it on the right.
            const run = core.stair.runM;
            const leftX = x0 + rules.flightWidthM / 2, rightX = x1 - rules.flightWidthM / 2;
            const half = core.stair.flights[0] * core.stair.riserM;
            stairs.push({ a: [leftX, y0], b: [leftX, y0 + run], widthM: rules.flightWidthM, steps: core.stair.flights[0], fromM: 0, toM: half });
            if (core.stair.flights[1] > 0) {
                const run2 = (core.stair.flights[1] - 1) * rules.minTreadM;
                stairs.push({ a: [rightX, y1], b: [rightX, Math.max(y0 + 0.05, y1 - run2)], widthM: rules.flightWidthM,
                    steps: core.stair.flights[1], fromM: half, toM: storeyHeightM });
            }
            landings.push(rect(t, x0, x1, y1, y2));
            voids.push(rect(t, x0, x1, y0, y2));
            if (lift) {
                const [shaftW, shaftD] = rules.liftShaftOuterM;
                const sx0 = uc - shaftW / 2, sx1 = uc + shaftW / 2, sy0 = y0, sy1 = y0 + shaftD;
                const shaft = differenceOrNull(t, rect(t, sx0, sx1, sy0, sy1),
                    rect(t, sx0 + rules.coreWallM, sx1 - rules.coreWallM, sy0 + rules.coreWallM, sy1 - rules.coreWallM));
                if (shaft) coreWalls.push(shaft);
                const doorY = sy0 + rules.coreWallM / 2;
                const liftDoor = { kind: 'slidingDoor', a: [uc - rules.liftDoorM / 2, doorY], b: [uc + rules.liftDoorM / 2, doorY],
                    depthM: rules.coreWallM, sillM: 0, heightM: rules.doorHeightM, room: 'lift' };
                coreOpenings.push(liftDoor);
                coreCuts.push(strip(t, liftDoor.a, liftDoor.b, rules.coreWallM + 0.06));
            } else {
                // An open well needs a balustrade on the edges of both flights and across the landing side.
                coreRailings.push({ a: [x0 + rules.flightWidthM, y0], b: [x0 + rules.flightWidthM, y1], heightM: 1.0 });
                coreRailings.push({ a: [x1 - rules.flightWidthM, y0], b: [x1 - rules.flightWidthM, y1], heightM: 1.0 });
                coreRailings.push({ a: [x0 + rules.flightWidthM, y0], b: [x1 - rules.flightWidthM, y0], heightM: 1.0 });
            }
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

        // --- ground-floor use and the garage ------------------------------------------------------
        const groundFloorUse = rules.groundFloorUse === 'auto'
            ? ((input.typology === 'block' && floors >= 5) ? 'commercial' : 'residential') : rules.groundFloorUse;
        summary.groundFloorUse = groundFloorUse;
        const garageLevels = rules.garage === 'never' ? 0 : rules.garage === 'always' ? Math.max(1, rules.garageLevels)
            : (floors >= rules.garageFromFloors && usableM2 >= rules.garageFromUsableM2 ? Math.max(1, rules.garageLevels) : 0);
        let garage = null;
        if (garageLevels && rooms) {
            const endEdge = edgesUV.find(edge => !edge.party && Math.abs(edge.inward[0]) > Math.cos(35 * Math.PI / 180));
            const farEnd = endEdge ? { u: endEdge.inward[0] > 0 ? footprintUmin + rules.exteriorWallM : footprintUmax - rules.exteriorWallM, dir: endEdge.inward[0] > 0 ? -1 : 1 } : null;
            if (farEnd) {
                garage = rooms.garageLayout({ t, inner, cores: coreRects, uRange: [footprintUmin + rules.exteriorWallM, footprintUmax - rules.exteriorWallM],
                    vRange: [blocks[0].hallY0, footprintVmax - rules.exteriorWallM], storeyHeightM, farEnd });
                garage.notices.forEach(code => warn(warnings, code, 'notice', code === 'garage-ramp-steep' ? `The garage ramp is steeper than 15 % (${garage.ramp?.slope ?? '?'} %).` : 'No room for a garage ramp inside the building; the garage level has no ramp.'));
            } else {
                garage = { columns: [], ramp: null, notices: [] };
            }
        }
        summary.garageLevels = garage ? garageLevels : 0;

        // --- furnish each apartment on the typical floor and on the ground floor ------------------
        const facades = edgesUV.map(edge => ({ index: edge.index, a: edge.a, b: edge.b, d: edge.d, inward: edge.inward, lengthM: edge.lengthM,
            party: edge.party, blind: edge.blind, isFront: edge.isFront, sun: edge.sun }));
        const wallHeightM = storeyHeightM - rules.slabThicknessM;
        function furnish(isGround) {
            const result = { partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [], units: [], rooms: 0 };
            if (!rooms) return result;
            for (const apartment of apartments) {
                const block = apartment.block;
                let polygon = apartment.polygon;
                if (isGround && garage && garage.ramp) polygon = differenceOrNull(t, polygon, garage.ramp.polygon) || polygon;
                const env = {
                    t, side: apartment.side, facades, wallM: rules.exteriorWallM, wallHeightM, isGround, balconies: rules.balconies,
                    bayWidthM: finite(rules.facadeBayWidthM) ? rules.facadeBayWidthM : null,
                    coreSideU: apartment.side === 'right' ? block.x1 + rules.coreWallM : block.x0 - rules.coreWallM,
                    dividerU: apartment.side === 'right' ? block.uc + rules.apartmentWallM / 2 : block.uc - rules.apartmentWallM / 2,
                    farU: apartment.side === 'right' ? block.s1 : block.s0,
                    vFront: block.hallY0, backY: block.backY, vb: footprintVmax - rules.exteriorWallM, doorNearU: block.uc
                };
                const furnished = isGround && groundFloorUse === 'commercial' ? rooms.furnishShop(polygon, env) : rooms.furnishApartment(polygon, env);
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
        const unitList = (furnished, level) => furnished.units.map((unit, index) => ({
            id: `core-${unit.apartment.block.k + 1}-${unit.apartment.side}-${level}`, areaM2: Math.round(unit.apartment.areaM2 * 10) / 10, kind: unit.kind, rooms: unit.rooms
        }));
        const floorList = [];
        for (let level = 0 - summary.garageLevels; level < floors; level++) {
            const isGarage = level < 0, isGround = level === 0;
            const layout = isGarage ? layouts[layouts.length - 1] : layouts[isGround ? 0 : Math.min(1, layouts.length - 1)];
            const units = isGarage ? [] : unitList(isGround ? ground : typical, level);
            floorList.push({
                id: `${buildingId}:default-floor-${level}`, level, elevationM: Math.round(level * storeyHeightM * 1000) / 1000,
                elevationBasis: 'estimated', layoutId: layout.id,
                apartments: units.filter(unit => unit.kind === 'apartment').map(({ kind, ...apartment }) => apartment),
                units: isGarage ? [{ id: `garage-${level}`, kind: 'garage', areaM2: round2(usableM2) }] : units.filter(unit => unit.kind !== 'apartment')
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
            floors: floorList,
            notes: [
                'A suggested default layout, not part of the proposal: a point-access core entered from the long side with two apartments per core.',
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
        return { floorPlans, warnings, summary };
    }

    const api = { GENERATOR_ID, DEFAULT_RULES, COMMON_RULES, REGULATION_PRESETS, rulesFor, planDefaultFloorPlans, stairRun, coreDimensions, wantsLift, describe };
    global.__defaultFloorPlans = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
