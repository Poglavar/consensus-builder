// Interiors for the suggested default floor plans: rooms, partitions and doors inside an apartment,
// windows and balconies on its facades, a shop variant for active ground floors, and a garage level
// with columns and a ramp. Everything works in the generator's planar (u, v) metre frame on turf
// features and returns plain geometry; default-floor-plans.js decides where it goes and converts it
// to the shared floor-plan contract. Pure: turf is injected through `env.t`; no DOM, no THREE.
(function (global) {
    'use strict';

    const PARTITION_M = 0.12;      // light partition between rooms
    const HALL_WIDTH_M = 1.25;     // the entrance hall along the core wall
    const BACK_HALL_M = 1.30;      // the hall's turn across the rooms behind the core
    const INTERIOR_DOOR_M = 0.80;
    const INTERIOR_DOOR_HEIGHT_M = 2.05;
    const MIN_ROOM_WIDTH_M = 2.9;  // narrower than this beside the hall holds only wet rooms
    const MIN_WET_WIDTH_M = 2.0;
    const BEDROOM_WIDTH_M = 3.4;
    const LIVING_MIN_WIDTH_M = 4.2;
    const KITCHEN_WIDTH_M = 2.6;
    const BALCONY_DEPTH_M = 1.5;
    const BALCONY_MAX_WIDTH_M = 4.5;
    const WINDOW_SPECS = Object.freeze({
        bedroom: { widthM: 1.4, sillM: 0.9, heightM: 1.4 },
        living: { widthM: 2.4, sillM: 0.9, heightM: 1.4 },
        kitchen: { widthM: 1.2, sillM: 0.9, heightM: 1.4 },
        bathroom: { widthM: 0.6, sillM: 1.6, heightM: 0.6 },
        room: { widthM: 1.4, sillM: 0.9, heightM: 1.4 },
        shop: { widthM: 2.4, sillM: 0.4, heightM: 2.2 },
        storage: null, hall: null, lobby: null
    });

    const rect = (t, u0, u1, v0, v1) => (u1 - u0 > 1e-6 && v1 - v0 > 1e-6)
        ? t.polygon([[[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]]) : null;
    const ordered = (a, b) => (a <= b ? [a, b] : [b, a]);
    const vec = (a, b) => [b[0] - a[0], b[1] - a[1]];
    const add = (p, d, k = 1) => [p[0] + d[0] * k, p[1] + d[1] * k];
    const len = d => Math.hypot(d[0], d[1]);
    const unit = d => { const l = len(d); return [d[0] / l, d[1] / l]; };
    const leftNormal = d => [-d[1], d[0]];
    function strip(t, a, b, width) {
        const n = leftNormal(unit(vec(a, b)));
        return t.polygon([[add(a, n, width / 2), add(b, n, width / 2), add(b, n, -width / 2), add(a, n, -width / 2), add(a, n, width / 2)]]);
    }
    function polygonsOf(feature) {
        const g = feature && feature.type === 'Feature' ? feature.geometry : feature;
        if (!g) return [];
        return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    }
    function ringArea(ring) {
        let twice = 0;
        for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; twice += p[0] * q[1] - q[0] * p[1]; }
        return twice / 2;
    }
    function area(feature) {
        let total = 0;
        for (const rings of polygonsOf(feature)) rings.forEach((ring, index) => { total += (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)); });
        return total;
    }
    function intersect(t, a, b) { if (!a || !b) return null; try { const r = t.intersect(a, b); return r && r.geometry ? r : null; } catch (_) { return null; } }
    function difference(t, a, b) { if (!a) return null; if (!b) return a; try { const r = t.difference(a, b); return r && r.geometry ? r : null; } catch (_) { return null; } }
    function unionAll(t, features) {
        let acc = null;
        for (const f of features) { if (!f) continue; if (!acc) { acc = f; continue; } try { const m = t.union(acc, f); if (m && m.geometry) acc = m; } catch (_) { } }
        return acc;
    }
    function bbox(feature) {
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const rings of polygonsOf(feature)) for (const p of rings[0]) { u0 = Math.min(u0, p[0]); u1 = Math.max(u1, p[0]); v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]); }
        return [u0, v0, u1, v1];
    }

    // Where a room meets a facade: the run of the room's boundary along the wall's inner face,
    // as [t0, t1] along the facade from its first endpoint, or null when the room does not touch it.
    function facadeRun(t, room, facade, wallM) {
        const inner0 = add(facade.a, facade.inward, wallM), inner1 = add(facade.b, facade.inward, wallM);
        const band = strip(t, add(inner0, facade.inward, 0.15), add(inner1, facade.inward, 0.15), 0.3);
        const clip = intersect(t, room, band);
        if (!clip || area(clip) < 0.05) return null;
        let t0 = Infinity, t1 = -Infinity;
        for (const rings of polygonsOf(clip)) for (const p of rings[0]) {
            const along = (p[0] - facade.a[0]) * facade.d[0] + (p[1] - facade.a[1]) * facade.d[1];
            t0 = Math.min(t0, along); t1 = Math.max(t1, along);
        }
        return t1 - t0 > 0.5 ? [t0, t1] : null;
    }

    function openingOn(facade, t0, t1, widthM, spec, wallM, kind = 'window') {
        const centre = (t0 + t1) / 2;
        const half = Math.min(widthM, Math.max(0.5, t1 - t0 - 0.5)) / 2;
        const line = s => add(add(facade.a, facade.d, s), facade.inward, wallM / 2);
        return { kind, a: line(centre - half), b: line(centre + half), depthM: wallM, sillM: spec.sillM, heightM: spec.heightM };
    }

    function doorOn(a, b, depthM, into, widthM = INTERIOR_DOOR_M) {
        // `into` is the unit direction the leaf swings into (the room side of the partition).
        const d = unit(vec(a, b)), mid = add(a, vec(a, b), 0.5);
        const p = add(mid, d, -widthM / 2), q = add(mid, d, widthM / 2);
        return { kind: 'door', a: p, b: q, depthM, sillM: 0, heightM: INTERIOR_DOOR_HEIGHT_M, hinge: q, openTip: add(q, into, widthM) };
    }

    /**
     * Rooms for one apartment.
     * @param apartment turf polygon (u,v) of the apartment, already free of the core and party walls
     * @param env { t, side: 'left'|'right'|'whole', coreSideU, dividerU, farU, vFront, backY, vb,
     *              facades: [{ index, a, b, d, inward, lengthM, party, blind, isFront, sun }],
     *              wallM, wallHeightM, isGround, balconies }
     */
    function furnishApartment(apartment, env) {
        const { t } = env;
        const out = { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] };
        if (!apartment) return out;
        const [au0, , au1] = bbox(apartment);
        const whole = env.side === 'whole';
        // A whole-floor apartment is entered beside the core's left wall and furnished leftwards,
        // with the rooms behind the core spanning the full width.
        const dir = env.side === 'right' ? 1 : -1;
        const coreU = env.coreSideU;
        const farU = whole ? au0 : env.farU;
        const u = (from, width) => ordered(from, from + dir * width); // a u-range starting at `from` and running away from the core
        const cell = (uRange, v0, v1) => intersect(t, apartment, rect(t, uRange[0], uRange[1], v0, v1));
        const partition = (uRange, v0, v1) => { const p = intersect(t, apartment, rect(t, uRange[0], uRange[1], v0, v1)); if (p && area(p) > 0.005) out.partitions.push(p); };
        const room = (kind, polygon) => { if (polygon && area(polygon) >= 1.5) { out.rooms.push({ kind, polygon, areaM2: Math.round(area(polygon) * 10) / 10 }); return true; } return false; };
        const cutFor = (opening) => out.cuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));

        // --- the hall: a column along the core wall, turning across the rooms behind the core -----
        const stripW = Math.abs(farU - coreU);
        const hallW = stripW - HALL_WIDTH_M - PARTITION_M >= MIN_WET_WIDTH_M ? HALL_WIDTH_M : stripW; // too narrow beside the hall: the hall takes the strip
        const hallColumn = u(coreU, hallW);
        const backHallV1 = Math.min(env.backY + BACK_HALL_M, env.vb - 2.5);
        const backU = whole ? ordered(au0, au1) : ordered(env.dividerU, farU);
        const hallPieces = [cell(hallColumn, env.vFront, backHallV1), cell(backU, env.backY, backHallV1)].filter(Boolean);
        const hall = unionAll(t, hallPieces);
        if (!hall) { room('room', apartment); return out; }

        // --- cells beside the hall, between the facade and the core's rear wall -------------------
        const sideW = stripW - hallW - PARTITION_M;
        if (sideW >= MIN_WET_WIDTH_M) {
            const sideU = u(coreU + dir * (hallW + PARTITION_M), sideW);
            const stripDepth = env.backY - env.vFront;
            partition(u(coreU + dir * hallW, PARTITION_M), env.vFront, env.backY); // between hall and side cells
            const cells = [];
            if (sideW >= MIN_ROOM_WIDTH_M && stripDepth >= 5.5) {
                const bedDepth = Math.min(4.8, Math.max(3.6, stripDepth * 0.6));
                cells.push(['bedroom', env.vFront, env.vFront + bedDepth]);
                cells.push(['bathroom', env.vFront + bedDepth + PARTITION_M, env.backY]);
            } else if (stripDepth >= 3.6) {
                cells.push(['bathroom', env.vFront, env.vFront + 2.4]);
                cells.push(['storage', env.vFront + 2.4 + PARTITION_M, env.backY]);
            } else {
                cells.push(['bathroom', env.vFront, env.backY]);
            }
            cells.forEach(([kind, v0, v1], index) => {
                if (v1 - v0 < 1.0) return;
                const polygon = cell(sideU, v0, v1);
                if (!room(kind, polygon)) return;
                if (index > 0) partition(sideU, v0 - PARTITION_M, v0);
                // Door from the hall column through the partition, swinging into the cell.
                const doorA = [coreU + dir * (hallW + PARTITION_M / 2), v0 + 0.1], doorB = [doorA[0], Math.min(v1 - 0.1, v0 + 0.1 + 1.4)];
                if (doorB[1] - doorA[1] >= INTERIOR_DOOR_M + 0.1) {
                    const door = doorOn(doorA, doorB, PARTITION_M, [dir, 0]);
                    out.openings.push({ ...door, room: kind }); cutFor(door);
                }
            });
        }

        // --- rooms behind the core: a row along the back facade, the kitchen next to the hall ------
        // Bedrooms take the facade's bay width when the building has a facade design, so the
        // windows X-ray shows fall into the same rhythm the exterior paints.
        const bedroomW = env.bayWidthM >= 2.8 && env.bayWidthM <= 4.5 ? env.bayWidthM : BEDROOM_WIDTH_M;
        const roomsV0 = backHallV1 + PARTITION_M;
        if (env.vb - roomsV0 >= 2.6) {
            partition(backU, backHallV1, roomsV0); // between the back hall and the rooms
            const Wb = backU[1] - backU[0];
            const columns = []; // [kind, u0, u1] from the core side outward
            const start = whole ? au1 : env.dividerU;
            let cursor = start;
            const push = (kind, width) => { const r = ordered(cursor, cursor + dir * width); columns.push([kind, r[0], r[1]]); cursor += dir * (width + PARTITION_M); };
            if (Wb >= LIVING_MIN_WIDTH_M + KITCHEN_WIDTH_M + PARTITION_M + 1.0) {
                const bedrooms = Math.max(0, Math.floor((Wb - KITCHEN_WIDTH_M - LIVING_MIN_WIDTH_M - PARTITION_M) / (bedroomW + PARTITION_M)));
                const livingW = Wb - KITCHEN_WIDTH_M - PARTITION_M - bedrooms * (bedroomW + PARTITION_M);
                push('kitchen', KITCHEN_WIDTH_M);
                push('living', livingW);
                for (let i = 0; i < bedrooms; i++) push('bedroom', bedroomW);
            } else {
                push('living', Wb);
            }
            columns.forEach(([kind, u0, u1], index) => {
                const polygon = cell([u0, u1], roomsV0, env.vb);
                if (!room(kind, polygon)) return;
                if (index > 0) partition(dir > 0 ? [u0 - PARTITION_M, u0] : [u1, u1 + PARTITION_M], roomsV0, env.vb);
                const doorU0 = Math.max(u0 + 0.15, Math.min(u1 - 0.15 - INTERIOR_DOOR_M - 0.2, (u0 + u1) / 2 - 0.6));
                const door = doorOn([doorU0, roomsV0 - PARTITION_M / 2], [doorU0 + INTERIOR_DOOR_M + 0.2, roomsV0 - PARTITION_M / 2], PARTITION_M, [0, 1]);
                out.openings.push({ ...door, room: kind }); cutFor(door);
            });
        } else {
            room('living', difference(t, cell(backU, env.backY, env.vb), hall));
        }
        out.rooms.push({ kind: 'hall', polygon: hall, areaM2: Math.round(area(hall) * 10) / 10 });

        // --- windows for every room on every free facade, a balcony for the living room ----------
        const facades = env.facades.filter(f => !f.party && !f.blind);
        let balconyDone = false;
        for (const entry of out.rooms) {
            const spec = WINDOW_SPECS[entry.kind];
            if (!spec) continue;
            const runs = facades.map(f => ({ f, run: facadeRun(t, entry.polygon, f, env.wallM) })).filter(x => x.run);
            for (const { f, run } of runs) {
                const [t0, t1] = run;
                const wantsBalcony = env.balconies && !env.isGround && entry.kind === 'living' && !balconyDone && !f.isFront
                    && runs.every(other => other.f === f || (other.f.sun || 0) <= (f.sun || 0));
                if (wantsBalcony && t1 - t0 >= 2.6) {
                    const half = Math.min(BALCONY_MAX_WIDTH_M, t1 - t0 - 0.6) / 2, centre = (t0 + t1) / 2;
                    const door = openingOn(f, centre - 0.7, centre + 0.7, 1.4, { sillM: 0, heightM: Math.min(2.3, env.wallHeightM - 0.3) }, env.wallM, 'glazedDoor');
                    out.openings.push({ ...door, room: entry.kind }); cutFor(door);
                    if (t1 - t0 >= 4.6) {
                        const side = openingOn(f, centre + 0.9, Math.min(t1, centre + 0.9 + 1.6), 1.2, spec, env.wallM);
                        out.openings.push({ ...side, room: entry.kind }); cutFor(side);
                    }
                    const o0 = add(f.a, f.d, centre - half), o1 = add(f.a, f.d, centre + half);
                    const outward = [-f.inward[0], -f.inward[1]];
                    const slab = t.polygon([[o0, o1, add(o1, outward, BALCONY_DEPTH_M), add(o0, outward, BALCONY_DEPTH_M), o0]]);
                    out.balconySlabs.push(slab);
                    const r0 = add(o0, outward, BALCONY_DEPTH_M - 0.05), r1 = add(o1, outward, BALCONY_DEPTH_M - 0.05);
                    out.railings.push({ a: add(o0, outward, 0.05), b: r0, heightM: 1.05 }, { a: r0, b: r1, heightM: 1.05 }, { a: r1, b: add(o1, outward, 0.05), heightM: 1.05 });
                    balconyDone = true;
                    continue;
                }
                const count = entry.kind === 'living' && t1 - t0 >= 6.5 ? 2 : 1;
                for (let i = 0; i < count; i++) {
                    const segment = [t0 + (t1 - t0) * i / count, t0 + (t1 - t0) * (i + 1) / count];
                    const window = openingOn(f, segment[0], segment[1], spec.widthM, spec, env.wallM);
                    out.openings.push({ ...window, room: entry.kind }); cutFor(window);
                }
            }
        }
        return out;
    }

    /** A shop unit on an active ground floor: storefront glazing towards the entrance facade, a stockroom at the back. */
    function furnishShop(apartment, env) {
        const { t } = env;
        const out = { rooms: [], partitions: [], openings: [], cuts: [], balconySlabs: [], railings: [] };
        if (!apartment) return out;
        const [, av0, , av1] = bbox(apartment);
        const storeDepth = av1 - av0 >= 7 ? 3.0 : 0;
        const sales = storeDepth ? intersect(t, apartment, rect(t, -1e4, 1e4, av0, av1 - storeDepth - PARTITION_M)) : apartment;
        const stock = storeDepth ? intersect(t, apartment, rect(t, -1e4, 1e4, av1 - storeDepth, av1)) : null;
        if (storeDepth) { const p = intersect(t, apartment, rect(t, -1e4, 1e4, av1 - storeDepth - PARTITION_M, av1 - storeDepth)); if (p) out.partitions.push(p); }
        if (sales && area(sales) >= 1.5) out.rooms.push({ kind: 'shop', polygon: sales, areaM2: Math.round(area(sales) * 10) / 10 });
        if (stock && area(stock) >= 1.5) out.rooms.push({ kind: 'storage', polygon: stock, areaM2: Math.round(area(stock) * 10) / 10 });
        const cutFor = opening => out.cuts.push(strip(t, opening.a, opening.b, opening.depthM + 0.06));
        for (const f of env.facades.filter(f => !f.party && !f.blind)) {
            const run = sales ? facadeRun(t, sales, f, env.wallM) : null;
            if (!run) continue;
            const [t0, t1] = run;
            if (f.isFront && t1 - t0 >= 2.2) {
                // The shop door sits nearest the building entrance, the glazing fills the rest.
                const doorT = env.doorNearU !== undefined && Math.abs(f.d[0]) > 0.5 && (env.doorNearU - f.a[0]) / f.d[0] > (t0 + t1) / 2 ? t1 - 0.8 : t0 + 0.8;
                const door = openingOn(f, doorT - 0.6, doorT + 0.6, 1.1, { sillM: 0, heightM: Math.min(2.4, env.wallHeightM - 0.3) }, env.wallM, 'glazedDoor');
                out.openings.push({ ...door, room: 'shop' }); cutFor(door);
                const glazing = doorT > (t0 + t1) / 2 ? [t0 + 0.3, doorT - 0.9] : [doorT + 0.9, t1 - 0.3];
                const panes = Math.max(0, Math.floor((glazing[1] - glazing[0] + 0.6) / 3.0));
                for (let i = 0; i < panes; i++) {
                    const seg = [glazing[0] + (glazing[1] - glazing[0]) * i / panes, glazing[0] + (glazing[1] - glazing[0]) * (i + 1) / panes];
                    const window = openingOn(f, seg[0], seg[1], WINDOW_SPECS.shop.widthM, WINDOW_SPECS.shop, env.wallM);
                    out.openings.push({ ...window, room: 'shop' }); cutFor(window);
                }
            } else if (t1 - t0 >= 2.0) {
                const window = openingOn(f, t0, t1, Math.min(WINDOW_SPECS.shop.widthM, t1 - t0 - 0.6), WINDOW_SPECS.shop, env.wallM);
                out.openings.push({ ...window, room: 'shop' }); cutFor(window);
            }
        }
        return out;
    }

    /**
     * A parking level under the building: a column grid over the slab, the cores continued, and a
     * ramp along the building's far end that surfaces through the ground slab.
     * @param env { t, inner, cores: [Feature], uRange: [u0,u1], vRange: [v0,v1], storeyHeightM, farEnd: { u, dir } }
     */
    function garageLayout(env) {
        const { t } = env;
        const out = { columns: [], ramp: null, notices: [] };
        const [u0, u1] = env.uRange, [v0, v1] = env.vRange;
        const blocked = unionAll(t, env.cores);
        // Columns on a grid roughly matching parking bays: three bays and an aisle between lines.
        const du = 7.5, dv = 5.5;
        for (let x = u0 + du / 2; x < u1 - 1; x += du) {
            for (let y = v0 + dv / 2; y < v1 - 1; y += dv) {
                const column = rect(t, x - 0.2, x + 0.2, y - 0.2, y + 0.2);
                if (!column) continue;
                const inside = intersect(t, env.inner, column);
                if (!inside || area(inside) < 0.15) continue;
                if (blocked && intersect(t, blocked, column)) continue;
                out.columns.push(column);
            }
        }
        // The ramp: 3.5 m wide, 15 % slope where the building is long enough, never over 20 %.
        const rampW = 3.5, slope = 0.15, maxSlope = 0.20, needed = env.storeyHeightM / slope;
        const available = v1 - v0 - 1.5;
        if (available < env.storeyHeightM / maxSlope) { out.notices.push('garage-ramp-omitted'); return out; }
        const rampL = Math.min(needed, available);
        const uRamp = env.farEnd.dir > 0 ? [env.farEnd.u - 0.3 - rampW, env.farEnd.u - 0.3] : [env.farEnd.u + 0.3, env.farEnd.u + 0.3 + rampW];
        const vRamp = [v0 + 0.8, v0 + 0.8 + rampL];
        const rampRect = rect(t, uRamp[0], uRamp[1], vRamp[0], vRamp[1]);
        const rampInside = intersect(t, env.inner, rampRect);
        if (!rampInside || area(rampInside) < area(rampRect) * 0.95 || (blocked && intersect(t, blocked, rampRect))) { out.notices.push('garage-ramp-omitted'); return out; }
        if (rampL < needed - 1e-6) out.notices.push('garage-ramp-steep');
        const steps = 10, platforms = [];
        for (let i = 0; i < steps; i++) {
            const a = vRamp[1] - (vRamp[1] - vRamp[0]) * i / steps, b = vRamp[1] - (vRamp[1] - vRamp[0]) * (i + 1) / steps;
            // The ramp enters at the far end of its run (ground level) and descends towards the facade.
            platforms.push({ polygon: rect(t, uRamp[0], uRamp[1], b, a), elevationM: Math.max(0.2, env.storeyHeightM * (1 - (i + 0.5) / steps)) });
        }
        out.ramp = { polygon: rampRect, platforms, railings: [
            { a: [uRamp[0], vRamp[0]], b: [uRamp[0], vRamp[1]], heightM: 1.0 }, { a: [uRamp[1], vRamp[0]], b: [uRamp[1], vRamp[1]], heightM: 1.0 }
        ], slope: Math.round(env.storeyHeightM / rampL * 100) };
        return out;
    }

    const api = { furnishApartment, furnishShop, garageLayout, facadeRun, WINDOW_SPECS, PARTITION_M };
    global.__defaultFloorPlanRooms = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
