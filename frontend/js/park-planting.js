// What a park's planting looks like: the look of each tree (kind and height) and the plants that
// fill a flowerbed. Pure numbers, no DOM or THREE: the park editor (structure-geometry-editor.js)
// stores and re-rolls tree looks, three-mode.js turns both into meshes, and
// backend/test/park-planting.test.js checks them headlessly.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__parkPlanting = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Height range per kind, in metres. The crown's shape and proportions follow from the kind.
    const TREE_KINDS = {
        broadleaf: { minHeightM: 6, maxHeightM: 14 },   // lime, maple, plane: a round crown
        conifer: { minHeightM: 7, maxHeightM: 18 },     // pine, spruce: a tiered cone
        columnar: { minHeightM: 9, maxHeightM: 20 },    // poplar, cypress: tall and narrow
        ornamental: { minHeightM: 3.5, maxHeightM: 6 }  // cherry, magnolia: low, wide, in blossom
    };
    const KIND_NAMES = Object.keys(TREE_KINDS);
    // A re-rolled tree differs from the one it replaces by at least this much when its kind repeats,
    // so a click always visibly changes it.
    const MIN_VISIBLE_HEIGHT_CHANGE_M = 2;

    function position(value) {
        if (!Array.isArray(value) || value.length < 2) return null;
        const lng = Number(value[0]);
        const lat = Number(value[1]);
        return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }

    // Deterministic [0, 1) from a position: the same spot always grows the same tree.
    function positionUnit(point, salt) {
        let h = Math.imul(((point[0] * 1e6) | 0) ^ (0x9e3779b9 + salt), 0x85ebca6b);
        h ^= Math.imul(((point[1] * 1e6) | 0) ^ 0x165667b1, 0xc2b2ae35);
        h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
        h = (h ^ (h >>> 15)) >>> 0;
        return (h % 100000) / 100000;
    }

    function heightIn(kind, unit) {
        const range = TREE_KINDS[kind];
        return Math.round((range.minHeightM + unit * (range.maxHeightM - range.minHeightM)) * 10) / 10;
    }

    // A stored tree: { coordinate: [lng, lat], kind, heightM }. A tree stored as a bare [lng, lat]
    // (every park drawn before trees carried a look) takes the look its position hashes to.
    function treeOf(entry) {
        const isRecord = entry && !Array.isArray(entry) && typeof entry === 'object';
        const point = position(isRecord ? entry.coordinate : entry);
        if (!point) return null;
        const heightM = isRecord ? Number(entry.heightM) : NaN;
        if (isRecord && TREE_KINDS[entry.kind] && Number.isFinite(heightM)) {
            const range = TREE_KINDS[entry.kind];
            return { coordinate: point, kind: entry.kind, heightM: Math.min(range.maxHeightM, Math.max(range.minHeightM, heightM)) };
        }
        const kind = KIND_NAMES[Math.floor(positionUnit(point, 1) * KIND_NAMES.length)];
        return { coordinate: point, kind, heightM: heightIn(kind, positionUnit(point, 2)) };
    }

    function treeCoordinate(entry) {
        const tree = treeOf(entry);
        return tree ? tree.coordinate : null;
    }

    // A new look for the same tree: a random kind and height, visibly different from the current one.
    function rerollTree(entry, random = Math.random) {
        const current = treeOf(entry);
        if (!current) return null;
        for (let attempt = 0; attempt < 12; attempt++) {
            const kind = KIND_NAMES[Math.min(KIND_NAMES.length - 1, Math.floor(random() * KIND_NAMES.length))];
            const heightM = heightIn(kind, random());
            if (kind !== current.kind || Math.abs(heightM - current.heightM) >= MIN_VISIBLE_HEIGHT_CHANGE_M) {
                return { coordinate: current.coordinate, kind, heightM };
            }
        }
        const kind = KIND_NAMES[(KIND_NAMES.indexOf(current.kind) + 1) % KIND_NAMES.length];
        return { coordinate: current.coordinate, kind, heightM: heightIn(kind, 0.5) };
    }

    // The parts of one tree, in metres above its foot: a trunk and one or more crown pieces, each
    // an ellipsoid ('sphere') or a cone with its base at `baseM`.
    function treeShape(entry) {
        const tree = treeOf(entry);
        if (!tree) return null;
        const h = tree.heightM;
        if (tree.kind === 'conifer') {
            const trunkM = h * 0.22;
            const crownH = h - trunkM;
            const radius = h * 0.2;
            return {
                trunk: { heightM: trunkM + crownH * 0.3, radiusM: 0.12 + h * 0.012 },
                crown: [0, 1, 2].map(tier => ({
                    shape: 'cone',
                    baseM: trunkM + tier * crownH * 0.28,
                    heightM: crownH * (0.55 - tier * 0.08),
                    radiusM: radius * (1 - tier * 0.27)
                })),
                palette: 'conifer'
            };
        }
        if (tree.kind === 'columnar') {
            const trunkM = h * 0.12;
            return {
                trunk: { heightM: trunkM + 0.5, radiusM: 0.12 + h * 0.01 },
                crown: [{ shape: 'sphere', baseM: trunkM, heightM: h - trunkM, radiusM: Math.max(0.8, h * 0.11) }],
                palette: 'columnar'
            };
        }
        if (tree.kind === 'ornamental') {
            const trunkM = h * 0.35;
            const radius = h * 0.42;
            return {
                trunk: { heightM: trunkM + radius * 0.4, radiusM: 0.1 + h * 0.015 },
                crown: [{ shape: 'sphere', baseM: trunkM, heightM: h - trunkM, radiusM: radius }],
                palette: 'blossom'
            };
        }
        const trunkM = h * 0.38;
        const radius = h * 0.3;
        return {
            trunk: { heightM: trunkM + radius * 0.5, radiusM: 0.14 + h * 0.015 },
            crown: [
                { shape: 'sphere', baseM: trunkM, heightM: h - trunkM, radiusM: radius },
                { shape: 'sphere', baseM: trunkM + (h - trunkM) * 0.35, heightM: (h - trunkM) * 0.6, radiusM: radius * 0.7 }
            ],
            palette: 'broadleaf'
        };
    }

    // The map's emoji for a tree: a conifer reads as one, everything else as a leafy tree.
    function treeGlyph(entry) {
        const tree = treeOf(entry);
        return tree && tree.kind === 'conifer' ? '🌲' : '🌳';
    }

    // A symbolic map size follows the authored height in metres; it does not claim a crown footprint.
    // The CSS custom property is the narrow geometry interface shared by editor and saved-map icons.
    function treeIcon(entry) {
        const tree = treeOf(entry);
        const size = tree ? Math.round(10 + tree.heightM * 1.4) : 24;
        return {
            html: `<span class="park-tree-glyph" style="--tree-icon-size: ${size}px">${treeGlyph(entry)}</span>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        };
    }

    // --- flowerbeds -----------------------------------------------------------------------------

    // Blossom colours, in rings from the edge inwards: each bed takes two or three of them.
    const FLOWER_COLORS = [0xe11d48, 0xf59e0b, 0xfacc15, 0x8b5cf6, 0xf472b6, 0xfafafa, 0xea580c, 0x2563eb];
    const PLANT_SPACING = 0.42;   // between plant centres, in the ring's units (scene metres)
    const EDGE_CLEARANCE = 0.22;  // plants keep off the edging
    const BAND_WIDTH = 0.85;      // one colour ring of the bed, measured in from the edge
    const MAX_PLANTS = 900;       // a very large bed is planted more sparsely, not with more meshes

    function mulberry(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function ringPoints(ring) {
        const points = (Array.isArray(ring) ? ring : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (points.length > 1) {
            const first = points[0], last = points[points.length - 1];
            if (first[0] === last[0] && first[1] === last[1]) points.pop();
        }
        return points;
    }

    function inside(points, x, y) {
        let hit = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const [xi, yi] = points[i], [xj, yj] = points[j];
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    }

    function distanceToEdge(points, x, y) {
        let best = Infinity;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const [ax, ay] = points[j], [bx, by] = points[i];
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
            best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
        }
        return best;
    }

    function areaOf(points) {
        let sum = 0;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
        return Math.abs(sum) / 2;
    }

    // A deterministic seed for a bed from its own vertices, so a bed is planted the same way on
    // every rebuild without storing anything.
    function ringSeed(ring) {
        let h = 0x811c9dc5;
        ringPoints(ring).forEach(([x, y]) => {
            h = Math.imul(h ^ ((x * 1e6) | 0), 0x01000193);
            h = Math.imul(h ^ ((y * 1e6) | 0), 0x01000193);
        });
        return h >>> 0;
    }

    // Plants filling a bed whose ring is in planar units (scene metres): a jittered grid, clear of
    // the edging, coloured in rings from the edge inwards like a planted municipal bed. Each plant is
    // a leafy clump; most carry a blossom (`color`, null for a plain green one).
    function flowerbedPlanting(ring, seed) {
        const points = ringPoints(ring);
        if (points.length < 3) return [];
        const random = mulberry(Number.isFinite(seed) ? seed : 1);
        const area = areaOf(points);
        const spacing = Math.max(PLANT_SPACING, Math.sqrt(area / MAX_PLANTS));
        const paletteSize = 2 + Math.floor(random() * 2);
        const start = Math.floor(random() * FLOWER_COLORS.length);
        const step = 1 + Math.floor(random() * (FLOWER_COLORS.length - 1));
        const palette = Array.from({ length: paletteSize }, (_, index) => FLOWER_COLORS[(start + index * step) % FLOWER_COLORS.length]);
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const plants = [];
        let row = 0;
        for (let y = minY + spacing / 2; y < maxY; y += spacing * 0.87, row++) {
            for (let x = minX + spacing / 2 + (row % 2) * spacing / 2; x < maxX; x += spacing) {
                const px = x + (random() - 0.5) * spacing * 0.5;
                const py = y + (random() - 0.5) * spacing * 0.5;
                if (!inside(points, px, py)) continue;
                const edge = distanceToEdge(points, px, py);
                if (edge < EDGE_CLEARANCE) continue;
                const band = Math.floor((edge - EDGE_CLEARANCE) / BAND_WIDTH);
                plants.push({
                    x: px,
                    y: py,
                    radiusM: spacing * (0.42 + random() * 0.16),
                    heightM: 0.22 + random() * 0.18,
                    color: random() < 0.82 ? palette[band % palette.length] : null
                });
                if (plants.length >= MAX_PLANTS) return plants;
            }
        }
        return plants;
    }

    return { TREE_KINDS, FLOWER_COLORS, treeOf, treeCoordinate, rerollTree, treeShape, treeGlyph, treeIcon, flowerbedPlanting, ringSeed };
});
