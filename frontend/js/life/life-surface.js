// Walkable surface for the life layer: a coarse grid over the scene classifying every cell as
// blocked (building, structure, water, outside), open ground, preferred walking space (sidewalk
// bands, footways, plazas, parks) or carriageway (crossable in a short run, never a destination).
// People wander this surface instead of following lines: "everything that is not a car lane or a
// footprint" is walkable, and the preference keeps most of them along streets and on plazas. Pure
// typed-array work in true metres; nothing here knows about THREE or the DOM.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.__lifeSurface = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CLASS = Object.freeze({ BLOCKED: 0, OPEN: 1, PREFERRED: 2, CARRIAGEWAY: 3 });
    // zcode → walking height: ground, park/plaza paving, park path, corridor sidewalk kerb.
    const Z_LEVELS = Object.freeze([0, 0.06, 0.075, 0.2]);
    const ZCODE = Object.freeze({ GROUND: 0, PLAZA: 1, PATH: 2, KERB: 3 });
    const MAX_CELLS = 1.5e6;        // grid budget; the cell grows for a bigger scene
    const MAX_CROSS_M = 14;         // the longest run across carriageway a walking leg may take
    const TARGET_MIN_M = 6;         // never pick a destination closer than this

    function buildWalkableSurface(input) {
        const [minX, minY, maxX, maxY] = input.bounds;
        const spanX = Math.max(1, maxX - minX);
        const spanY = Math.max(1, maxY - minY);
        const cell = Math.max(input.cellM || 1, Math.ceil(Math.sqrt(spanX * spanY / MAX_CELLS) * 2) / 2);
        const w = Math.ceil(spanX / cell);
        const h = Math.ceil(spanY / cell);
        const cls = new Uint8Array(w * h).fill(CLASS.OPEN);
        const zc = new Uint8Array(w * h);
        const toCol = x => Math.floor((x - minX) / cell);
        const toRow = y => Math.floor((y - minY) / cell);
        const inGrid = (col, row) => col >= 0 && row >= 0 && col < w && row < h;
        const notBlocked = old => old !== CLASS.BLOCKED;
        const always = () => true;

        function stampDisc(x, y, r, c, z, rule) {
            const c0 = Math.max(0, toCol(x - r)), c1 = Math.min(w - 1, toCol(x + r));
            const r0 = Math.max(0, toRow(y - r)), r1 = Math.min(h - 1, toRow(y + r));
            const r2 = r * r;
            for (let row = r0; row <= r1; row++) {
                const cy = minY + (row + 0.5) * cell;
                for (let col = c0; col <= c1; col++) {
                    const cx = minX + (col + 0.5) * cell;
                    const dx = cx - x, dy = cy - y;
                    if (dx * dx + dy * dy > r2) continue;
                    const i = row * w + col;
                    if (!rule(cls[i])) continue;
                    cls[i] = c;
                    zc[i] = z;
                }
            }
        }

        function stampPolyline(pts, r, c, z, rule) {
            if (!Array.isArray(pts) || pts.length < 2) return;
            const step = Math.max(cell * 0.5, 0.25);
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1];
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const n = Math.max(1, Math.ceil(len / step));
                for (let k = 0; k <= n; k++) {
                    const t = k / n;
                    stampDisc(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r, c, z, rule);
                }
            }
        }

        // Even-odd scanline fill over all rings (outer + holes) of one polygon.
        function fillPolygon(rings, c, z, rule) {
            let rMin = Infinity, rMax = -Infinity;
            rings.forEach(ring => ring.forEach(p => {
                const row = toRow(p[1]);
                if (row < rMin) rMin = row;
                if (row > rMax) rMax = row;
            }));
            const xs = [];
            for (let row = Math.max(0, rMin); row <= Math.min(h - 1, rMax); row++) {
                const y = minY + (row + 0.5) * cell;
                xs.length = 0;
                rings.forEach(ring => {
                    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                        const yi = ring[i][1], yj = ring[j][1];
                        if ((yi > y) !== (yj > y)) xs.push(ring[i][0] + (y - yi) / (yj - yi) * (ring[j][0] - ring[i][0]));
                    }
                });
                xs.sort((a, b) => a - b);
                for (let k = 0; k + 1 < xs.length; k += 2) {
                    const c0 = Math.max(0, toCol(xs[k])), c1 = Math.min(w - 1, toCol(xs[k + 1]));
                    for (let col = c0; col <= c1; col++) {
                        const i = row * w + col;
                        if (!rule(cls[i])) continue;
                        cls[i] = c;
                        zc[i] = z;
                    }
                }
            }
        }

        // Paint order: preferred space first, carriageways over it, footprints over everything.
        (input.bands || []).forEach(b => stampPolyline(b.pts, b.halfWidth, CLASS.PREFERRED, b.zcode || 0, notBlocked));
        (input.fills || []).forEach(f => fillPolygon(f.rings, CLASS.PREFERRED, f.zcode || 0, notBlocked));
        (input.carriageways || []).forEach(c => stampPolyline(c.pts, c.halfWidth, CLASS.CARRIAGEWAY, c.zcode || 0, notBlocked));
        (input.blocked || []).forEach(b => {
            if (Array.isArray(b.rings)) fillPolygon(b.rings, CLASS.BLOCKED, 0, always);
            else if (Number.isFinite(b.r)) stampDisc(b.x, b.y, b.r, CLASS.BLOCKED, 0, always);
        });

        const preferred = [];
        let open = 0, carriageway = 0, blocked = 0;
        for (let i = 0; i < cls.length; i++) {
            if (cls[i] === CLASS.PREFERRED) preferred.push(i);
            else if (cls[i] === CLASS.OPEN) open++;
            else if (cls[i] === CLASS.CARRIAGEWAY) carriageway++;
            else blocked++;
        }

        function classAt(x, y) {
            const col = toCol(x), row = toRow(y);
            return inGrid(col, row) ? cls[row * w + col] : CLASS.BLOCKED;
        }
        function zAt(x, y) {
            const col = toCol(x), row = toRow(y);
            return inGrid(col, row) ? Z_LEVELS[zc[row * w + col]] : 0;
        }
        const walkable = c => c === CLASS.OPEN || c === CLASS.PREFERRED;

        // A straight walking leg is fine when it never enters a footprint and only crosses
        // carriageway in short runs (a street crossing, not a stroll down the middle of the road).
        function legOk(ax, ay, bx, by) {
            const len = Math.hypot(bx - ax, by - ay);
            const n = Math.max(1, Math.ceil(len / (cell * 0.5)));
            const stepLen = len / n;
            let run = 0;
            for (let k = 0; k <= n; k++) {
                const t = k / n;
                const c = classAt(ax + (bx - ax) * t, ay + (by - ay) * t);
                if (c === CLASS.BLOCKED) return false;
                if (c === CLASS.CARRIAGEWAY) { run += stepLen; if (run > MAX_CROSS_M) return false; }
                else run = 0;
            }
            return true;
        }

        // A destination within `radius`, mostly in preferred space, reachable by a straight leg.
        function randomTarget(x, y, radius, rng, preferFraction) {
            const prefer = preferFraction == null ? 0.85 : preferFraction;
            for (let attempt = 0; attempt < 40; attempt++) {
                const angle = rng() * Math.PI * 2;
                const d = TARGET_MIN_M + rng() * Math.max(1, radius - TARGET_MIN_M);
                const tx = x + Math.cos(angle) * d, ty = y + Math.sin(angle) * d;
                const c = classAt(tx, ty);
                if (!walkable(c)) continue;
                if (c !== CLASS.PREFERRED && rng() < prefer) continue;
                if (!legOk(x, y, tx, ty)) continue;
                return [tx, ty];
            }
            return null;
        }

        function cellPoint(i, rng) {
            const row = Math.floor(i / w), col = i - row * w;
            return [minX + (col + rng()) * cell, minY + (row + rng()) * cell];
        }

        // A spawn point in preferred space, or anywhere open when the scene has none.
        function randomSpawn(rng) {
            if (preferred.length) return cellPoint(preferred[Math.floor(rng() * preferred.length)], rng);
            for (let attempt = 0; attempt < 200; attempt++) {
                const i = Math.floor(rng() * cls.length);
                if (cls[i] === CLASS.OPEN) return cellPoint(i, rng);
            }
            return null;
        }

        return {
            classAt, zAt, legOk, randomTarget, randomSpawn,
            isWalkable: (x, y) => walkable(classAt(x, y)),
            cell, width: w, height: h, bounds: [minX, minY, maxX, maxY],
            stats: {
                cellM: cell, cells: cls.length, preferred: preferred.length, open, carriageway, blocked,
                preferredAreaM2: preferred.length * cell * cell, openAreaM2: open * cell * cell
            }
        };
    }

    return { buildWalkableSurface, CLASS, ZCODE, Z_LEVELS, MAX_CROSS_M };
});
