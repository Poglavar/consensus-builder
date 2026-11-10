// Central-core suggested floor plans: office buildings, towers and buildings of stepped parts. One
// core stands in the middle of the top floor plate (stairs, a row of lifts, toilets behind the lifts)
// and runs down through every storey; four lifts or more stand in two rows facing each other across a
// lift hall (a split core). Office storeys are open plan round the core, with a reception at the lift
// lobby behind a glass screen; residential storeys are flats off a corridor along the lift face, each
// entered from it and reaching the facade. A storey's plate is the parts of the building that reach it, so the floor
// over a lower part's roof is a terrace. Pure: default-floor-plans.js dispatches here and lends its
// geometry helpers; the output is the shared building-floor-plans.v3 contract. No DOM, no THREE.
(function (global) {
    'use strict';

    const base = () => (global && global.__defaultFloorPlans) || require('./default-floor-plans.js');
    const roomsApi = () => (global && global.__defaultFloorPlanRooms) || require('./default-floor-plan-rooms.js');

    // Design defaults of the central-core scheme (the regulation numbers stay in default-floor-plans.js).
    const CORE_RULES = Object.freeze({
        liftM2: 3500,               // gross floor area one passenger lift serves
        maxLifts: 8,
        splitCoreFromLifts: 4,      // from four lifts they stand in two rows across a lift hall
        liftHallM: 3.0,             // between two rows of lifts
        liftLobbyM: 2.4,            // in front of a single row of lifts
        receptionScreenM: 0.12,     // the glass screen round a reception
        receptionDoorM: 1.8,
        corridorM: 1.8,             // the residential corridor along the lift face
        wcWidthM: 2.4,              // toilets beside the stair when the core has no lift
        minLeaseDepthM: 3.0,        // floor kept between the core (and its lobby) and every facade
        twoStairsAboveM2: 900,      // a floor plate this large has two stairs below the high-rise limit too
        officeBayM: 1.5, officeWindowM: 1.2,
        residentialBayM: 3.0, residentialWindowM: 1.6,
        targetFlatM2: 70,
        entranceHallM: 2.4,         // the residential ground floor's hall from the street door to the lobby
        towerFromFloors: 10,        // a compact building this tall is a tower ...
        towerMaxAspect: 1.5         // ... when its plate is no more than this long for its width
    });

    // Does this building take the central-core scheme? Stepped parts, or mostly office storeys, or a
    // compact tower unless its Access (the design's or the view's) is point cores or a corridor.
    function wantsCentralCore(input, rules) {
        if (Array.isArray(input.plates) && input.plates.length > 1) return true;
        const uses = Array.isArray(input.storeyUses) ? input.storeyUses : [];
        if (uses.length && uses.filter(use => use === 'office').length * 2 >= uses.length) return true;
        if (rules.access === 'point' || rules.access === 'corridor') return false;
        if (!(Number.isInteger(input.floors) && input.floors >= (rules.towerFromFloors || CORE_RULES.towerFromFloors))) return false;
        const g = base()._geometry;
        const polygons = g.polygonsOf(input.footprint);
        if (polygons.length !== 1) return false;
        const ring = polygons[0][0];
        const anchor = ring[0];
        const frame = g.makeFrame(anchor[0], anchor[1]);
        const box = orientedBox(g.cleanRing(ring.map(frame.toMeters), 0.02));
        return !!box && box.long / Math.max(1e-6, box.short) <= (rules.towerMaxAspect || CORE_RULES.towerMaxAspect);
    }

    // The smallest bounding rectangle aligned with one of the ring's edges: u along its long side,
    // v its left normal (a proper rotation, so ring orientation survives).
    function orientedBox(ring) {
        let best = null;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
            if (!(l > 1e-6)) continue;
            const d = [dx / l, dy / l], n = [-d[1], d[0]];
            const us = ring.map(p => p[0] * d[0] + p[1] * d[1]), vs = ring.map(p => p[0] * n[0] + p[1] * n[1]);
            const w = Math.max(...us) - Math.min(...us), h = Math.max(...vs) - Math.min(...vs);
            if (!best || w * h < best.area) best = { d, n, w, h, area: w * h };
        }
        if (!best) return null;
        const u = best.h > best.w ? best.n : best.d;
        return { u, v: [-u[1], u[0]], long: Math.max(best.w, best.h), short: Math.min(best.w, best.h) };
    }

    /**
     * @param input as planDefaultFloorPlans, plus
     *   plates      [{ footprint, floors }] the building's stepped parts (each reaches `floors` storeys);
     *               absent: one plate, the footprint
     *   storeyUses  ['office' | 'shop' | 'residential'] per storey, ground floor first
     */
    function planCoreFloorPlans(input, options = {}) {
        const B = base(), g = B._geometry;
        const t = g.T(options);
        if (!t) throw new Error('default-floor-plan-core: turf is not available');
        const rooms = roomsApi();
        const rules = { ...CORE_RULES, ...B.rulesFor(options), ...((options && options.rules) || {}) };
        const warnings = [];
        const summary = { scheme: 'core', cores: 0, apartmentsPerFloor: 0, apartmentAreasM2: [], lift: false, highRise: false, coreM: null,
            frontBasis: null, frontEdge: null, region: rules.region, groundFloorUse: null, garageLevels: 0, rooms: 0, flats: [], access: 'core' };
        const fail = () => ({ floorPlans: null, warnings, summary });

        // --- storeys and plates -------------------------------------------------------------------
        const floors = Number.isInteger(input.floors) ? input.floors : null;
        if (!floors || floors < 1) { g.warn(warnings, 'floors-unknown', 'error', 'The number of storeys is unknown.'); return fail(); }
        if (floors > rules.maxFloors) { g.warn(warnings, 'too-many-floors', 'error', `More than ${rules.maxFloors} storeys are not modelled.`); return fail(); }
        const storeyHeightM = g.finite(input.storeyHeightM) && input.storeyHeightM > 0 ? input.storeyHeightM : 3.0;
        if (storeyHeightM < 2.5 || storeyHeightM > 6) {
            g.warn(warnings, 'storey-height-implausible', 'error', `A storey height of ${storeyHeightM.toFixed(2)} m is outside 2.5–6 m.`);
            return fail();
        }
        const topFloorM = (floors - 1) * storeyHeightM;
        const highRise = topFloorM > rules.highRiseAboveM;
        summary.highRise = highRise;
        const plateInputs = (Array.isArray(input.plates) && input.plates.length ? input.plates : [{ footprint: input.footprint, floors }])
            .map(plate => ({ footprint: plate.footprint, floors: Math.min(floors, Number.isInteger(plate.floors) && plate.floors > 0 ? plate.floors : floors) }))
            .filter(plate => g.polygonsOf(plate.footprint).length);
        if (!plateInputs.length) { g.warn(warnings, 'invalid-footprint', 'error', 'The footprint is not a polygon.'); return fail(); }
        const uses = Array.from({ length: floors }, (_, level) => {
            const use = Array.isArray(input.storeyUses) ? input.storeyUses[level] : null;
            return use === 'office' || use === 'shop' ? use : 'residential';
        });

        // --- the frame: metres about the footprint, u along the top plate's long side ---------------
        const allRings = plateInputs.flatMap(plate => g.polygonsOf(plate.footprint).map(rings => rings[0]));
        const anchorRing = allRings[0];
        const anchor = anchorRing.reduce((s, p) => [s[0] + p[0] / anchorRing.length, s[1] + p[1] / anchorRing.length], [0, 0]);
        const frame = g.makeFrame(anchor[0], anchor[1]);
        // Each storey's plate: the parts that reach it. Plates are keyed by the parts they hold.
        const plateKeyAt = level => plateInputs.map((plate, index) => (plate.floors > level ? index : -1)).filter(index => index >= 0).join(',');
        const plateLngLat = new Map();
        const plateOf = key => {
            if (!plateLngLat.has(key)) {
                const parts = key.split(',').map(Number).map(index => plateInputs[index].footprint);
                plateLngLat.set(key, parts.length === 1 ? asFeature(t, parts[0]) : closeSeams(t, g, g.unionAll(t, parts.map(part => asFeature(t, part)))));
            }
            return plateLngLat.get(key);
        };
        const topKey = plateKeyAt(floors - 1);
        const topLL = plateOf(topKey);
        const topRing = largestRing(g, topLL);
        const box = topRing ? orientedBox(g.cleanRing(topRing.map(frame.toMeters), 0.02)) : null;
        if (!box) { g.warn(warnings, 'invalid-footprint', 'error', 'The footprint is too small or degenerate.'); return fail(); }
        const toUV = p => { const m = frame.toMeters(p); return [m[0] * box.u[0] + m[1] * box.u[1], m[0] * box.v[0] + m[1] * box.v[1]]; };
        const fromUV = ([a, b]) => frame.toDegrees([a * box.u[0] + b * box.v[0], a * box.u[1] + b * box.v[1]]);
        const uvFrame = { toMeters: toUV, toDegrees: fromUV };
        const toUVFeature = feature => mapFeature(t, g, feature, toUV);
        // The floor inside the exterior walls; the offset is geodesic, so the wall is true metres.
        const insetUV = (featureLL, metres) => {
            let inset = null;
            try { inset = t.buffer(featureLL, -metres, { units: 'meters' }); } catch (_) { inset = null; }
            return inset && g.polygonsOf(inset).length ? toUVFeature(inset) : null;
        };
        const groundKey = plateKeyAt(0);
        const groundUV = toUVFeature(plateOf(groundKey));
        const groundInner = insetUV(plateOf(groundKey), rules.exteriorWallM);
        const topInner = insetUV(topLL, rules.exteriorWallM);
        if (!groundUV || !topInner) { g.warn(warnings, 'too-small-for-walls', 'error', 'Too small to hold exterior walls.'); return fail(); }
        const gfaM2 = Array.from({ length: floors }, (_, level) => g.polygonsArea(toUVFeature(plateOf(plateKeyAt(level))))).reduce((a, b) => a + b, 0);

        // --- the core: stairs, lifts and toilets, placed in the top plate ----------------------------
        const stairCore = B.coreDimensions(storeyHeightM, rules, false, false);
        const sw = stairCore.widthM, sd = stairCore.depthM, cw = rules.coreWallM;
        const [shaftW, shaftD] = rules.liftShaftOuterM;
        const minLifts = highRise ? 2 : (rules.liftPolicy === 'never' ? 0 : (rules.liftPolicy === 'always' || floors >= rules.liftFromFloors ? 1 : 0));
        const wantedLifts = Math.min(rules.maxLifts, Math.max(minLifts, Math.ceil(gfaM2 / rules.liftM2) * (minLifts > 0 ? 1 : 0)));
        const stairs = highRise || g.polygonsArea(groundUV) > rules.twoStairsAboveM2 ? 2 : 1;
        const anyWork = uses.some(use => use !== 'residential');
        // Most lifts first; a split core before a single one; a deep core, then a long one with its
        // toilets, then without them.
        const attempts = [];
        const shapes = [{ orientation: 'deep', toilets: true }, { orientation: 'long', toilets: true }, { orientation: 'long', toilets: false }];
        if (wantedLifts >= rules.splitCoreFromLifts && stairs === 2) shapes.forEach(shape => attempts.push({ split: true, lifts: wantedLifts + (wantedLifts % 2), ...shape }));
        for (let lifts = Math.min(wantedLifts, rules.splitCoreFromLifts - 1); lifts >= minLifts; lifts--) shapes.forEach(shape => attempts.push({ split: false, lifts, ...shape }));
        const leaseInner = insetUV(topLL, rules.exteriorWallM + rules.minLeaseDepthM);
        const centroid = leaseInner ? centreOf(t, leaseInner) : centreOf(t, topInner);
        let core = null;
        for (const attempt of attempts) {
            core = placeCore({ t, g, rules, attempt, stairs, sw, sd, cw, shaftW, shaftD, leaseInner, centroid });
            if (core) break;
        }
        summary.coreM = core ? [g.round2(core.widthM), g.round2(core.depthM)] : null;
        if (highRise) g.warn(warnings, 'high-rise', 'notice', `The top floor lies ${Math.round(topFloorM)} m up, above ${rules.highRiseAboveM} m: two protected stairs and a firefighting lift are assumed.`);
        if (!core) {
            g.warn(warnings, 'core-does-not-fit', 'error',
                `Too small to fit a central core of ${stairs} stair(s) and ${Math.max(minLifts, 1)} lift(s) with ${rules.minLeaseDepthM} m of floor round it on the top storey.`,
                { stairs, lifts: minLifts });
            return fail();
        }
        if (core.lifts < wantedLifts) g.warn(warnings, 'lifts-limited-by-plate', 'notice', `The top floor plate holds a core of ${core.lifts} lift(s); the building's floor area asks for ${wantedLifts}.`);
        summary.cores = 1;
        summary.lift = core.lifts > 0;

        // --- facades, the front and the entrance ---------------------------------------------------
        const neighboursUV = (input.neighbours || []).map(n => toUVFeature(asFeature(t, n))).filter(Boolean);
        const facadesOf = plateUV => {
            const edges = [];
            g.polygonsOf(plateUV).forEach(rings => rings.forEach((ring, ringIndex) => {
                let points = g.cleanRing(ring, 0.02);
                const ccw = g.ringArea(points) > 0;
                if ((ringIndex === 0) !== ccw) points = points.slice().reverse(); // solid on the left of every edge
                points.forEach((a, i) => {
                    const b = points[(i + 1) % points.length];
                    const lengthM = g.len(g.vec(a, b));
                    if (!(lengthM > 0.05)) return;
                    const d = g.unit(g.vec(a, b)), inward = g.leftNormal(d);
                    edges.push({ a, b, d, inward, lengthM, partyRuns: g.partyRunsOf(t, a, b, d, inward, lengthM, neighboursUV), blind: false, isFront: false });
                });
            }));
            for (const edge of edges) edge.party = edge.partyRuns.reduce((sum, run) => sum + run[1] - run[0], 0) >= edge.lengthM / 2;
            for (const hint of input.blindEdges || []) {
                const edge = g.matchEdge(edges, hint, uvFrame);
                if (edge) edge.blind = true;
            }
            return edges;
        };
        const groundFacades = facadesOf(groundUV);
        let front = null, frontBasis = 'longest';
        if (input.front && Array.isArray(input.front.a) && Array.isArray(input.front.b)) {
            const match = g.matchEdge(groundFacades, input.front, uvFrame);
            if (match && !match.party) { front = match; frontBasis = input.front.basis || 'user'; }
        }
        if (!front) {
            const open = groundFacades.filter(edge => !edge.party && !edge.blind);
            const pool = open.length ? open : groundFacades.filter(edge => !edge.party);
            front = pool.reduce((best, edge) => (!best || edge.lengthM > best.lengthM ? edge : best), null);
            if (!input.front) g.warn(warnings, 'front-assumed-longest', 'notice', 'No street data: the entrance faces the longest facade.');
        }
        if (!front) { g.warn(warnings, 'no-exterior-edge', 'error', 'Every edge is a party wall; there is no facade for an entrance.'); return fail(); }
        front.blind = false;
        summary.frontBasis = frontBasis;
        summary.frontEdge = { a: fromUV(front.a), b: fromUV(front.b), lengthM: front.lengthM };
        // The entrance door: on the front facade, as near the core as the facade allows.
        const along = Math.min(front.lengthM - 1.2, Math.max(1.2, (core.centre[0] - front.a[0]) * front.d[0] + (core.centre[1] - front.a[1]) * front.d[1]));
        const doorCentre = g.add(front.a, front.d, along);
        const doorLine = g.add(doorCentre, front.inward, rules.exteriorWallM / 2);
        const entrance = { kind: 'glazedDoor', a: g.add(doorLine, front.d, -rules.entranceDoorM / 2), b: g.add(doorLine, front.d, rules.entranceDoorM / 2),
            depthM: rules.exteriorWallM, sillM: 0, heightM: Math.min(rules.entranceHeightM, storeyHeightM - rules.slabThicknessM - 0.3), room: 'entrance' };
        front.isFront = true;

        // --- the storey layouts ---------------------------------------------------------------------
        const wallHeightM = storeyHeightM - rules.slabThicknessM;
        const allUV = g.polygonsOf(groundUV).flatMap(rings => rings[0]);
        const umin = Math.min(...allUV.map(p => p[0])), umax = Math.max(...allUV.map(p => p[0]));
        const vmin = Math.min(...allUV.map(p => p[1])), vmax = Math.max(...allUV.map(p => p[1]));
        const W = umax - umin, H = vmax - vmin;
        const uv = ([u, v]) => [g.round6(Math.min(1, Math.max(0, (u - umin) / W))), g.round6(Math.min(1, Math.max(0, (v - vmin) / H)))];
        const polygonData = feature => g.polygonsOf(feature)
            .filter(rings => Math.abs(g.ringArea(rings[0])) >= 0.01)
            .map(rings => rings.filter((ring, index) => index === 0 || Math.abs(g.ringArea(ring)) >= 0.01)
                .map(ring => g.cleanRing(ring, 0.004).map(uv)).filter(ring => ring.length >= 3));
        const openingData = o => ({ kind: o.kind, a: uv(o.a), b: uv(o.b), depthM: o.depthM, sillM: o.sillM, heightM: Math.min(o.heightM, wallHeightM - o.sillM),
            ...(o.hinge ? { hinge: uv(o.hinge), openTip: uv(o.openTip) } : {}), ...(o.room ? { room: o.room } : {}) });
        const GENERATOR_ID = B.GENERATOR_ID;
        const parameters = {
            scheme: 'core', storeyHeightM, floors, coreType: core.split ? 'split' : 'single', lifts: core.lifts, stairs, highRise, frontBasis, region: rules.region,
            plates: plateInputs.map(plate => plate.floors), storeyUses: uses,
            rules: { maxRiserM: rules.maxRiserM, minTreadM: rules.minTreadM, flightWidthM: rules.flightWidthM, liftShaftOuterM: rules.liftShaftOuterM,
                exteriorWallM: rules.exteriorWallM, coreWallM: rules.coreWallM, liftM2: rules.liftM2, minLeaseDepthM: rules.minLeaseDepthM, corridorM: rules.corridorM }
        };
        const source = { kind: 'generated', generator: GENERATOR_ID, parameters };
        const buildingId = typeof input.buildingId === 'string' && input.buildingId ? input.buildingId : 'building';
        const layouts = [], layoutIds = new Map(), unitsByLayout = new Map();
        const layoutFor = level => {
            const plateKey = plateKeyAt(level), slabKey = level > 0 ? plateKeyAt(level - 1) : plateKey;
            const use = uses[level], ground = level === 0;
            const key = `${plateKey}|${slabKey}|${use}|${ground ? 'g' : 't'}`;
            if (layoutIds.has(key)) return layoutIds.get(key);
            const id = `${buildingId}:core-${layouts.length + 1}`;
            const built = buildLayout({ t, g, rules, rooms, core, use, ground, storeyHeightM, wallHeightM,
                plateUV: toUVFeature(plateOf(plateKey)), innerUV: insetUV(plateOf(plateKey), rules.exteriorWallM),
                slabUV: toUVFeature(plateOf(slabKey)), facades: facadesOf(toUVFeature(plateOf(plateKey))).map(edge => ({ ...edge, isFront: ground && near(g, edge, front) })),
                entrance: ground ? entrance : null, doorCentre, frontInward: front.inward, warnings });
            layouts.push({ id, source, architecture: {
                schema: B.ARCHITECTURE_SCHEMA,
                dimensionsM: [Math.round(W * 1e4) / 1e4, Math.round(H * 1e4) / 1e4],
                wallHeightM: Math.round(wallHeightM * 1000) / 1000,
                slabThicknessM: rules.slabThicknessM,
                walls: polygonData(built.walls),
                slabs: built.slabs.flatMap(polygonData),
                landings: built.landings.flatMap(polygonData),
                openings: built.openings.map(openingData),
                stairs: built.stairs.map(s => ({ ...s, a: uv(s.a), b: uv(s.b) })),
                railings: built.railings.map(r => ({ ...r, a: uv(r.a), b: uv(r.b) })),
                inference: { wallFootprints: 'generated default', openings: 'generated default', verticalDimensions: 'estimated', glazingTypes: 'assumed',
                    stairRise: `${stairCore.stair.risers} risers of ${Math.round(stairCore.stair.riserM * 1000)} mm, treads ${Math.round(rules.minTreadM * 1000)} mm` },
                quality: { floorAreaM2: g.round2(g.polygonsArea(built.plate)), usableAreaM2: g.round2(built.usableM2), cores: 1, lift: core.lifts > 0, highRise }
            } });
            layoutIds.set(key, id);
            unitsByLayout.set(id, built.units);
            return id;
        };
        const storeys = [];
        for (let level = 0; level < floors; level++) {
            const layoutId = layoutFor(level);
            storeys.push({ id: `${buildingId}:core-storey-${level}`, level, elevationM: Math.round(level * storeyHeightM * 1000) / 1000, elevationBasis: 'estimated', layoutId,
                units: unitsByLayout.get(layoutId).map(unit => ({ ...unit, id: `${unit.id}-${level}` })) });
        }

        const officeStoreys = uses.filter(use => use === 'office').length, shopStoreys = uses.filter(use => use === 'shop').length;
        const flatsPerStorey = storeys.map(storey => storey.units.filter(unit => unit.kind === 'apartment').length);
        const corners = [[umin, vmin], [umax, vmin], [umax, vmax], [umin, vmax]].map(p => fromUV(p).map(value => Math.round(value * 1e9) / 1e9));
        const floorPlans = {
            schema: B.PLANS_SCHEMA,
            suggested: true,
            generator: { id: GENERATOR_ID, parameters, warnings: warnings.slice() },
            registration: {
                corners,
                basis: 'Generated default layout on the bounding rectangle of the proposed footprint; the u axis follows the long side of the top floor plate.',
                accuracy: 'generated', frontBasis, frontEdge: summary.frontEdge
            },
            layouts,
            storeys,
            notes: [
                `A suggested default layout, not part of the proposal: a central ${core.split ? 'split core (two rows of lifts across a lift hall)' : 'core'} with ${stairs} stair(s), ${core.lifts} lift(s) and toilets, through all ${floors} storeys.`,
                officeStoreys ? `${officeStoreys} office storey(s): open plan round the core, a reception at the lift lobby.` : null,
                shopStoreys ? `${shopStoreys} shop storey(s), open plan.` : null,
                flatsPerStorey.some(Boolean) ? `Flats off a ${rules.corridorM} m corridor along the lifts: ${Math.min(...flatsPerStorey.filter(Boolean))}–${Math.max(...flatsPerStorey)} per residential storey; rooms are not laid out.` : null,
                plateInputs.length > 1 ? `Stepped parts: each storey's floor plate is the parts that reach it, so the floor over a lower part's roof is a terrace.` : null,
                `Stair: ${stairCore.stair.risers} risers of ${Math.round(stairCore.stair.riserM * 1000)} mm with ${Math.round(rules.minTreadM * 1000)} mm treads and ${Math.round(rules.flightWidthM * 100)} cm flights (${rules.regulationBasis}).`,
                core.lifts ? `Lift shafts ${rules.liftShaftOuterM[0]} × ${rules.liftShaftOuterM[1]} m, one per ${rules.liftM2} m² of floor area.` : 'No lift: below the storey threshold for one.',
                highRise ? `High-rise above ${rules.highRiseAboveM} m: two protected stairs and a firefighting lift assumed.` : null
            ].filter(Boolean)
        };
        const validate = typeof options.validate === 'function' ? options.validate : (global.__buildingFloorPlans && global.__buildingFloorPlans.validateFloorPlans);
        if (validate) {
            const errors = validate(floorPlans);
            if (errors.length) throw new Error(`default-floor-plan-core produced an invalid model: ${errors.join('; ')}`);
        }
        summary.heightM = floors * storeyHeightM;
        summary.apartmentsPerFloor = Math.max(0, ...flatsPerStorey);
        summary.apartmentAreasM2 = (storeys.find(storey => storey.units.some(unit => unit.kind === 'apartment'))?.units || [])
            .filter(unit => unit.kind === 'apartment').map(unit => unit.areaM2);
        summary.officeStoreys = officeStoreys;
        summary.lifts = core.lifts;
        summary.stairs = stairs;
        summary.coreType = core.split ? 'split' : 'single';
        summary.groundFloorUse = uses[0] === 'residential' ? 'residential' : 'commercial';
        return { floorPlans, warnings, summary };
    }

    // ---- helpers --------------------------------------------------------------------------------

    function asFeature(t, value) {
        if (!value) return null;
        if (value.type === 'Feature') return value;
        if (value.type === 'Polygon') return t.polygon(value.coordinates);
        if (value.type === 'MultiPolygon') return t.multiPolygon(value.coordinates);
        return null;
    }
    // Parts drawn side by side rarely share their edges exactly: a hair-thin gap between them would
    // become two exterior walls. Closing by 5 cm joins them and changes nothing else.
    function closeSeams(t, g, feature) {
        try {
            const closed = t.buffer(t.buffer(feature, SEAM_M, { units: 'meters' }), -SEAM_M, { units: 'meters' });
            return closed && g.polygonsOf(closed).length ? closed : feature;
        } catch (_) { return feature; }
    }
    const SEAM_M = 0.05;
    function mapFeature(t, g, feature, map) {
        const polygons = g.polygonsOf(feature).map(rings => rings.map(ring => ring.map(map)));
        if (!polygons.length) return null;
        return polygons.length === 1 ? t.polygon(polygons[0]) : t.multiPolygon(polygons);
    }
    function largestRing(g, feature) {
        return g.polygonsOf(feature).map(rings => rings[0]).reduce((best, ring) => {
            const area = Math.abs(g.ringArea(ring.map(p => [p[0] * 1e5, p[1] * 1e5])));
            return !best || area > best.area ? { ring, area } : best;
        }, null)?.ring || null;
    }
    // The area centroid of the largest part (a vertex mean drifts towards detailed corners).
    function centreOf(t, feature) {
        try { return t.centroid(t.centerOfMass(feature)).geometry.coordinates; } catch (_) { return t.centroid(feature).geometry.coordinates; }
    }
    const near = (g, edge, other) => g.len(g.vec(edge.a, other.a)) < 0.3 && g.len(g.vec(edge.b, other.b)) < 0.3;
    const box = (t, u0, u1, v0, v1) => t.polygon([[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]]);

    /**
     * The core and everything that depends only on it: its outline and its lift lobby (on residential
     * storeys the corridor runs along the same face). Local frame: x along u, y away from the lift face. Single core: [stair | lifts |
     * toilets | stair]; a split core is two halves [stair | lifts | toilets] facing each other across
     * the lift hall, their stairs at opposite ends. A 'deep' core runs its stair flights back from the
     * lift face, with the toilets behind the lifts; a 'long' one runs them along u, so the core is only
     * a stair's width deep (for slab-like plates), with the toilets beside the lifts when they fit.
     */
    function placeCore({ t, g, rules, attempt, stairs, sw, sd, cw, shaftW, shaftD, leaseInner, centroid }) {
        const { split, lifts, orientation, toilets } = attempt;
        const perRow = split ? lifts / 2 : lifts;
        const stairAlongM = orientation === 'long' ? cw + sd : sw;   // a stair's length along u
        const halfDepthM = orientation === 'long' ? sw : cw + sd;     // a half's depth from its lift face
        const liftsM = perRow * shaftW;
        const toiletM = orientation === 'long' ? (toilets ? rules.wcWidthM : 0) : (perRow > 0 ? 0 : rules.wcWidthM);
        const widthM = (split ? 1 : stairs) * stairAlongM + liftsM + toiletM;
        const depthM = split ? 2 * halfDepthM + rules.liftHallM : halfDepthM;
        const lobbyM = split ? 0 : rules.liftLobbyM;
        // What must fit with lease depth round it: the core and its lift lobby.
        const needs = (uc, vc) => box(t, uc - widthM / 2, uc + widthM / 2, vc - depthM / 2 - lobbyM, vc + depthM / 2);
        if (!leaseInner) return null;
        const fits = feature => {
            const clip = g.intersectOrNull(t, leaseInner, feature);
            return clip && g.polygonsArea(clip) >= 0.995 * g.polygonsArea(feature);
        };
        const candidates = [[0, 0]];
        for (let r = 0.5; r <= 8 + 1e-9; r += 0.5) for (const [du, dv] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) candidates.push([du, dv]);
        let found = null;
        for (const [du, dv] of candidates) {
            const uc = centroid[0] + du, vc = centroid[1] + dv;
            if (fits(needs(uc, vc))) { found = [uc, vc]; break; }
        }
        if (!found) return null;
        const [uc, vc] = found;
        // A single core's lift face looks towards lower v, where its lobby is.
        const front = vc - depthM / 2;
        const outline = box(t, uc - widthM / 2, uc + widthM / 2, vc - depthM / 2, vc + depthM / 2);
        return { split, lifts, perRow, orientation, toilets: toiletM > 0 || (orientation === 'deep' && perRow > 0 && halfDepthM - shaftD > 1.6),
            widthM, depthM, halfDepthM, stairAlongM, liftsM, toiletM, centre: [uc, vc], front, outline,
            lobby: split ? box(t, uc - widthM / 2, uc + widthM / 2, vc - rules.liftHallM / 2, vc + rules.liftHallM / 2)
                : box(t, uc - widthM / 2, uc + widthM / 2, front - lobbyM, front),
            stairs, sw, sd, cw, shaftW, shaftD };
    }

    // The core's own walls, stairs and doors for one storey (toilet doors only where people work).
    function coreElements({ t, g, rules, core, storeyHeightM, work }) {
        const B = base();
        const out = { walls: [], openings: [], cuts: [], voids: [], landings: [], stairs: [], railings: [], wcRooms: [] };
        const stairCore = B.coreDimensions(storeyHeightM, rules, false, false);
        const { cw, sw, shaftW, shaftD } = core;
        const [uc, vc] = core.centre;
        const strip = B._geometry.strip;
        const doorOn = (pt, x, y, widthM, room, swingY) => {
            const door = { kind: 'door', a: pt(x - widthM / 2, y), b: pt(x + widthM / 2, y), depthM: cw, sillM: 0, heightM: rules.doorHeightM,
                hinge: pt(x + widthM / 2, y), openTip: pt(x + widthM / 2, y + swingY), room };
            out.openings.push(door);
            out.cuts.push(strip(t, door.a, door.b, cw + 0.06));
        };
        // A half: local x ∈ [-w/2, w/2] along u (mirrored for the far half), y ≥ 0 away from its lift face.
        const half = (faceV, dir, mirror, withSecondStair) => {
            const pt = (x, y) => [uc + (mirror ? -x : x), faceV + dir * y];
            const bx = (x0, x1, y0, y1) => {
                const a = pt(x0, y0), b = pt(x1, y1);
                return box(t, Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]));
            };
            const keep = built => { out.walls.push(...built.walls); out.voids.push(...built.voids); out.landings.push(...built.landings); out.stairs.push(...built.stairs); out.railings.push(...built.railings); };
            // A stair whose landing is entered from the lift face; `towards` +1 runs its flights to +x.
            const stairAt = (x0, towards) => {
                if (core.orientation === 'long') {
                    // Flights along x: the stair's own y is our x, its x our y (0 … sw).
                    const xAt = py => (towards > 0 ? x0 + cw + py : x0 + core.stairAlongM - cw - py);
                    const map = (px, py) => pt(xAt(py), px);
                    keep(B._geometry.coreParts(t, rules, stairCore, storeyHeightM, false, sw / 2, map, (a0, a1, b0, b1) => {
                        const p = map(a0, b0), q = map(a1, b1);
                        return box(t, Math.min(p[0], q[0]), Math.max(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[1], q[1]));
                    }));
                    // Its end wall behind the landing, and the door from the lift face onto the landing.
                    out.walls.push(towards > 0 ? bx(x0, x0 + cw, 0, sw) : bx(x0 + core.stairAlongM - cw, x0 + core.stairAlongM, 0, sw));
                    doorOn(pt, xAt(stairCore.landingM / 2), cw / 2, 1.0, 'stair', -1.0);
                } else {
                    keep(B._geometry.coreParts(t, rules, stairCore, storeyHeightM, false, x0 + sw / 2, (px, py) => pt(px, py + cw), (a0, a1, b0, b1) => bx(a0, a1, b0 + cw, b1 + cw)));
                    out.walls.push(bx(x0, x0 + sw, 0, cw));
                    doorOn(pt, x0 + sw / 2, cw / 2, 1.0, 'stair', -1.0);
                }
            };
            let x = -core.widthM / 2;
            stairAt(x, 1); x += core.stairAlongM;
            const lifts0 = x;
            for (let k = 0; k < core.perRow; k++) {
                const s0 = lifts0 + k * shaftW, s1 = s0 + shaftW;
                const shaft = g.differenceOrNull(t, bx(s0, s1, 0, shaftD), bx(s0 + cw, s1 - cw, cw, shaftD - cw));
                if (shaft) out.walls.push(shaft);
                out.voids.push(bx(s0 + cw, s1 - cw, cw, shaftD - cw));
                const door = { kind: 'slidingDoor', a: pt((s0 + s1) / 2 - rules.liftDoorM / 2, cw / 2), b: pt((s0 + s1) / 2 + rules.liftDoorM / 2, cw / 2),
                    depthM: cw, sillM: 0, heightM: rules.doorHeightM, room: 'lift' };
                out.openings.push(door);
                out.cuts.push(strip(t, door.a, door.b, cw + 0.06));
            }
            x += core.liftsM;
            // Behind the lifts of a long core is only a riser's depth: solid.
            if (core.orientation === 'long' && core.perRow > 0 && core.halfDepthM - shaftD > 0.05) out.walls.push(bx(lifts0, x, shaftD, core.halfDepthM));
            // Toilets: behind the lifts of a deep core, beside them in a long one (or with no lifts).
            const toiletBlock = core.orientation === 'deep' && core.perRow > 0 ? [lifts0, x, shaftD] : core.toiletM > 0 ? [x, x + core.toiletM, 0] : null;
            if (toiletBlock && core.halfDepthM - toiletBlock[2] > 1.6) {
                const [m0, m1, y0] = toiletBlock, y1 = core.halfDepthM;
                if (y0 === 0) out.walls.push(bx(m0, m1, 0, cw));
                out.walls.push(bx(m0, m1, y1 - cw, y1));
                if (core.orientation === 'long') out.walls.push(bx(m1 - cw, m1, 0, y1));
                const rooms = m1 - m0 >= 3.6 ? [[m0, (m0 + m1) / 2 - 0.06], [(m0 + m1) / 2 + 0.06, m1]] : [[m0, m1]];
                if (rooms.length === 2) out.walls.push(bx((m0 + m1) / 2 - 0.06, (m0 + m1) / 2 + 0.06, y0, y1 - cw));
                rooms.forEach(([r0, r1]) => {
                    out.wcRooms.push(bx(r0, r1, y0, y1 - cw));
                    if (work) doorOn(pt, (r0 + r1) / 2, y1 - cw / 2, 0.9, 'wc', -0.9);
                });
            }
            x += core.toiletM;
            if (withSecondStair) stairAt(x, -1);
        };
        if (core.split) {
            half(vc - rules.liftHallM / 2, -1, false, false);
            half(vc + rules.liftHallM / 2, 1, true, false);
        } else {
            half(core.front, 1, false, core.stairs === 2);
        }
        return out;
    }

    // Windows by bays along every free stretch of the facades: tall ones where people work.
    function facadeWindows({ t, g, rules, rooms, facades, work, wallHeightM }) {
        const openings = [], cuts = [];
        const bay = work ? rules.officeBayM : (g.finite(rules.facadeBayWidthM) ? rules.facadeBayWidthM : rules.residentialBayM);
        const width = Math.min(bay - 0.3, work ? rules.officeWindowM : rules.residentialWindowM);
        const sillM = work ? 0.3 : 0.9, heightM = work ? Math.max(1.4, wallHeightM - 0.6) : 1.4;
        for (const facade of facades) {
            if (facade.blind || facade.party) continue;
            for (const [s0, s1] of rooms.freeRuns(facade, [0.5, facade.lengthM - 0.5], width + 0.2)) {
                const count = Math.max(1, Math.floor((s1 - s0) / bay));
                for (let k = 0; k < count; k++) {
                    const c = s0 + (s1 - s0) * (k + 0.5) / count;
                    if (facade.isFront && facade.entranceAt !== undefined && Math.abs(c - facade.entranceAt) < rules.entranceDoorM / 2 + width / 2 + 0.2) continue;
                    const line = g.add(facade.a, facade.inward, rules.exteriorWallM / 2);
                    const opening = { kind: 'window', a: g.add(line, facade.d, c - width / 2), b: g.add(line, facade.d, c + width / 2), depthM: rules.exteriorWallM, sillM, heightM };
                    openings.push(opening);
                    cuts.push(g.strip(t, opening.a, opening.b, rules.exteriorWallM + 0.06));
                }
            }
        }
        return { openings, cuts };
    }

    // One storey layout: exterior walls with windows, the core, and the use's own floor.
    function buildLayout(c) {
        const { t, g, rules, rooms, core, use, ground, storeyHeightM, wallHeightM, plateUV, slabUV, facades, entrance, warnings } = c;
        const work = use !== 'residential';
        const innerUV = c.innerUV || plateUV;
        const exteriorWalls = g.differenceOrNull(t, plateUV, innerUV);
        const coreParts = coreElements({ t, g, rules, core, storeyHeightM, work });
        if (entrance) {
            const front = facades.find(f => f.isFront);
            if (front) front.entranceAt = (g.midpoint(entrance.a, entrance.b)[0] - front.a[0]) * front.d[0] + (g.midpoint(entrance.a, entrance.b)[1] - front.a[1]) * front.d[1];
        }
        const windows = facadeWindows({ t, g, rules, rooms, facades, work, wallHeightM });
        const walls = [exteriorWalls, ...coreParts.walls];
        const openings = [...coreParts.openings, ...windows.openings];
        const cuts = [...coreParts.cuts, ...windows.cuts];
        const railings = [...coreParts.railings];
        const units = [];
        let usableM2 = g.polygonsArea(innerUV) - g.polygonsArea(core.outline);
        if (entrance) { openings.push(entrance); cuts.push(g.strip(t, entrance.a, entrance.b, rules.exteriorWallM + 0.06)); }

        if (work) {
            // The reception: a glass screen round the lift lobby (across the lift hall's mouths in a
            // split core), each side with a glazed door into the open floor.
            const screen = rules.receptionScreenM;
            const [l0, lv0, l1, lv1] = bboxOf(g, core.lobby);
            const sides = core.split
                ? [[[l0, lv0], [l0, lv1]], [[l1, lv0], [l1, lv1]]]
                : [[[l0, lv0], [l1, lv0]], [[l0, lv0], [l0, lv1]], [[l1, lv0], [l1, lv1]]];
            sides.forEach(([a, b], index) => {
                walls.push(g.strip(t, a, b, screen));
                const lengthM = g.len(g.vec(a, b)), d = g.unit(g.vec(a, b));
                const doorAt = index === 0 || core.split ? lengthM / 2 : null;
                if (doorAt !== null && lengthM > rules.receptionDoorM + 0.6) {
                    const door = { kind: 'glazedDoor', a: g.add(a, d, doorAt - rules.receptionDoorM / 2), b: g.add(a, d, doorAt + rules.receptionDoorM / 2),
                        depthM: screen, sillM: 0, heightM: Math.min(2.4, wallHeightM - 0.2), room: 'reception' };
                    openings.push(door); cuts.push(g.strip(t, door.a, door.b, screen + 0.06));
                }
                // The rest of the screen is glass.
                const glassRuns = doorAt !== null && lengthM > rules.receptionDoorM + 0.6
                    ? [[0.15, doorAt - rules.receptionDoorM / 2 - 0.15], [doorAt + rules.receptionDoorM / 2 + 0.15, lengthM - 0.15]] : [[0.15, lengthM - 0.15]];
                for (const [s0, s1] of glassRuns) {
                    if (s1 - s0 < 0.6) continue;
                    const pane = { kind: 'window', a: g.add(a, d, s0), b: g.add(a, d, s1), depthM: screen, sillM: 0.1, heightM: wallHeightM - 0.3, room: 'reception' };
                    openings.push(pane); cuts.push(g.strip(t, pane.a, pane.b, screen + 0.06));
                }
            });
            units.push({ id: use === 'shop' ? 'shop' : 'office', kind: use === 'shop' ? 'shop' : 'office', areaM2: Math.round(usableM2 * 10) / 10,
                rooms: [{ kind: 'reception', areaM2: g.round2(g.polygonsArea(core.lobby)) }, { kind: use === 'shop' ? 'shop' : 'office', areaM2: Math.round((usableM2 - g.polygonsArea(core.lobby)) * 10) / 10 },
                    ...coreParts.wcRooms.map(room => ({ kind: 'wc', areaM2: g.round2(g.polygonsArea(room)) }))] });
        } else {
            const flats = residentialFlats({ ...c, innerUV, entrance, warnings });
            walls.push(...flats.walls);
            openings.push(...flats.openings);
            cuts.push(...flats.cuts);
            flats.flats.forEach((flat, index) => units.push({ id: `flat-${index + 1}`, kind: 'apartment', areaM2: Math.round(flat.areaM2 * 10) / 10 }));
            usableM2 = flats.flats.reduce((sum, flat) => sum + flat.areaM2, 0);
        }
        const wallUnion = g.differenceOrNull(t, g.unionAll(t, walls.filter(Boolean)), g.unionAll(t, cuts.filter(Boolean)));
        const slab = g.differenceOrNull(t, slabUV || plateUV, g.unionAll(t, coreParts.voids.filter(Boolean)));
        return { plate: plateUV, walls: wallUnion, slabs: [slab].filter(Boolean), landings: coreParts.landings.filter(Boolean), openings, stairs: coreParts.stairs, railings, units, usableM2 };
    }

    function bboxOf(g, feature) {
        let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
        for (const rings of g.polygonsOf(feature)) for (const p of rings[0]) { u0 = Math.min(u0, p[0]); v0 = Math.min(v0, p[1]); u1 = Math.max(u1, p[0]); v1 = Math.max(v1, p[1]); }
        return [u0, v0, u1, v1];
    }

    /**
     * Flats off a straight corridor: the corridor runs along the lift face from gable to gable (in a
     * split core, the lift hall carried on to the gables), and the floor on each side of it is cut
     * across into flats of about the target size, each entered from the corridor and reaching the
     * facade. On a side the core stands on, the flats at its two ends wrap round behind it, each to
     * the core's middle. On the ground floor a hall runs from the street door to the corridor.
     */
    function residentialFlats({ t, g, rules, core, innerUV, entrance, doorCentre }) {
        const out = { walls: [], openings: [], cuts: [], flats: [] };
        const wallM = rules.apartmentWallM, doorM = rules.apartmentDoorM;
        const [c0, cv0, c1, cv1] = bboxOf(g, core.outline);
        const [iu0, iv0, iu1, iv1] = bboxOf(g, innerUV);
        const band = core.split ? [core.centre[1] - rules.liftHallM / 2, core.centre[1] + rules.liftHallM / 2] : [core.front - rules.corridorM, core.front];
        const across = (v0, v1) => box(t, iu0 - 1, iu1 + 1, v0, v1);
        // The corridor's two walls, where the core does not already stand.
        for (const wall of [across(band[0] - wallM, band[0]), across(band[1], band[1] + wallM)]) {
            const piece = g.differenceOrNull(t, g.intersectOrNull(t, wall, innerUV), core.outline);
            if (piece) out.walls.push(piece);
        }
        const sides = [
            { sign: -1, face: band[0] - wallM, region: g.intersectOrNull(t, innerUV, across(iv0 - 1, band[0] - wallM)), core: core.split || cv0 < band[0] },
            { sign: 1, face: band[1] + wallM, region: g.intersectOrNull(t, innerUV, across(band[1] + wallM, iv1 + 1)), core: true }
        ].map(side => ({ ...side, region: side.region && g.differenceOrNull(t, side.region, core.outline) }));
        // The ground floor's hall from the street door to the corridor, walled on both sides.
        if (entrance) {
            const target = [Math.min(iu1 - 1, Math.max(iu0 + 1, doorCentre[0])), Math.min(band[1], Math.max(band[0], doorCentre[1]))];
            if (g.len(g.vec(doorCentre, target)) > 0.5) {
                const hall = g.strip(t, doorCentre, target, rules.entranceHallM), walled = g.strip(t, doorCentre, target, rules.entranceHallM + 2 * wallM);
                for (const side of sides) {
                    if (!side.region) continue;
                    const walls = g.differenceOrNull(t, g.intersectOrNull(t, walled, side.region), hall);
                    if (walls && g.polygonsArea(walls) > 0.05) out.walls.push(walls);
                    side.region = g.differenceOrNull(t, side.region, walled);
                }
                // The hall opens into the corridor through its wall.
                const d = g.unit(g.vec(doorCentre, target));
                out.cuts.push(g.strip(t, g.add(target, d, -1.0), g.add(target, d, 0.3), rules.entranceHallM));
            }
        }
        const areaOf = polygon => (polygon ? g.polygonsArea(polygon) : 0);
        const slice = (region, u0, u1) => g.intersectOrNull(t, region, box(t, u0, u1, iv0 - 1, iv1 + 1));
        // A run of the side cut across into flats of about the target size, in order of u.
        const cutAcross = (region, u0, u1) => {
            if (!region || areaOf(region) < 1) return [];
            const n = Math.max(1, Math.round(areaOf(region) / rules.targetFlatM2));
            return Array.from({ length: n }, (_, k) => ({ u0: u0 + (u1 - u0) * k / n, u1: u0 + (u1 - u0) * (k + 1) / n }))
                .map(span => ({ ...span, polygon: slice(region, span.u0, span.u1) }));
        };
        for (const side of sides) {
            if (!side.region || areaOf(side.region) < rules.minApartmentM2) continue;
            let flats;
            if (side.core) {
                // Each end of the core: flats across, the one beside the core taking half the floor behind it.
                const uc = (c0 + c1) / 2;
                const left = cutAcross(slice(side.region, iu0 - 1, c0), iu0 - 1, c0);
                const right = cutAcross(slice(side.region, c1, iu1 + 1), c1, iu1 + 1);
                const behindL = slice(side.region, c0, uc - wallM / 2), behindR = slice(side.region, uc + wallM / 2, c1);
                if (left.length) { const last = left[left.length - 1]; last.polygon = g.unionAll(t, [last.polygon, behindL].filter(Boolean)); last.u1 = uc; }
                if (right.length) { right[0].polygon = g.unionAll(t, [behindR, right[0].polygon].filter(Boolean)); right[0].u0 = uc; }
                const between = g.intersectOrNull(t, box(t, uc - wallM / 2, uc + wallM / 2, iv0 - 1, iv1 + 1), side.region);
                if (between && left.length && right.length) out.walls.push(between);
                flats = [...left, ...right];
            } else {
                flats = cutAcross(side.region, iu0 - 1, iu1 + 1);
            }
            // A flat too small to live in, or one that does not reach the corridor, joins its neighbour.
            const reachesCorridor = flat => {
                const contact = g.intersectOrNull(t, flat.polygon, across(side.face - (side.sign < 0 ? 0.1 : 0), side.face + (side.sign > 0 ? 0.1 : 0)));
                if (!contact || areaOf(contact) < 0.01) return null;
                const [a0, , a1] = bboxOf(g, contact);
                return a1 - a0 >= doorM + 0.4 ? [a0, a1] : null;
            };
            flats = flats.filter(flat => flat.polygon && areaOf(flat.polygon) > 0.5);
            for (let i = 0; i < flats.length && flats.length > 1; i++) {
                if (areaOf(flats[i].polygon) >= rules.minApartmentM2 && reachesCorridor(flats[i])) continue;
                const j = i === flats.length - 1 ? i - 1 : i + 1;
                flats[j] = { u0: Math.min(flats[i].u0, flats[j].u0), u1: Math.max(flats[i].u1, flats[j].u1), polygon: g.unionAll(t, [flats[i].polygon, flats[j].polygon]) };
                flats.splice(i, 1);
                i = -1;
            }
            // Party walls between neighbouring flats, then each flat's door from the corridor.
            flats.slice(1).forEach((flat, k) => {
                if (Math.abs(flat.u0 - flats[k].u1) > 0.01 || (side.core && flat.u0 > c0 && flat.u0 < c1)) return;
                const wall = g.intersectOrNull(t, box(t, flat.u0 - wallM / 2, flat.u0 + wallM / 2, iv0 - 1, iv1 + 1), side.region);
                if (wall) out.walls.push(wall);
            });
            for (const flat of flats) {
                const areaM2 = areaOf(flat.polygon);
                if (areaM2 < rules.minApartmentM2) continue;
                out.flats.push({ polygon: flat.polygon, areaM2 });
                const span = reachesCorridor(flat);
                if (!span) continue;
                const mid = (span[0] + span[1]) / 2, v = side.face - side.sign * wallM / 2;
                const a = [mid - doorM / 2, v], b = [mid + doorM / 2, v];
                const door = { kind: 'door', a, b, depthM: wallM, sillM: 0, heightM: rules.doorHeightM, hinge: b, openTip: [b[0], v + side.sign * doorM], room: 'apartment' };
                out.openings.push(door);
                out.cuts.push(g.strip(t, door.a, door.b, wallM + 0.06));
            }
        }
        return out;
    }

    const api = { CORE_RULES, wantsCentralCore, planCoreFloorPlans, orientedBox, closeSeams };
    global.__defaultFloorPlanCore = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
