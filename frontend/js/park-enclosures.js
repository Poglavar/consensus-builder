// Enclosures in a park: a fenced area (the park's own outline, or a ring drawn inside the park) with a
// fence style, gates and a use (a dog area or a play area), and the play equipment placed in parks
// (swings, seesaws, slides). The pure rules shared by the structure editor, the 2D map, the model view,
// the walking people, MCP and tests: the record, its normalisation and validation, where gates go, the
// fence runs between gates, and every fence and play item as boxes in metres. No DOM, no THREE.
// UMD: window.ParkEnclosures in the browser, require()-able in node.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ParkEnclosures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Fence styles, lightest first. Heights in metres; `parts` say how the fence is built:
    //   posts  square posts (or brick pillars) at every vertex and every `everyM` between them
    //   rails  horizontal bars along each straight run, `z` their centre height
    //   panel  a thin infill sheet along each run (mesh), drawn see-through
    //   bars   vertical bars every `everyM`, from z0 to z1
    //   wall   a solid base along each run (a brick plinth), with an optional coping `cap`
    const FENCES = Object.freeze({
        rail: Object.freeze({
            heightM: 0.6,
            posts: { sizeM: 0.1, heightM: 0.6, everyM: 2.0, material: 'timber' },
            rails: [{ z: 0.45, widthM: 0.05, heightM: 0.08, material: 'timber' }]
        }),
        mesh: Object.freeze({
            heightM: 1.2,
            posts: { sizeM: 0.06, heightM: 1.25, everyM: 2.5, material: 'metal' },
            rails: [{ z: 1.2, widthM: 0.04, heightM: 0.04, material: 'metal' }, { z: 0.06, widthM: 0.04, heightM: 0.04, material: 'metal' }],
            panel: { z0: 0.06, z1: 1.2, widthM: 0.02, material: 'mesh' }
        }),
        iron: Object.freeze({
            heightM: 1.8,
            posts: { sizeM: 0.09, heightM: 1.9, everyM: 2.5, material: 'iron' },
            rails: [{ z: 0.15, widthM: 0.035, heightM: 0.035, material: 'iron' }, { z: 1.7, widthM: 0.035, heightM: 0.035, material: 'iron' }],
            bars: { z0: 0.05, z1: 1.85, sizeM: 0.022, everyM: 0.13, material: 'iron' }
        }),
        plinth: Object.freeze({
            heightM: 2.2,
            wall: { z0: 0, z1: 0.6, widthM: 0.35, material: 'brick', cap: { heightM: 0.06, widthM: 0.42, material: 'stone' } },
            posts: { sizeM: 0.5, heightM: 2.3, everyM: 4.0, material: 'brick', cap: { heightM: 0.08, overhangM: 0.04, material: 'stone' } },
            rails: [{ z: 0.78, widthM: 0.035, heightM: 0.035, material: 'iron' }, { z: 2.05, widthM: 0.035, heightM: 0.035, material: 'iron' }],
            bars: { z0: 0.66, z1: 2.15, sizeM: 0.022, everyM: 0.13, material: 'iron' }
        })
    });
    const FENCE_KINDS = Object.freeze(Object.keys(FENCES));
    const USES = Object.freeze(['none', 'dog', 'play']);
    // A new enclosure's fence: a dog or play area is closed with mesh, a park with wrought iron.
    const DEFAULT_FENCE = Object.freeze({ none: 'iron', dog: 'mesh', play: 'mesh' });
    // The ground inside a dog area is gravel, inside a play area a rubber safety surface.
    const USE_SURFACE = Object.freeze({ none: null, dog: 'gravel', play: 'rubber' });
    const GATE_WIDTH_M = 1.2;
    // A gate farther than this from its fence is not on it.
    const GATE_SNAP_M = 2.0;
    // Bars are thinned out on very long fences so one park never needs more than this many boxes.
    const MAX_BARS = 15000;

    // Play equipment: furniture kind -> its decorationDesign array.
    const EQUIPMENT = Object.freeze({ swing: 'swings', seesaw: 'seesaws', slide: 'slides' });

    // ---- geometry in a local metre frame -------------------------------------------------------
    const R = 6378137, D = Math.PI / 180;
    function frameAt(origin) {
        const c = Math.cos(origin[1] * D);
        return {
            toM: ([lng, lat]) => [(lng - origin[0]) * D * R * c, (lat - origin[1]) * D * R],
            toLL: ([x, y]) => [origin[0] + x / (D * R * c), origin[1] + y / (D * R)]
        };
    }
    const isCoord = value => Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
    const sameCoord = (a, b) => a[0] === b[0] && a[1] === b[1];
    const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

    // A ring as closed [lng, lat] points, or null when it has fewer than three distinct points.
    function closedRing(points) {
        if (!Array.isArray(points)) return null;
        const ring = points.filter(isCoord).map(p => [Number(p[0]), Number(p[1])]);
        if (ring.length && sameCoord(ring[0], ring[ring.length - 1])) ring.pop();
        const distinct = ring.filter((p, i) => i === 0 || !sameCoord(p, ring[i - 1]));
        if (distinct.length < 3) return null;
        return [...distinct, distinct[0]];
    }

    // The outer ring of a park's ground (its largest part when the ground is several).
    function outerRing(geometry) {
        const g = geometry?.type === 'Feature' ? geometry.geometry : geometry;
        if (g?.type === 'Polygon') return closedRing(g.coordinates?.[0]);
        if (g?.type !== 'MultiPolygon') return null;
        let best = null, bestArea = -1;
        for (const polygon of g.coordinates || []) {
            const ring = closedRing(polygon?.[0]);
            if (!ring) continue;
            const frame = frameAt(ring[0]), pts = ring.map(frame.toM);
            let twice = 0;
            for (let i = 0; i < pts.length - 1; i++) twice += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
            if (Math.abs(twice) > bestArea) { bestArea = Math.abs(twice); best = ring; }
        }
        return best;
    }

    // The fence line of an enclosure: its own ring, or the park's outline when it fences the whole park.
    function enclosureRing(enclosure, parkGeometry) {
        return enclosure?.ring ? closedRing(enclosure.ring) : outerRing(parkGeometry);
    }

    // Cumulative distances along a closed ring in metres.
    function measured(ringM) {
        const at = [0];
        for (let i = 1; i < ringM.length; i++) at.push(at[i - 1] + dist(ringM[i - 1], ringM[i]));
        return { at, length: at[at.length - 1] };
    }

    function project(ringM, at, p) {
        let best = { s: 0, distM: Infinity, point: ringM[0] };
        for (let i = 0; i < ringM.length - 1; i++) {
            const a = ringM[i], b = ringM[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
            const u = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
            const q = [a[0] + dx * u, a[1] + dy * u], d = dist(p, q);
            if (d < best.distM) best = { s: at[i] + Math.sqrt(len2) * u, distM: d, point: q };
        }
        return best;
    }

    function pointAt(ringM, at, length, s) {
        const t = ((s % length) + length) % length;
        for (let i = 0; i < ringM.length - 1; i++) {
            if (t <= at[i + 1] || i === ringM.length - 2) {
                const span = at[i + 1] - at[i], u = span ? (t - at[i]) / span : 0;
                return [ringM[i][0] + (ringM[i + 1][0] - ringM[i][0]) * u, ringM[i][1] + (ringM[i + 1][1] - ringM[i][1]) * u];
            }
        }
        return ringM[0];
    }

    // The point on an enclosure's fence nearest `coord`, and how far it is in metres.
    function snapToRing(ring, coord) {
        const closed = closedRing(ring);
        if (!closed || !isCoord(coord)) return null;
        const frame = frameAt(closed[0]), ringM = closed.map(frame.toM), { at } = measured(ringM);
        const hit = project(ringM, at, frame.toM(coord));
        return { point: frame.toLL(hit.point), distM: hit.distM };
    }

    // Where a new enclosure's gates go: where its footpaths cross the fence, else the middle of its
    // longest side. Crossings closer than 3 m are one gate.
    function defaultGates(ring, paths = []) {
        const closed = closedRing(ring);
        if (!closed) return [];
        const frame = frameAt(closed[0]), ringM = closed.map(frame.toM);
        const found = [];
        for (const path of Array.isArray(paths) ? paths : []) {
            const line = (Array.isArray(path) ? path : []).filter(isCoord).map(frame.toM);
            for (let j = 0; j < line.length - 1; j++) {
                for (let i = 0; i < ringM.length - 1; i++) {
                    const hit = segmentCrossing(line[j], line[j + 1], ringM[i], ringM[i + 1]);
                    if (hit && !found.some(other => dist(other, hit) < 3)) found.push(hit);
                }
            }
        }
        if (!found.length) {
            let longest = 0, mid = null;
            for (let i = 0; i < ringM.length - 1; i++) {
                const length = dist(ringM[i], ringM[i + 1]);
                if (length > longest) { longest = length; mid = [(ringM[i][0] + ringM[i + 1][0]) / 2, (ringM[i][1] + ringM[i + 1][1]) / 2]; }
            }
            if (mid) found.push(mid);
        }
        return found.map(frame.toLL);
    }

    function segmentCrossing(p, p2, q, q2) {
        const r = [p2[0] - p[0], p2[1] - p[1]], s = [q2[0] - q[0], q2[1] - q[1]];
        const den = r[0] * s[1] - r[1] * s[0];
        if (Math.abs(den) < 1e-12) return null;
        const qp = [q[0] - p[0], q[1] - p[1]];
        const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
        return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p[0] + r[0] * t, p[1] + r[1] * t] : null;
    }

    // The fence of one enclosure split at its gates: `runs` are the fence lines ([lng, lat] points;
    // one closed ring when there is no gate) and `gates` the openings, each { centre, a, b }. A gate
    // farther than GATE_SNAP_M from the fence is ignored; gates that overlap open as one.
    function fenceRuns(ring, gates = [], { gateWidthM = GATE_WIDTH_M } = {}) {
        const closed = closedRing(ring);
        if (!closed) return { runs: [], gates: [] };
        const frame = frameAt(closed[0]), ringM = closed.map(frame.toM), { at, length } = measured(ringM);
        if (!(length > gateWidthM * 2)) return { runs: [closed], gates: [] };
        const gaps = [];
        for (const gate of Array.isArray(gates) ? gates : []) {
            if (!isCoord(gate)) continue;
            const hit = project(ringM, at, frame.toM(gate));
            if (hit.distM > GATE_SNAP_M) continue;
            gaps.push([hit.s - gateWidthM / 2, hit.s + gateWidthM / 2]);
        }
        if (!gaps.length) return { runs: [closed], gates: [] };
        gaps.sort((x, y) => x[0] - y[0]);
        const merged = [];
        for (const gap of gaps) {
            const last = merged[merged.length - 1];
            if (last && gap[0] <= last[1]) last[1] = Math.max(last[1], gap[1]);
            else merged.push(gap.slice());
        }
        // The last gap may wrap past the start and swallow the first.
        while (merged.length > 1 && merged[merged.length - 1][1] - length >= merged[0][0]) {
            const first = merged.shift();
            merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], first[1] + length);
        }
        const toLL = p => frame.toLL(p);
        const openings = merged.map(([s0, s1]) => ({
            centre: toLL(pointAt(ringM, at, length, (s0 + s1) / 2)), a: toLL(pointAt(ringM, at, length, s0)), b: toLL(pointAt(ringM, at, length, s1))
        }));
        const runs = [];
        for (let i = 0; i < merged.length; i++) {
            const from = merged[i][1];
            let to = i + 1 < merged.length ? merged[i + 1][0] : merged[0][0] + length;
            if (to - from < 0.05) continue;
            const points = [pointAt(ringM, at, length, from)];
            for (let lap = 0; lap <= 2; lap++) {
                for (let v = 0; v < ringM.length - 1; v++) {
                    const s = at[v] + lap * length;
                    if (s > from && s < to) points.push(ringM[v]);
                }
            }
            points.push(pointAt(ringM, at, length, to));
            runs.push(points.map(toLL));
        }
        return { runs, gates: openings };
    }

    // ---- fence parts as boxes ---------------------------------------------------------------------
    // The boxes of one fence style along `runs` given in scene units (k scene units per metre, the
    // Mercator inflation of the model view; 1 for metres). Each box is { material, x, y, z, along,
    // across, height, angle }: x, y, along and across in scene units, z (the box's centre) and height
    // in metres, angle the heading of `along` in radians.
    function fenceParts(runs, fence, k = 1) {
        const spec = FENCES[fence];
        if (!spec) return [];
        const boxes = [];
        const segments = [];
        let totalM = 0;
        for (const run of Array.isArray(runs) ? runs : []) {
            for (let i = 0; i < run.length - 1; i++) {
                const a = run[i], b = run[i + 1], lengthU = dist(a, b);
                if (!(lengthU > 1e-9)) continue;
                segments.push({ a, b, lengthU, lengthM: lengthU / k, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) });
                totalM += lengthU / k;
            }
        }
        const along = (segment, partWidthM) => segment.lengthU + partWidthM * k;
        const centreOf = (segment, t) => [segment.a[0] + (segment.b[0] - segment.a[0]) * t, segment.a[1] + (segment.b[1] - segment.a[1]) * t];
        for (const segment of segments) {
            const [x, y] = centreOf(segment, 0.5);
            if (spec.wall) {
                const { z0, z1, widthM, material, cap } = spec.wall;
                boxes.push({ material, x, y, z: (z0 + z1) / 2, along: along(segment, widthM), across: widthM * k, height: z1 - z0, angle: segment.angle });
                if (cap) boxes.push({ material: cap.material, x, y, z: z1 + cap.heightM / 2, along: along(segment, cap.widthM), across: cap.widthM * k, height: cap.heightM, angle: segment.angle });
            }
            if (spec.panel) {
                const { z0, z1, widthM, material } = spec.panel;
                boxes.push({ material, x, y, z: (z0 + z1) / 2, along: segment.lengthU, across: widthM * k, height: z1 - z0, angle: segment.angle });
            }
            for (const rail of spec.rails || []) {
                boxes.push({ material: rail.material, x, y, z: rail.z, along: along(segment, rail.widthM), across: rail.widthM * k, height: rail.heightM, angle: segment.angle });
            }
        }
        if (spec.bars) {
            const { z0, z1, sizeM, material } = spec.bars;
            const everyM = Math.max(spec.bars.everyM, totalM / MAX_BARS);
            for (const segment of segments) {
                const count = Math.floor(segment.lengthM / everyM);
                for (let i = 0; i < count; i++) {
                    const [x, y] = centreOf(segment, (i + 0.5) / count);
                    boxes.push({ material, x, y, z: (z0 + z1) / 2, along: sizeM * k, across: sizeM * k, height: z1 - z0, angle: segment.angle });
                }
            }
        }
        const posts = spec.posts;
        const post = (x, y, angle) => {
            boxes.push({ material: posts.material, x, y, z: posts.heightM / 2, along: posts.sizeM * k, across: posts.sizeM * k, height: posts.heightM, angle });
            if (posts.cap) {
                const size = (posts.sizeM + 2 * posts.cap.overhangM) * k;
                boxes.push({ material: posts.cap.material, x, y, z: posts.heightM + posts.cap.heightM / 2, along: size, across: size, height: posts.cap.heightM, angle });
            }
        };
        for (const run of Array.isArray(runs) ? runs : []) {
            const closedRun = run.length > 2 && sameCoord(run[0], run[run.length - 1]);
            for (let i = 0; i < run.length - 1; i++) {
                const a = run[i], b = run[i + 1], lengthU = dist(a, b);
                if (!(lengthU > 1e-9)) continue;
                const angle = Math.atan2(b[1] - a[1], b[0] - a[0]), lengthM = lengthU / k;
                const steps = Math.max(1, Math.ceil(lengthM / posts.everyM - 1e-9));
                for (let step = 0; step < steps; step++) {
                    const t = step / steps;
                    post(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, angle);
                }
            }
            if (!closedRun && run.length > 1) {
                const a = run[run.length - 2], b = run[run.length - 1];
                post(b[0], b[1], Math.atan2(b[1] - a[1], b[0] - a[0]));
            }
        }
        return boxes;
    }

    // ---- play equipment ---------------------------------------------------------------------------
    // Each item as boxes in its own metres, standing on z = 0 with its front (+X) facing the record's
    // bearing: { material, x, y, z (centre), sx, sy, sz, ry (tilt about Y, radians) }.
    function box(material, x, y, z, sx, sy, sz, ry = 0) { return { material, x, y, z, sx, sy, sz, ry }; }
    const EQUIPMENT_PARTS = Object.freeze({
        // Two A-frames carry the beam; two seats hang on chains.
        swing: Object.freeze((() => {
            const lean = Math.atan2(0.8, 2.2), leg = Math.hypot(0.8, 2.2), parts = [box('frame', 0, 0, 2.2, 0.1, 3.3, 0.1)];
            for (const y of [-1.55, 1.55]) parts.push(box('frame', 0.4, y, 1.1, 0.08, 0.08, leg, -lean), box('frame', -0.4, y, 1.1, 0.08, 0.08, leg, lean));
            for (const y of [-0.6, 0.6]) {
                parts.push(box('seat', 0, y, 0.45, 0.22, 0.45, 0.04));
                for (const dy of [-0.2, 0.2]) parts.push(box('chain', 0, y + dy, 1.33, 0.02, 0.02, 1.74));
            }
            return parts;
        })()),
        // A plank on a pivot, tipped towards its front end, with a handle at each seat.
        seesaw: Object.freeze((() => {
            const tilt = 0.12, end = 1.45, drop = end * Math.sin(tilt);
            return [
                box('frame', 0, 0, 0.25, 0.3, 0.3, 0.5),
                box('wood', 0, 0, 0.53, 3.6, 0.25, 0.06, tilt),
                box('frame', end - 0.15, 0, 0.53 - drop + 0.2, 0.04, 0.04, 0.34),
                box('frame', end - 0.15, 0, 0.53 - drop + 0.37, 0.04, 0.32, 0.04),
                box('frame', -end + 0.15, 0, 0.53 + drop + 0.2, 0.04, 0.04, 0.34),
                box('frame', -end + 0.15, 0, 0.53 + drop + 0.37, 0.04, 0.32, 0.04)
            ];
        })()),
        // A ladder up to a platform at the back, the chute running down to the front.
        slide: Object.freeze((() => {
            const rise = 1.25, run = 2.35, chute = Math.hypot(rise, run), slope = Math.atan2(rise, run);
            const parts = [
                box('frame', -1.25, -0.27, 0.75, 0.05, 0.05, 1.5), box('frame', -1.25, 0.27, 0.75, 0.05, 0.05, 1.5),
                box('frame', -0.8, -0.3, 0.75, 0.06, 0.06, 1.5), box('frame', -0.8, 0.3, 0.75, 0.06, 0.06, 1.5),
                box('wood', -1.0, 0, 1.5, 0.55, 0.64, 0.06),
                box('chute', -0.75 + run / 2, 0, 1.5 - rise / 2, chute, 0.55, 0.04, slope),
                box('chute', -0.75 + run / 2, -0.29, 1.5 - rise / 2 + 0.08, chute, 0.03, 0.18, slope),
                box('chute', -0.75 + run / 2, 0.29, 1.5 - rise / 2 + 0.08, chute, 0.03, 0.18, slope)
            ];
            for (const z of [0.3, 0.6, 0.9, 1.2]) parts.push(box('frame', -1.25, 0, z, 0.04, 0.54, 0.04));
            return parts;
        })())
    });

    // ---- the record -------------------------------------------------------------------------------
    // decorationDesign.enclosures: [{ fence, use, gates: [[lng, lat]], ring? }]. No ring = the fence
    // follows the park's own outline. Unknown fence styles take the use's default, unknown uses
    // become 'none'; an entry whose ring has fewer than three points is dropped.
    function normalizeEnclosures(list, coordinate = value => (isCoord(value) ? [Number(value[0]), Number(value[1])] : null)) {
        if (!Array.isArray(list)) return [];
        return list.map(entry => {
            if (!entry || typeof entry !== 'object') return null;
            const use = USES.includes(entry.use) ? entry.use : 'none';
            const fence = FENCE_KINDS.includes(entry.fence) ? entry.fence : DEFAULT_FENCE[use];
            const gates = (Array.isArray(entry.gates) ? entry.gates : []).map(coordinate).filter(Boolean);
            const out = { fence, use, gates };
            if (entry.ring !== undefined && entry.ring !== null) {
                const ring = closedRing((Array.isArray(entry.ring) ? entry.ring : []).map(coordinate).filter(Boolean));
                if (!ring) return null;
                out.ring = ring;
            }
            return out;
        }).filter(Boolean);
    }

    // Play equipment placements: { coordinate: [lng, lat], bearing }, bearing in [0, 360).
    function normalizeEquipment(items, coordinate) {
        if (!Array.isArray(items)) return [];
        return items.map(item => {
            const point = coordinate(item?.coordinate || item?.position || item);
            return point ? { coordinate: point, bearing: ((Number(item?.bearing) || 0) % 360 + 360) % 360 } : null;
        }).filter(Boolean);
    }

    // The first thing wrong with one authored enclosure, as { code, message }, or null. `parkGeometry`
    // lets gates of a whole-park fence be checked against the park's outline.
    function enclosureIssue(entry, parkGeometry = null) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { code: 'enclosure-invalid', message: 'An enclosure is an object { fence, use, gates, ring? }.' };
        if (!FENCE_KINDS.includes(entry.fence)) return { code: 'enclosure-fence', message: `An enclosure's fence is one of ${FENCE_KINDS.join(', ')}.` };
        if (!USES.includes(entry.use)) return { code: 'enclosure-use', message: `An enclosure's use is one of ${USES.join(', ')}.` };
        if (entry.ring !== undefined && (!Array.isArray(entry.ring) || entry.ring.length < 4 || !entry.ring.every(isCoord)
            || !sameCoord(entry.ring[0], entry.ring[entry.ring.length - 1]) || !closedRing(entry.ring))) {
            return { code: 'enclosure-ring', message: 'An enclosure ring is a closed ring of at least three distinct [lng, lat] points; leave it out to fence the whole park.' };
        }
        if (!Array.isArray(entry.gates) || !entry.gates.length || !entry.gates.every(isCoord)) {
            return { code: 'enclosure-gate-missing', message: 'An enclosure needs at least one gate, a [lng, lat] point on its fence; without one nobody can get in.' };
        }
        const ring = enclosureRing(entry, parkGeometry);
        if (ring) {
            const off = entry.gates.find(gate => (snapToRing(ring, gate)?.distM ?? Infinity) > GATE_SNAP_M);
            if (off) return { code: 'enclosure-gate-off-fence', message: `A gate must lie within ${GATE_SNAP_M} m of its fence; [${off.join(', ')}] does not.` };
        }
        return null;
    }

    // An enclosure's gates after its fence line changed: each gate still within GATE_SNAP_M snaps onto
    // the new line; when none is left, the default gates take their place.
    function regate(enclosure, ring, paths = []) {
        const kept = [];
        for (const gate of Array.isArray(enclosure?.gates) ? enclosure.gates : []) {
            const hit = snapToRing(ring, gate);
            if (hit && hit.distM <= GATE_SNAP_M) kept.push(hit.point);
        }
        return { ...enclosure, gates: kept.length ? kept : defaultGates(ring, paths) };
    }

    // An enclosure moved with its park: `move` maps a coordinate collection (a point or a ring).
    function moveEnclosure(entry, move) {
        return { ...entry, gates: (entry.gates || []).map(gate => move(gate)), ...(entry.ring ? { ring: move(entry.ring) } : {}) };
    }

    return Object.freeze({
        FENCES, FENCE_KINDS, USES, DEFAULT_FENCE, USE_SURFACE, GATE_WIDTH_M, GATE_SNAP_M, EQUIPMENT, EQUIPMENT_PARTS,
        closedRing, outerRing, enclosureRing, snapToRing, defaultGates, fenceRuns, fenceParts,
        normalizeEnclosures, normalizeEquipment, enclosureIssue, moveEnclosure, regate
    });
});
