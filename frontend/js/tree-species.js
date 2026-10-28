// Tree species for the 3D model view: eight low-poly species built procedurally as unit-height,
// vertex-coloured meshes (one InstancedMesh per species draws every tree of that species), the
// choice of species for a tree (a park tree's kind, else the region's mix rolled by position), its
// height, turn and tint, and the "near tier" selection (the trees closest to the camera get these
// meshes, the rest stay cheap blobs). Pure numbers, no THREE: the renderer uploads the arrays.
// UMD: window.TreeSpecies in the browser, require()-able in node.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.TreeSpecies = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Authored sRGB colours; the arrays carry linear values because three reads vertex colours as linear.
    const srgb = hex => [hex >> 16, (hex >> 8) & 255, hex & 255].map(c => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });

    // Height ranges in metres (a tree without a stored height rolls inside its species' range), the
    // crown and bark colours, and the far-tier blob colour (the blob is a sphere on a stick, so its
    // crown sits at `blobCrown` of the height with radius `blobRadius` of the height).
    const SPECIES = Object.freeze({
        linden: { heightM: [9, 16], leaf: 0x4f7a2e, bark: 0x5b4a3a, blobCrown: 0.62, blobRadius: 0.27 },
        plane: { heightM: [12, 22], leaf: 0x5f8a34, bark: 0x9a927a, blobCrown: 0.64, blobRadius: 0.3 },
        chestnut: { heightM: [10, 16], leaf: 0x3d6526, bark: 0x4e3d30, blobCrown: 0.58, blobRadius: 0.32 },
        spruce: { heightM: [10, 20], leaf: 0x2c4a2f, bark: 0x4a3426, blobCrown: 0.5, blobRadius: 0.2 },
        pine: { heightM: [8, 14], leaf: 0x3f5a2a, bark: 0x6a4a35, blobCrown: 0.8, blobRadius: 0.3 },
        cypress: { heightM: [8, 15], leaf: 0x2f4a26, bark: 0x4e3a2c, blobCrown: 0.52, blobRadius: 0.1 },
        olive: { heightM: [4, 7], leaf: 0x7d8c5c, bark: 0x6b5f50, blobCrown: 0.62, blobRadius: 0.38 },
        cherry: { heightM: [4, 7], leaf: 0xf0b3c6, bark: 0x5a3c34, blobCrown: 0.62, blobRadius: 0.36 }
    });
    const SPECIES_IDS = Object.freeze(Object.keys(SPECIES));

    // Regional mixes as cumulative weights. OSM trees here carry no genus or leaf type, so a tree's
    // species is its region's mix rolled by its position: stable across rebuilds and cameras.
    const MIXES = Object.freeze({
        temperate: [['linden', 0.34], ['plane', 0.24], ['chestnut', 0.24], ['spruce', 0.18]],
        mediterranean: [['pine', 0.32], ['cypress', 0.16], ['olive', 0.2], ['plane', 0.16], ['linden', 0.16]]
    });

    // The eastern Adriatic coast and islands, Trieste to Ulcinj, as [lng, lat]; and the Mediterranean
    // basin south of 42°N as a box. Coarse on purpose: it picks a plausible species mix, nothing more.
    const ADRIATIC_COAST = [[13.0, 45.8], [13.75, 45.7], [13.95, 45.45], [14.6, 45.4], [14.95, 45.0],
        [15.35, 44.4], [15.65, 44.05], [16.05, 43.8], [16.6, 43.6], [17.05, 43.45], [17.6, 43.1],
        [18.3, 42.75], [18.9, 42.45], [19.5, 42.0], [19.5, 41.7], [18.9, 41.7], [17.5, 42.2],
        [16.0, 42.6], [14.5, 43.5], [13.2, 44.6]];
    function insideRing(ring, x, y) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    function regionOf(lng, lat) {
        if (insideRing(ADRIATIC_COAST, lng, lat)) return 'mediterranean';
        if (lat > 30 && lat < 42 && lng > -10 && lng < 37) return 'mediterranean';
        return 'temperate';
    }

    // Deterministic [0, 1) from a position and a salt, so each tree keeps its species and size.
    function hash01(lng, lat, salt) {
        let h = Math.imul(((lng * 1e6) | 0) ^ Math.imul(salt + 1, 0x9e3779b9), 0x85ebca6b);
        h ^= Math.imul(((lat * 1e6) | 0) ^ 0x165667b1, 0xc2b2ae35);
        h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
        return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
    }

    function rollMix(mix, roll) {
        const total = mix.reduce((sum, [, w]) => sum + w, 0);
        let acc = 0;
        for (const [id, w] of mix) { acc += w / total; if (roll < acc) return id; }
        return mix[mix.length - 1][0];
    }

    // A park tree's stored kind (park-planting.js) names a form; the region picks the species of it.
    function speciesForKind(kind, region, roll) {
        const med = region === 'mediterranean';
        if (kind === 'conifer') return med ? 'pine' : 'spruce';
        if (kind === 'columnar') return 'cypress';
        if (kind === 'ornamental') return 'cherry';
        if (kind === 'broadleaf') return rollMix(med ? [['plane', 0.4], ['linden', 0.4], ['olive', 0.2]] : MIXES.temperate.slice(0, 3), roll);
        return null;
    }

    // One tree's look: { species, heightM, yaw, tint: [r, g, b] }. `kind` and `heightM` are a stored
    // tree's own; an OSM tree has neither.
    function treeInstance(lng, lat, { kind = null, heightM = null } = {}) {
        const region = regionOf(lng, lat);
        const roll = hash01(lng, lat, 1);
        const species = speciesForKind(kind, region, roll) || rollMix(MIXES[region], roll);
        const [lo, hi] = SPECIES[species].heightM;
        const height = typeof heightM === 'number' && Number.isFinite(heightM) && heightM > 0
            ? heightM : lo + (hi - lo) * hash01(lng, lat, 2);
        const t = hash01(lng, lat, 4) - 0.5, u = hash01(lng, lat, 5) - 0.5;
        return {
            species, heightM: height, yaw: hash01(lng, lat, 3) * Math.PI * 2,
            tint: [1 + t * 0.2 + u * 0.08, 1 + t * 0.14, 1 - t * 0.1 + u * 0.1]
        };
    }

    // The near tier: a Uint8Array mask over `points` ([[x, y], ...], one planar unit) of the trees
    // within `radius` of a camera at (x, y) and `height` above the ground, at most the `count` nearest.
    // From an orbit high above, nothing is near: every tree stays a blob. A partial selection, not a
    // full sort.
    function nearTierMask(points, x, y, height, radius, count) {
        const n = points.length;
        const mask = new Uint8Array(n);
        const reach = radius * radius - height * height;
        if (count <= 0 || !(reach > 0)) return mask;
        const d = new Float64Array(n);
        let inside = 0;
        for (let i = 0; i < n; i++) {
            const dx = points[i][0] - x, dy = points[i][1] - y;
            d[i] = dx * dx + dy * dy;
            if (d[i] < reach) inside++;
        }
        let limit = reach;
        if (inside > count) limit = Float64Array.from(d).sort()[count - 1];
        let taken = 0;
        for (let i = 0; i < n && taken < count; i++) if (d[i] < reach && d[i] < limit) { mask[i] = 1; taken++; }
        for (let i = 0; i < n && taken < count; i++) if (d[i] < reach && d[i] === limit) { mask[i] = 1; taken++; }
        return mask;
    }

    // How far from the camera a tree is drawn as its species mesh, in metres, and how many may be:
    // fewer on a phone-class device.
    const NEAR_TIER_RADIUS_M = 250;
    function nearTierSize({ coarsePointer = false } = {}) { return coarsePointer ? 1000 : 2500; }

    // ---- Geometry: a unit-height tree, base at the origin, Z up, crowns as noisy clumps ----

    function rng(seed) {
        let s = seed >>> 0;
        return () => {
            s = (s + 0x6d2b79f5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Unit icosphere subdivided once: 42 vertices, 80 triangles.
    const ICOSPHERE = (() => {
        const p = (1 + Math.sqrt(5)) / 2;
        const verts = [[-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p], [0, -1, -p], [0, 1, -p], [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1]]
            .map(v => { const l = Math.hypot(...v); return v.map(c => c / l); });
        const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
        const mid = new Map();
        const middle = (a, b) => {
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            if (mid.has(key)) return mid.get(key);
            const v = verts[a].map((c, i) => c + verts[b][i]);
            const l = Math.hypot(...v);
            verts.push(v.map(c => c / l));
            mid.set(key, verts.length - 1);
            return verts.length - 1;
        };
        const out = [];
        faces.forEach(([a, b, c]) => {
            const ab = middle(a, b), bc = middle(b, c), ca = middle(c, a);
            out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
        });
        return { verts, faces: out };
    })();

    function createBuilder() {
        const positions = [], normals = [], colors = [], indices = [];
        const vertex = (p, n, c) => {
            positions.push(p[0], p[1], p[2]);
            const l = Math.hypot(n[0], n[1], n[2]) || 1;
            normals.push(n[0] / l, n[1] / l, n[2] / l);
            colors.push(c[0], c[1], c[2]);
            return positions.length / 3 - 1;
        };
        return {
            vertex,
            triangle(a, b, c) { indices.push(a, b, c); },
            // Scaled so the tallest vertex is exactly 1: an instance scaled by heightM is that tall.
            result() {
                const count = positions.length / 3;
                let top = 0;
                for (let i = 2; i < positions.length; i += 3) top = Math.max(top, positions[i]);
                if (top > 0) for (let i = 0; i < positions.length; i++) positions[i] /= top;
                return {
                    positions: new Float32Array(positions), normals: new Float32Array(normals), colors: new Float32Array(colors),
                    indices: count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
                    triangles: indices.length / 3
                };
            }
        };
    }

    const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

    // A noisy foliage clump. Normals lean outward from the whole crown's centre, so the crown shades
    // as one volume with a lumpy silhouette; undersides and the crown's inside are darker.
    function clump(b, rand, centre, radii, crownCentre, leaf) {
        const shade = 0.85 + rand() * 0.25;
        const ids = ICOSPHERE.verts.map(v => {
            const r = 1 + (rand() - 0.5) * 0.38;
            const p = [centre[0] + v[0] * radii[0] * r, centre[1] + v[1] * radii[1] * r, centre[2] + v[2] * radii[2] * r];
            const out = [p[0] - crownCentre[0], p[1] - crownCentre[1], (p[2] - crownCentre[2]) * 0.8];
            const ol = Math.hypot(...out) || 1;
            const n = [v[0] * 0.45 + out[0] / ol * 0.55, v[1] * 0.45 + out[1] / ol * 0.55, v[2] * 0.45 + out[2] / ol * 0.55 + 0.1];
            const up = Math.max(0, Math.min(1, (v[2] + 1) / 2));
            const light = (0.55 + 0.45 * up) * shade * (0.9 + rand() * 0.2);
            return b.vertex(p, n, scale3(leaf, light));
        });
        ICOSPHERE.faces.forEach(([x, y, z]) => b.triangle(ids[x], ids[y], ids[z]));
    }

    // A tapered limb from `from` to `to`, open at both ends (the ground hides one, the crown the other).
    function limb(b, from, to, r0, r1, sides, bark) {
        const axis = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const len = Math.hypot(...axis) || 1;
        const w = axis.map(c => c / len);
        const helper = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        let u = [w[1] * helper[2] - w[2] * helper[1], w[2] * helper[0] - w[0] * helper[2], w[0] * helper[1] - w[1] * helper[0]];
        const ul = Math.hypot(...u); u = u.map(c => c / ul);
        const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
        const ring = (centre, r, light) => Array.from({ length: sides }, (_, i) => {
            const a = (i / sides) * Math.PI * 2;
            const n = [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
            return b.vertex([centre[0] + n[0] * r, centre[1] + n[1] * r, centre[2] + n[2] * r], n, scale3(bark, light * (0.92 + 0.16 * ((i * 7) % 3) / 2)));
        });
        const lower = ring(from, r0, 0.8), upper = ring(to, r1, 1);
        for (let i = 0; i < sides; i++) {
            const j = (i + 1) % sides;
            b.triangle(lower[i], lower[j], upper[j]);
            b.triangle(lower[i], upper[j], upper[i]);
        }
    }

    // A drooping, ragged conifer tier: a cone whose rim alternates in and out, closed underneath.
    function tier(b, rand, baseZ, topZ, radius, leaf, sides = 10) {
        const top = b.vertex([0, 0, topZ], [0, 0, 1], scale3(leaf, 1.05));
        const under = b.vertex([0, 0, baseZ + (topZ - baseZ) * 0.25], [0, 0, -1], scale3(leaf, 0.45));
        const rim = Array.from({ length: sides }, (_, i) => {
            const a = (i / sides) * Math.PI * 2 + rand() * 0.2;
            const r = radius * (i % 2 ? 0.78 : 1) * (0.9 + rand() * 0.2);
            const p = [Math.cos(a) * r, Math.sin(a) * r, baseZ - (i % 2 ? 0 : radius * 0.12)];
            return b.vertex(p, [Math.cos(a), Math.sin(a), 0.55], scale3(leaf, 0.7 + rand() * 0.15));
        });
        for (let i = 0; i < sides; i++) {
            const j = (i + 1) % sides;
            b.triangle(rim[i], rim[j], top);
            b.triangle(rim[j], rim[i], under);
        }
    }

    // Broadleaf crown: a ring of clumps around a core, each squashed toward the crown's outline.
    function broadleafCrown(b, rand, { centreZ, rx, rz, clumps, clumpR, leaf, flat = 1 }) {
        const crownCentre = [0, 0, centreZ];
        clump(b, rand, crownCentre, [rx * 0.72, rx * 0.72, rz * 0.7], crownCentre, leaf);
        for (let i = 0; i < clumps; i++) {
            const a = (i / clumps) * Math.PI * 2 + rand() * 0.5;
            const tilt = (rand() - 0.35) * 1.1;
            const c = [Math.cos(a) * Math.cos(tilt) * rx * 0.55, Math.sin(a) * Math.cos(tilt) * rx * 0.55, centreZ + Math.sin(tilt) * rz * 0.55 * flat];
            const r = clumpR * (0.8 + rand() * 0.4);
            clump(b, rand, c, [r, r, r * 0.85 * flat], crownCentre, leaf);
        }
    }

    function buildSpecies(id) {
        const spec = SPECIES[id];
        if (!spec) throw new Error(`unknown tree species ${id}`);
        const rand = rng(SPECIES_IDS.indexOf(id) * 7919 + 17);
        const b = createBuilder();
        const leaf = srgb(spec.leaf), bark = srgb(spec.bark);
        const branches = (fromZ, toZ, spread, count, r) => {
            for (let i = 0; i < count; i++) {
                const a = (i / count) * Math.PI * 2 + rand();
                limb(b, [0, 0, fromZ], [Math.cos(a) * spread, Math.sin(a) * spread, toZ], r, r * 0.4, 4, bark);
            }
        };
        if (id === 'linden' || id === 'chestnut' || id === 'cherry' || id === 'plane') {
            const p = {
                linden: { trunkZ: 0.42, r: 0.02, centreZ: 0.64, rx: 0.27, rz: 0.34, clumps: 7, clumpR: 0.17 },
                chestnut: { trunkZ: 0.32, r: 0.024, centreZ: 0.6, rx: 0.32, rz: 0.36, clumps: 8, clumpR: 0.19 },
                cherry: { trunkZ: 0.36, r: 0.028, centreZ: 0.64, rx: 0.36, rz: 0.3, clumps: 6, clumpR: 0.2 },
                plane: { trunkZ: 0.45, r: 0.022, centreZ: 0.67, rx: 0.32, rz: 0.31, clumps: 8, clumpR: 0.16 }
            }[id];
            limb(b, [0, 0, 0], [0, 0, p.trunkZ + 0.08], p.r, p.r * 0.75, 7, bark);
            branches(p.trunkZ, p.centreZ + 0.05, p.rx * 0.5, 3, p.r * 0.55);
            broadleafCrown(b, rand, { ...p, leaf });
            if (id === 'cherry') {
                // A few green clumps among the blossom, so the cloud is not one flat pink.
                const green = srgb(0x6f8f4a);
                for (let i = 0; i < 3; i++) {
                    const a = rand() * Math.PI * 2;
                    clump(b, rand, [Math.cos(a) * p.rx * 0.6, Math.sin(a) * p.rx * 0.6, p.centreZ - 0.08], [0.1, 0.1, 0.08], [0, 0, p.centreZ], green);
                }
            }
        } else if (id === 'spruce') {
            limb(b, [0, 0, 0], [0, 0, 0.9], 0.018, 0.006, 6, bark);
            const tiers = 7;
            for (let i = 0; i < tiers; i++) {
                const t = i / tiers;
                const baseZ = 0.1 + t * 0.78;
                tier(b, rand, baseZ, Math.min(1, baseZ + 0.26 - t * 0.06), 0.22 * (1 - t * 0.85) + 0.02, leaf);
            }
        } else if (id === 'pine') {
            // Stone pine: a tall bare trunk with a lean, forking into a flat umbrella crown.
            limb(b, [0, 0, 0], [0.04, 0, 0.6], 0.03, 0.022, 6, bark);
            [[0.16, 0.05], [-0.1, 0.12], [-0.05, -0.14]].forEach(([x, y]) => limb(b, [0.04, 0, 0.58], [x, y, 0.8], 0.016, 0.008, 4, bark));
            const crownCentre = [0, 0, 0.84];
            for (let i = 0; i < 7; i++) {
                const a = (i / 7) * Math.PI * 2 + rand() * 0.4;
                const d = i === 0 ? 0 : 0.2 + rand() * 0.06;
                const c = i === 0 ? [0, 0, 0.88] : [Math.cos(a) * d, Math.sin(a) * d, 0.82 + rand() * 0.05];
                clump(b, rand, c, [0.15, 0.15, 0.08], crownCentre, leaf);
            }
        } else if (id === 'cypress') {
            limb(b, [0, 0, 0], [0, 0, 0.2], 0.03, 0.02, 6, bark);
            const crownCentre = [0, 0, 0.55];
            for (let i = 0; i < 5; i++) {
                const z = 0.18 + i * 0.17;
                const r = 0.1 * (1 - i * 0.15) + 0.01;
                clump(b, rand, [0, 0, z], [r, r, 0.15], crownCentre, leaf);
            }
        } else if (id === 'olive') {
            // A short, thick, twisted trunk splitting into leaning limbs under a loose silvery crown.
            limb(b, [0, 0, 0], [0.03, 0.02, 0.28], 0.06, 0.045, 7, bark);
            [[0.2, 0.06], [-0.14, 0.16], [-0.06, -0.2]].forEach(([x, y]) => limb(b, [0.03, 0.02, 0.26], [x, y, 0.52], 0.03, 0.014, 5, bark));
            broadleafCrown(b, rand, { centreZ: 0.64, rx: 0.42, rz: 0.26, clumps: 6, clumpR: 0.18, leaf, flat: 0.75 });
        }
        return b.result();
    }

    // Far-tier blob placement for a tree look: { trunkHeight, crownZ, crownRadius, color } in metres
    // and linear RGB, so the blobs share the species' proportions and colour.
    function blobOf(look) {
        const spec = SPECIES[look.species];
        const h = look.heightM;
        const leaf = srgb(spec.leaf);
        return {
            trunkHeight: h * Math.max(0.15, spec.blobCrown - spec.blobRadius * 0.8),
            crownZ: h * spec.blobCrown,
            crownRadius: h * spec.blobRadius,
            crownHeight: Math.min(h * spec.blobRadius, h * (1 - spec.blobCrown) * 1.2) || h * spec.blobRadius,
            color: [leaf[0] * look.tint[0], leaf[1] * look.tint[1], leaf[2] * look.tint[2]]
        };
    }

    return Object.freeze({ SPECIES, SPECIES_IDS, MIXES, NEAR_TIER_RADIUS_M, regionOf, hash01, treeInstance, speciesForKind, nearTierMask, buildSpecies, blobOf, nearTierSize });
});
