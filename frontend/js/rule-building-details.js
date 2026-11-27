// Pitched and mansard roofs, attic walls, gable windows, dormers and balconies for buildings drawn
// under an urban rule (rule.roof 'pitched' or 'mansard', rule.balconyDepthM > 0) or carrying a roof
// of their own (properties.roof, a raised existing building). Pure plan geometry: footprints arrive as planar
// [x, y] rings in any unit with `metresPerUnit` to convert, heights are metres. The 3D view turns
// the result into meshes (three-rule-roofs.js); tests run it without a browser.
//
// The ridge runs along the side the building faces: the orientation holding the most exterior wall
// length, where walls shared with neighbouring buildings of the same design (party walls) do not
// count. For a free-standing house that is its longer side. The roof starts at the top of the last
// floor, so the attic has walls only where the roof rises above that line, which is the gables.
//
// A roof is a profile: its height as a function of the distance in from its nearest sloping side.
// A pitched roof slopes to the street and the garden and is one slope to the ridge. A mansard starts
// behind the parapet, rises steeply for a storey, then shallowly to the ridge; it slopes on its
// free ends too (hipped), and rises as a gable only on walls shared with a neighbour.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__ruleBuildingDetails = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const ROOF_PITCH_DEG = 35;
    const ROOF_KINDS = ['pitched', 'mansard'];
    // The mansard of Living Tradition's guide (S. Hughes, Create Streets 2021): the lower slope at
    // most 70° and 2.25 m high, starting 15 inches behind the parapet; the upper slope at most 30°,
    // rising at most 2 m above the lower one (on a deep plot its pitch is lowered to stay under
    // that); an end of terrace or a free-standing building is hipped, not side-gabled.
    const MANSARD = Object.freeze({ setbackM: 0.38, lowerDeg: 70, lowerRiseM: 2.25, upperDeg: 30, upperRiseM: 2 });
    const DORMER = Object.freeze({ widthM: 1.1, heightM: 1.2, sillM: 0.7, pitchM: 3, minFacadeM: 2.5 });
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
    // Roof shades from dark red through reddish brown to brown. Quantised, so a street of roofs
    // shares a handful of materials instead of one per building.
    const ROOF_SHADES = 12;

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

    // The roof a building carries: its urban rule's, else its own (a raised existing building).
    function roofKindOf(source) {
        const props = (source && source.properties) || source || {};
        const kind = (props.urbanRule && props.urbanRule.roof) || props.roof;
        return ROOF_KINDS.includes(kind) ? kind : null;
    }

    // The rule a building's details are drawn from: its urban rule, else one made of its own roof.
    function detailRuleOf(feature) {
        const props = (feature && feature.properties) || {};
        if (props.urbanRule && typeof props.urbanRule === 'object') return props.urbanRule;
        return ROOF_KINDS.includes(props.roof) ? { roof: props.roof, floorHeightM: props.floorHeightM } : null;
    }

    // A roof's height profile: [metres in from the eave edge, metres above the eave] points, from
    // the edge to the ridge line `halfDepthM` in. Cut where the building is too shallow for it.
    function roofProfile(kind, halfDepthM, pitch) {
        let points = [[0, 0], [halfDepthM, halfDepthM * Math.tan(pitch)]];
        if (kind === 'mansard') {
            const foot = MANSARD.setbackM + MANSARD.lowerRiseM / Math.tan(MANSARD.lowerDeg * Math.PI / 180);
            points = [[0, 0], [MANSARD.setbackM, 0], [foot, MANSARD.lowerRiseM]];
            // The upper slope reaches the ridge at 30°, or flatter where that would pass its limit.
            if (halfDepthM > foot) {
                points.push([halfDepthM, MANSARD.lowerRiseM
                    + Math.min(MANSARD.upperRiseM, (halfDepthM - foot) * Math.tan(MANSARD.upperDeg * Math.PI / 180))]);
            }
        }
        const out = [];
        for (let i = 0; i < points.length; i++) {
            const [u, h] = points[i];
            if (u < halfDepthM) { out.push([u, h]); continue; }
            const [u0, h0] = points[i - 1];
            out.push([halfDepthM, u > u0 ? h0 + (h - h0) * (halfDepthM - u0) / (u - u0) : h0]);
            break;
        }
        return out;
    }

    function profileHeight(profile, u) {
        if (!(u > 0)) return 0;
        for (let i = 1; i < profile.length; i++) {
            const [u0, h0] = profile[i - 1], [u1, h1] = profile[i];
            if (u <= u1) return u1 > u0 ? h0 + (h1 - h0) * (u - u0) / (u1 - u0) : h1;
        }
        return profile[profile.length - 1][1];
    }

    // Which ends of the building (lowest and highest along the ridge) stand free: more exterior
    // than party wall across them. A mansard slopes on those ends too.
    function freeEnds(footprint, party, axis, alongMin, alongMax, metresPerUnit) {
        const near = 0.5 / metresPerUnit;
        const sinTolerance = Math.sin(BALCONY_FACADE_TOLERANCE_DEG * Math.PI / 180);
        const ends = { min: [0, 0], max: [0, 0] }; // [exterior length, party length]
        edgesOf(footprint).forEach((edge, i) => {
            if (!edge.length || Math.abs(edge.dir[0] * axis[0] + edge.dir[1] * axis[1]) > sinTolerance) return;
            const along = ((edge.a[0] + edge.b[0]) * axis[0] + (edge.a[1] + edge.b[1]) * axis[1]) / 2;
            const end = along - alongMin < near ? ends.min : alongMax - along < near ? ends.max : null;
            if (end) end[party[i] ? 1 : 0] += edge.length;
        });
        return { min: ends.min[0] > ends.min[1], max: ends.max[0] > ends.max[1] };
    }

    // Where the ridge sits and how the roof rises. `party` marks the ring's party walls; `kind` is
    // 'pitched' (the default) or 'mansard'. `sides` are the roof's sloping sides, each a linear
    // function of the plan point (sideDistance): the street and the garden side, and for a mansard
    // its free ends.
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
        const halfDepth = (max - min) / 2, ridge = (min + max) / 2;
        const kind = options.kind === 'mansard' ? 'mansard' : 'pitched';
        const profile = roofProfile(kind, halfDepth * metresPerUnit, pitch);
        const sides = [
            { key: 1, n: [-normal[0], -normal[1]], c: ridge + halfDepth, along: axis },
            { key: -1, n: normal, c: halfDepth - ridge, along: axis }
        ];
        if (kind === 'mansard') {
            const along = footprint.map(p => p[0] * axis[0] + p[1] * axis[1]);
            const alongMin = Math.min(...along), alongMax = Math.max(...along);
            const free = freeEnds(footprint, party, axis, alongMin, alongMax, metresPerUnit);
            if (free.min) sides.push({ key: 'hip-min', n: axis, c: -alongMin, along: normal });
            if (free.max) sides.push({ key: 'hip-max', n: [-axis[0], -axis[1]], c: alongMax, along: normal });
        }
        return {
            axis, normal, metresPerUnit, kind, profile, sides, ridge, halfDepth,
            slope: Math.tan(pitch),
            pitch,
            riseM: profile[profile.length - 1][1]
        };
    }

    // Metres in from one sloping side at a plan point.
    function sideDistance(frame, side, p) {
        return (side.c + p[0] * side.n[0] + p[1] * side.n[1]) * frame.metresPerUnit;
    }

    // Metres in from the nearest sloping side at a plan point (0 at the eave edge).
    function insetAt(frame, x, y) {
        return Math.max(0, Math.min(...frame.sides.map(side => sideDistance(frame, side, [x, y]))));
    }

    // Metres the roof stands above the eave at a plan point.
    function roofHeightAt(frame, x, y) {
        return profileHeight(frame.profile, insetAt(frame, x, y));
    }

    // Metres along the roof's surface from the ridge line down to a plan point (for tiling).
    function roofSlopeLengthAt(frame, x, y) {
        const u = insetAt(frame, x, y), profile = frame.profile;
        let length = 0;
        for (let i = profile.length - 1; i > 0; i--) {
            const [u0, h0] = profile[i - 1], [u1, h1] = profile[i];
            if (u >= u1) break;
            const from = Math.max(u, u0);
            length += Math.hypot(u1 - from, (h1 - h0) * (u1 - from) / ((u1 - u0) || 1));
            if (u >= u0) break;
        }
        return length;
    }

    // Sutherland–Hodgman against one half-plane: keep points with value(p) >= 0.
    function clipHalf(ring, value) {
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
        return out.length >= 3 && Math.abs(signedArea(out)) > 1e-12 ? out : null;
    }

    // The roof planes as plan rings (counter-clockwise); each point's height is roofHeightAt. Each
    // sloping side owns the part of the footprint nearest to it, cut where its profile breaks: one
    // plane a side for a pitched roof; a gutter strip and two slopes a side for a mansard.
    // `along` is the horizontal direction of the plane (for tiling).
    function roofFaces(ring, frame) {
        const footprint = ccw(ring);
        const faces = [];
        for (const side of frame.sides) {
            let region = footprint;
            for (const other of frame.sides) {
                if (other !== side && region) region = clipHalf(region, p => sideDistance(frame, other, p) - sideDistance(frame, side, p));
            }
            for (let i = 1; region && i < frame.profile.length; i++) {
                const [u0, h0] = frame.profile[i - 1], [u1, h1] = frame.profile[i];
                if (!(u1 > u0)) continue;
                let band = u0 > 0 ? clipHalf(region, p => sideDistance(frame, side, p) - u0) : region;
                if (band) band = clipHalf(band, p => u1 - sideDistance(frame, side, p));
                if (band) faces.push({ side: side.key, ring: band, pitch: Math.atan2(h1 - h0, u1 - u0), along: side.along });
            }
        }
        return faces;
    }

    // Square metres of the storey inside a mansard: the footprint behind the parapet setbacks.
    function mansardFloorAreaM2(ring, frame) {
        let region = ccw(ring);
        for (const side of frame.sides) {
            if (region) region = clipHalf(region, p => sideDistance(frame, side, p) - MANSARD.setbackM);
        }
        return region ? Math.abs(signedArea(region)) * frame.metresPerUnit * frame.metresPerUnit : 0;
    }

    // The attic's walls: each footprint edge raised from the eave to the roof above it, with a
    // point inserted where the edge crosses the ridge, a hip or a break of the roof's profile. Edges under
    // the eave line give no wall. `points` is the wall's outline, [x, y, metres above the eave] in
    // counter-clockwise order seen from outside; `triangles` fills it.
    function atticWalls(ring, frame) {
        const footprint = ccw(ring);
        const epsilon = 0.01;
        const breaks = frame.profile.slice(1, -1).map(([u]) => u);
        const walls = [];
        for (const edge of edgesOf(footprint)) {
            if (!edge.length) continue;
            // Along the edge each side's distance is linear: cut where one meets a profile break,
            // and where two sides are equally near (the ridge or a hip).
            const ends = frame.sides.map(side => [sideDistance(frame, side, edge.a), sideDistance(frame, side, edge.b)]);
            const found = [];
            const add = t => { if (t > 1e-9 && t < 1 - 1e-9) found.push(t); };
            ends.forEach(([ga, gb], i) => {
                if (ga !== gb) for (const u of breaks) add((u - ga) / (gb - ga));
                for (const [ha, hb] of ends.slice(i + 1)) {
                    const gap = (gb - ga) - (hb - ha);
                    if (gap !== 0) add((ha - ga) / gap);
                }
            });
            const cuts = found.sort((p, q) => p - q).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-9);
            const top = [[edge.a[0], edge.a[1]],
                ...cuts.map(t => [edge.a[0] + (edge.b[0] - edge.a[0]) * t, edge.a[1] + (edge.b[1] - edge.a[1]) * t]),
                [edge.b[0], edge.b[1]]];
            const heights = top.map(p => roofHeightAt(frame, p[0], p[1]));
            if (Math.max(...heights) <= epsilon) continue;
            // The wall stands where the roof does: its base starts and ends at the last point at
            // the eave line before the roof rises (behind a mansard's setback, not at the corner).
            let first = heights.findIndex(h => h > epsilon), last = heights.length - 1;
            while (heights[last] <= epsilon) last--;
            first = Math.max(0, first - 1); last = Math.min(heights.length - 1, last + 1);
            const points = [[top[first][0], top[first][1], 0], [top[last][0], top[last][1], 0]];
            for (let i = last; i >= first; i--) if (heights[i] > epsilon) points.push([top[i][0], top[i][1], heights[i]]);
            const triangles = [];
            for (let i = first; i < last; i++) {
                const p = top[i], q = top[i + 1], hp = heights[i], hq = heights[i + 1];
                if (hq > epsilon) triangles.push([[p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], hq]]);
                if (hp > epsilon) triangles.push([[p[0], p[1], 0], [q[0], q[1], hq], [p[0], p[1], hp]]);
            }
            walls.push({ points, triangles, normal: edge.normal, edge });
        }
        return walls;
    }

    // Dormer windows in a mansard's lower slope: on each exterior wall along the ridge that stands
    // at the eave edge, evenly spaced. Each is { center, dir, normal, widthM, heightM, sillM,
    // depthM }: `center` is on the lower slope's foot, `depthM` how far back the dormer runs to
    // meet the slope at its own top.
    function dormers(ring, frame, party) {
        if (frame.kind !== 'mansard' || frame.profile.length < 3) return [];
        const mpu = frame.metresPerUnit;
        const cosTolerance = Math.cos(BALCONY_FACADE_TOLERANCE_DEG * Math.PI / 180);
        const topM = DORMER.sillM + DORMER.heightM + 0.12;
        if (frame.riseM < topM + 0.2) return [];
        const depthM = topM / Math.tan(MANSARD.lowerDeg * Math.PI / 180);
        const out = [];
        edgesOf(ccw(ring)).forEach((edge, i) => {
            const lengthM = edge.length * mpu;
            if (party[i] || lengthM < DORMER.minFacadeM) return;
            if (Math.abs(edge.dir[0] * frame.axis[0] + edge.dir[1] * frame.axis[1]) < cosTolerance) return;
            const mid = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
            if (insetAt(frame, mid[0], mid[1]) > 0.2) return; // a wall inside the roof, not at its edge
            const count = Math.max(1, Math.floor(lengthM / DORMER.pitchM));
            for (let k = 0; k < count; k++) {
                const t = (k + 0.5) * edge.length / count;
                out.push({
                    center: [edge.a[0] + edge.dir[0] * t - edge.normal[0] * MANSARD.setbackM / mpu,
                        edge.a[1] + edge.dir[1] * t - edge.normal[1] * MANSARD.setbackM / mpu],
                    dir: edge.dir, normal: edge.normal, widthM: DORMER.widthM, heightM: DORMER.heightM, sillM: DORMER.sillM, depthM
                });
            }
        });
        return out;
    }

    // A dormer as three solids: its body running back into the roof, and a window on its front.
    function dormerPrisms(dormer, eaveM, metresPerUnit) {
        const mpu = metresPerUnit;
        const at = (alongM, inM) => [dormer.center[0] + (dormer.dir[0] * alongM - dormer.normal[0] * inM) / mpu,
            dormer.center[1] + (dormer.dir[1] * alongM - dormer.normal[1] * inM) / mpu];
        const half = dormer.widthM / 2 + 0.12;
        const top = eaveM + dormer.sillM + dormer.heightM + 0.12;
        const window = windowPrisms({ ...dormer, center: at(0, 0) }, eaveM, mpu);
        return {
            body: prismPositions([at(-half, 0), at(half, 0), at(half, dormer.depthM), at(-half, dormer.depthM)], eaveM, top),
            frame: window.frame, glass: window.glass
        };
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

    // Each building's own roof shade, stable for its key (proposal, parcel, building). FNV-1a, as
    // the rule seeds use, so every view and reload picks the same shade.
    function roofShade(key) {
        let h = 0x811c9dc5;
        for (const char of String(key)) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193);
        // FNV's low bits barely move between similar keys; mix before taking a remainder.
        h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
        const step = (h >>> 0) % ROOF_SHADES;
        const t = step / (ROOF_SHADES - 1);
        const hue = 2 + t * 24;                                   // 2° dark red → 26° brown
        const saturation = 58 - t * 20 + ((h >>> 8) % 3) * 3;      // browns are less saturated
        const lightness = 30 - t * 6 + ((h >>> 12) % 3) * 2;
        return { step, hue, saturation, lightness, css: `hsl(${hue.toFixed(1)}, ${saturation}%, ${lightness}%)` };
    }

    // Everything one building needs, or null when the rule asks for neither balconies nor a roof.
    // `ring` is the footprint's outer ring; footprints with courtyards get balconies but no roof.
    function plan(rule, ring, options = {}) {
        if (!rule) return null;
        const kind = ROOF_KINDS.includes(rule.roof) ? rule.roof : null;
        const pitched = !!kind;
        const depthM = Number(rule.balconyDepthM) > 0 ? Number(rule.balconyDepthM) : 0;
        if (!pitched && !depthM) return null;
        const metresPerUnit = options.metresPerUnit > 0 ? options.metresPerUnit : 1;
        const footprint = ccw(ring);
        if (footprint.length < 3) return null;
        const party = partyEdges(footprint, options.neighbours, metresPerUnit);
        const frame = roofFrame(footprint, { party, metresPerUnit, kind });
        if (!frame) return null;
        return {
            footprint, frame, party,
            dormers: pitched && !options.hasHoles ? dormers(footprint, frame, party) : [],
            roof: pitched && !options.hasHoles,
            balconies: depthM ? balconies(footprint, frame, party, { depthM, floorHeightM: rule.floorHeightM, eaveM: options.eaveM }) : [],
            windows: pitched && !options.hasHoles ? gableWindows(footprint, frame, party) : []
        };
    }

    return {
        ROOF_PITCH_DEG, ROOF_KINDS, MANSARD, ccw, signedArea, partyEdges, ridgeAxis, roofKindOf, detailRuleOf, roofFrame,
        roofHeightAt, roofSlopeLengthAt, roofFaces, mansardFloorAreaM2, atticWalls, gableWindows, dormers, dormerPrisms,
        balconies, prismPositions, balconyPrisms, windowPrisms, plan, roofShade
    };
});
