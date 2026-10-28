// Pitched roofs, attic walls, gable windows and balconies for buildings drawn under an urban rule
// (rule.roof === 'pitched', rule.balconyDepthM > 0). Pure plan geometry: footprints arrive as planar
// [x, y] rings in any unit with `metresPerUnit` to convert, heights are metres. The 3D view turns
// the result into meshes (three-rule-roofs.js); tests run it without a browser.
//
// The ridge runs along the side the building faces: the orientation holding the most exterior wall
// length, where walls shared with neighbouring buildings of the same design (party walls) do not
// count. For a free-standing house that is its longer side. The roof starts at the top of the last
// floor, so the attic has walls only where the roof rises above that line, which is the gables.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__ruleBuildingDetails = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const ROOF_PITCH_DEG = 35;
    const AXIS_TOLERANCE_DEG = 15;      // edges this close in direction count as one facade
    const BALCONY_FACADE_TOLERANCE_DEG = 25;
    const PARTY_TOLERANCE_M = 0.3;      // how far apart two walls may be and still be one party wall
    const MIN_BALCONY_FACADE_M = 4;
    const BALCONY_WIDTH_M = 3;
    const BALCONY_PITCH_M = 4.5;        // centre-to-centre spacing along a facade
    const SLAB_THICKNESS_M = 0.18;
    const RAILING_HEIGHT_M = 1;
    const RAILING_THICKNESS_M = 0.05;
    const WINDOW_SILL_M = 0.9;
    const WINDOW_HEADROOM_M = 0.3;      // between a window head and the roof above it

    function openRing(ring) {
        const out = [];
        for (const p of ring || []) {
            const prev = out[out.length - 1];
            if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
            out.push([p[0], p[1]]);
        }
        if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
        return out;
    }

    function signedArea(ring) {
        let sum = 0;
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            sum += a[0] * b[1] - b[0] * a[1];
        }
        return sum / 2;
    }

    // Counter-clockwise, so every edge's outward normal is (dy, -dx).
    function ccw(ring) {
        const open = openRing(ring);
        return signedArea(open) < 0 ? open.reverse() : open;
    }

    function edgesOf(ring) {
        return ring.map((a, i) => {
            const b = ring[(i + 1) % ring.length];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const length = Math.hypot(dx, dy);
            return { a, b, length, dir: length ? [dx / length, dy / length] : [1, 0], normal: length ? [dy / length, -dx / length] : [0, 0] };
        });
    }

    // An edge is a party wall when a neighbour's edge runs along it, close and overlapping for at
    // least half its length.
    function partyEdges(ring, neighbourRings, metresPerUnit) {
        const tolerance = PARTY_TOLERANCE_M / metresPerUnit;
        const cosTolerance = Math.cos(5 * Math.PI / 180);
        const others = (neighbourRings || []).flatMap(r => edgesOf(ccw(r))).filter(e => e.length > 0);
        return edgesOf(ring).map(edge => {
            if (!edge.length) return false;
            let overlap = 0;
            for (const other of others) {
                if (Math.abs(edge.dir[0] * other.dir[0] + edge.dir[1] * other.dir[1]) < cosTolerance) continue;
                const offset = (other.a[0] - edge.a[0]) * edge.normal[0] + (other.a[1] - edge.a[1]) * edge.normal[1];
                if (Math.abs(offset) > tolerance) continue;
                const t0 = (other.a[0] - edge.a[0]) * edge.dir[0] + (other.a[1] - edge.a[1]) * edge.dir[1];
                const t1 = (other.b[0] - edge.a[0]) * edge.dir[0] + (other.b[1] - edge.a[1]) * edge.dir[1];
                overlap += Math.max(0, Math.min(edge.length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
            }
            return overlap >= edge.length * 0.5;
        });
    }

    // The facade direction: the edge orientation (mod 180°) carrying the most exterior length.
    function ridgeAxis(ring, party) {
        const edges = edgesOf(ring);
        const exterior = edges.filter((e, i) => !party[i] && e.length > 0);
        const candidates = exterior.length ? exterior : edges.filter(e => e.length > 0);
        const tolerance = AXIS_TOLERANCE_DEG * Math.PI / 180;
        const angle = e => ((Math.atan2(e.dir[1], e.dir[0]) % Math.PI) + Math.PI) % Math.PI;
        let best = null;
        for (const seed of candidates) {
            const a0 = angle(seed);
            let weight = 0, sx = 0, sy = 0;
            for (const e of candidates) {
                let delta = Math.abs(angle(e) - a0);
                delta = Math.min(delta, Math.PI - delta);
                if (delta > tolerance) continue;
                weight += e.length;
                // Doubled angles make opposite directions add up instead of cancelling.
                const a = 2 * angle(e);
                sx += e.length * Math.cos(a); sy += e.length * Math.sin(a);
            }
            if (!best || weight > best.weight) best = { weight, sx, sy };
        }
        if (!best) return [1, 0];
        const a = Math.atan2(best.sy, best.sx) / 2;
        return [Math.cos(a), Math.sin(a)];
    }

    // Where the ridge sits and how steeply the roof rises. `party` marks the ring's party walls.
    function roofFrame(ring, options = {}) {
        const metresPerUnit = options.metresPerUnit > 0 ? options.metresPerUnit : 1;
        const footprint = ccw(ring);
        if (footprint.length < 3) return null;
        const party = options.party || footprint.map(() => false);
        const axis = ridgeAxis(footprint, party);
        const normal = [-axis[1], axis[0]];
        const across = footprint.map(p => p[0] * normal[0] + p[1] * normal[1]);
        const min = Math.min(...across), max = Math.max(...across);
        const pitch = (options.pitchDeg > 0 ? options.pitchDeg : ROOF_PITCH_DEG) * Math.PI / 180;
        const halfDepth = (max - min) / 2;
        return {
            axis, normal, metresPerUnit,
            ridge: (min + max) / 2,
            halfDepth,
            slope: Math.tan(pitch),
            pitch,
            riseM: halfDepth * metresPerUnit * Math.tan(pitch)
        };
    }

    // Metres the roof stands above the eave at a plan point.
    function roofHeightAt(frame, x, y) {
        const d = x * frame.normal[0] + y * frame.normal[1] - frame.ridge;
        return Math.max(0, frame.halfDepth - Math.abs(d)) * frame.metresPerUnit * frame.slope;
    }

    // Sutherland–Hodgman against one half-plane: keep points with side * (d - ridge) >= 0.
    function clipSide(ring, frame, side) {
        const value = p => side * (p[0] * frame.normal[0] + p[1] * frame.normal[1] - frame.ridge);
        const out = [];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            const va = value(a), vb = value(b);
            if (va >= 0) out.push(a);
            if ((va >= 0) !== (vb >= 0)) {
                const t = va / (va - vb);
                out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        }
        return out.length >= 3 && Math.abs(signedArea(out)) > 0 ? out : null;
    }

    // The two roof planes as plan rings (counter-clockwise); each point's height is roofHeightAt.
    function roofFaces(ring, frame) {
        const footprint = ccw(ring);
        return [1, -1].map(side => ({ side, ring: clipSide(footprint, frame, side) })).filter(face => face.ring);
    }

    // The attic's walls: each footprint edge raised from the eave to the roof above it, with the
    // ridge point inserted where an edge crosses it. Edges under the eave line give no wall.
    // Points are [x, y, metres above the eave], in counter-clockwise order seen from outside.
    function atticWalls(ring, frame) {
        const footprint = ccw(ring);
        const epsilon = 0.01;
        const walls = [];
        for (const edge of edgesOf(footprint)) {
            if (!edge.length) continue;
            const top = [[edge.a[0], edge.a[1]]];
            const da = edge.a[0] * frame.normal[0] + edge.a[1] * frame.normal[1] - frame.ridge;
            const db = edge.b[0] * frame.normal[0] + edge.b[1] * frame.normal[1] - frame.ridge;
            if ((da > 0) !== (db > 0) && da !== db) {
                const t = da / (da - db);
                top.push([edge.a[0] + (edge.b[0] - edge.a[0]) * t, edge.a[1] + (edge.b[1] - edge.a[1]) * t]);
            }
            top.push([edge.b[0], edge.b[1]]);
            const heights = top.map(p => roofHeightAt(frame, p[0], p[1]));
            if (Math.max(...heights) <= epsilon) continue;
            const points = [[edge.a[0], edge.a[1], 0], [edge.b[0], edge.b[1], 0]];
            // A corner at the eave line is already the wall's base corner.
            for (let i = top.length - 1; i >= 0; i--) if (heights[i] > epsilon) points.push([top[i][0], top[i][1], heights[i]]);
            walls.push({ points, normal: edge.normal, edge });
        }
        return walls;
    }

    // Openings in the gables: a pair of windows where the attic is roomy enough, else one, else none.
    // Party walls get none.
    function gableWindows(ring, frame, party) {
        const footprint = ccw(ring);
        const edges = edgesOf(footprint);
        const mpu = frame.metresPerUnit;
        const windows = [];
        const fits = (edge, along, widthM, headM) => [-widthM / 2, widthM / 2].every(offsetM => {
            const t = along + offsetM / mpu;
            if (t < 0 || t > edge.length) return false;
            const x = edge.a[0] + edge.dir[0] * t, y = edge.a[1] + edge.dir[1] * t;
            return roofHeightAt(frame, x, y) >= headM + WINDOW_HEADROOM_M;
        });
        edges.forEach((edge, i) => {
            if (party[i] || !edge.length) return;
            const da = edge.a[0] * frame.normal[0] + edge.a[1] * frame.normal[1] - frame.ridge;
            const db = edge.b[0] * frame.normal[0] + edge.b[1] * frame.normal[1] - frame.ridge;
            if ((da > 0) === (db > 0) || da === db) return;
            const apex = edge.length * da / (da - db);
            const sizes = [{ widthM: 1, heightM: 1.2, sillM: WINDOW_SILL_M }, { widthM: 0.7, heightM: 0.8, sillM: 0.6 }];
            for (const size of sizes) {
                const head = size.sillM + size.heightM;
                const pairOffset = (size.widthM / 2 + 0.4) / mpu;
                const pair = [apex - pairOffset, apex + pairOffset];
                const placed = pair.every(t => fits(edge, t, size.widthM, head)) ? pair
                    : fits(edge, apex, size.widthM, head) ? [apex] : null;
                if (!placed) continue;
                for (const t of placed) {
                    windows.push({ center: [edge.a[0] + edge.dir[0] * t, edge.a[1] + edge.dir[1] * t], dir: edge.dir, normal: edge.normal,
                        widthM: size.widthM, heightM: size.heightM, sillM: size.sillM });
                }
                break;
            }
        });
        return windows;
    }

    // Balconies on the exterior walls along the ridge (the street and garden sides), one row per
    // storey above the ground floor. Each is { a, b, normal, depthM, slabTopM }: a–b is where it
    // meets the wall, depthM how far it stands out, slabTopM its floor level above the ground.
    function balconies(ring, frame, party, options) {
        const depthM = Number(options && options.depthM);
        const floorHeightM = Number(options && options.floorHeightM);
        const eaveM = Number(options && options.eaveM);
        if (!(depthM > 0) || !(floorHeightM > 0) || !(eaveM > 0)) return [];
        const floors = Math.max(1, Math.round(eaveM / floorHeightM));
        if (floors < 2) return [];
        const mpu = frame.metresPerUnit;
        const cosTolerance = Math.cos(BALCONY_FACADE_TOLERANCE_DEG * Math.PI / 180);
        const out = [];
        edgesOf(ccw(ring)).forEach((edge, i) => {
            const lengthM = edge.length * mpu;
            if (party[i] || lengthM < MIN_BALCONY_FACADE_M) return;
            if (Math.abs(edge.dir[0] * frame.axis[0] + edge.dir[1] * frame.axis[1]) < cosTolerance) return;
            const count = Math.max(1, Math.floor((lengthM - 1) / BALCONY_PITCH_M));
            const spacingM = lengthM / count;
            const widthM = Math.min(BALCONY_WIDTH_M, spacingM - 1);
            for (let k = 0; k < count; k++) {
                const centreM = (k + 0.5) * spacingM;
                const a = [edge.a[0] + edge.dir[0] * (centreM - widthM / 2) / mpu, edge.a[1] + edge.dir[1] * (centreM - widthM / 2) / mpu];
                const b = [edge.a[0] + edge.dir[0] * (centreM + widthM / 2) / mpu, edge.a[1] + edge.dir[1] * (centreM + widthM / 2) / mpu];
                for (let floor = 1; floor < floors; floor++) {
                    out.push({ a, b, normal: edge.normal, depthM, slabTopM: floor * eaveM / floors });
                }
            }
        });
        return out;
    }

    // Non-indexed triangles of a prism over a plan quad (counter-clockwise), z0 to z1 metres.
    function prismPositions(quad, z0, z1) {
        const q = signedArea(quad) < 0 ? quad.slice().reverse() : quad;
        const out = [];
        const tri = (p, r, s) => out.push(...p, ...r, ...s);
        const lo = q.map(p => [p[0], p[1], z0]), hi = q.map(p => [p[0], p[1], z1]);
        tri(hi[0], hi[1], hi[2]); tri(hi[0], hi[2], hi[3]);
        tri(lo[0], lo[2], lo[1]); tri(lo[0], lo[3], lo[2]);
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            tri(lo[i], lo[j], hi[j]); tri(lo[i], hi[j], hi[i]);
        }
        return out;
    }

    // A balcony as two solids: its slab and its railing (front and both ends), all in plan units
    // with z in metres above the ground.
    function balconyPrisms(balcony, metresPerUnit) {
        const n = balcony.normal, mpu = metresPerUnit;
        const out = (p, metres) => [p[0] + n[0] * metres / mpu, p[1] + n[1] * metres / mpu];
        const dx = balcony.b[0] - balcony.a[0], dy = balcony.b[1] - balcony.a[1];
        const len = Math.hypot(dx, dy) || 1;
        const along = (p, metres) => [p[0] + dx / len * metres / mpu, p[1] + dy / len * metres / mpu];
        const { a, b, depthM, slabTopM } = balcony;
        const slab = prismPositions([a, b, out(b, depthM), out(a, depthM)], slabTopM - SLAB_THICKNESS_M, slabTopM);
        const top = slabTopM + RAILING_HEIGHT_M, t = RAILING_THICKNESS_M;
        const railing = [
            ...prismPositions([out(a, depthM - t), out(b, depthM - t), out(b, depthM), out(a, depthM)], slabTopM, top),
            ...prismPositions([a, along(a, t), along(out(a, depthM - t), t), out(a, depthM - t)], slabTopM, top),
            ...prismPositions([along(b, -t), b, out(b, depthM - t), along(out(b, depthM - t), -t)], slabTopM, top)
        ];
        return { slab, railing };
    }

    // A gable window as two thin solids standing just proud of the wall: a pale frame and the glass.
    function windowPrisms(window, eaveM, metresPerUnit) {
        const mpu = metresPerUnit;
        const at = (alongM, outM) => [window.center[0] + (window.dir[0] * alongM + window.normal[0] * outM) / mpu,
            window.center[1] + (window.dir[1] * alongM + window.normal[1] * outM) / mpu];
        const quad = (halfM, outM) => [at(-halfM, 0), at(halfM, 0), at(halfM, outM), at(-halfM, outM)];
        const bottom = eaveM + window.sillM, top = bottom + window.heightM;
        return {
            frame: prismPositions(quad(window.widthM / 2 + 0.08, 0.03), bottom - 0.08, top + 0.08),
            glass: prismPositions(quad(window.widthM / 2, 0.05), bottom, top)
        };
    }

    // Everything one building needs, or null when the rule asks for neither balconies nor a roof.
    // `ring` is the footprint's outer ring; footprints with courtyards get balconies but no roof.
    function plan(rule, ring, options = {}) {
        if (!rule) return null;
        const pitched = rule.roof === 'pitched';
        const depthM = Number(rule.balconyDepthM) > 0 ? Number(rule.balconyDepthM) : 0;
        if (!pitched && !depthM) return null;
        const metresPerUnit = options.metresPerUnit > 0 ? options.metresPerUnit : 1;
        const footprint = ccw(ring);
        if (footprint.length < 3) return null;
        const party = partyEdges(footprint, options.neighbours, metresPerUnit);
        const frame = roofFrame(footprint, { party, metresPerUnit });
        if (!frame) return null;
        return {
            footprint, frame, party,
            roof: pitched && !options.hasHoles,
            balconies: depthM ? balconies(footprint, frame, party, { depthM, floorHeightM: rule.floorHeightM, eaveM: options.eaveM }) : [],
            windows: pitched && !options.hasHoles ? gableWindows(footprint, frame, party) : []
        };
    }

    return {
        ROOF_PITCH_DEG, ccw, signedArea, partyEdges, ridgeAxis, roofFrame, roofHeightAt, roofFaces, atticWalls,
        gableWindows, balconies, prismPositions, balconyPrisms, windowPrisms, plan
    };
});
