// Birds over the 3D model view: a few flocks circling above the area in view by day, each bird a
// pair of flapping wings, all of them one InstancedMesh (one draw). Flocks belong to a 600 m cell of
// the ground (the one the camera looks at), so they stay put while the view moves within it and a
// new cell brings its own. Positions are in true metres from the scene's origin; the group is mounted with scale (k, k, 1) like the life layer, since
// the scene's XY is Mercator-inflated and its Z metric. The flight maths is pure and exported for
// tests; the wings flap in the vertex shader from a per-bird phase. UMD: window.__threeBirds,
// require()-able in node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeBirds = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const FLOCKS = 3;
    const BIRDS_PER_FLOCK = 12;
    const WING_SPAN_M = 1.8;          // a large gull's, so a bird stays visible from a few hundred metres
    const CELL_M = 600;
    const FLAP_HZ = 3.2;
    const SPEED_M_PER_S = 11;

    // A small deterministic generator (mulberry32), so a place always gets the same flocks.
    function random(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Flocks for a place: where each circles (metres from the origin), how wide, how high, which
    // way round, and each bird's place in the loose ring.
    function createFlocks(seed, count = FLOCKS, perFlock = BIRDS_PER_FLOCK) {
        const rand = random(seed);
        const flocks = [];
        for (let f = 0; f < count; f++) {
            const angle = (f / count) * Math.PI * 2 + rand() * 1.2;
            const distance = 60 + rand() * 200;
            const radius = 35 + rand() * 60;
            const birds = [];
            for (let b = 0; b < perFlock; b++) {
                birds.push({ lead: b * 0.12 + rand() * 0.08, wide: (rand() - 0.5) * 14, high: (rand() - 0.5) * 6, flap: rand() * Math.PI * 2 });
            }
            flocks.push({
                cx: Math.cos(angle) * distance, cy: Math.sin(angle) * distance,
                radius, height: 28 + rand() * 32, turn: rand() < 0.5 ? 1 : -1,
                start: rand() * Math.PI * 2, drift: 0.6 + rand() * 0.8, birds
            });
        }
        return flocks;
    }

    // One bird at time t (seconds): position (metres), heading (radians, the direction of flight)
    // and its wing phase. The ring itself wanders slowly, so the flock does not trace one circle.
    function birdPose(flock, bird, t) {
        const omega = flock.turn * SPEED_M_PER_S / flock.radius;
        const a = flock.start + omega * t - flock.turn * bird.lead;
        const r = flock.radius + bird.wide;
        const wanderX = Math.sin(t * 0.05 * flock.drift) * flock.radius * 0.8;
        const wanderY = Math.cos(t * 0.04 * flock.drift) * flock.radius * 0.8;
        return {
            x: flock.cx + wanderX + Math.cos(a) * r,
            y: flock.cy + wanderY + Math.sin(a) * r,
            z: flock.height + bird.high + Math.sin(t * 0.3 + bird.flap) * 2,
            heading: a + flock.turn * Math.PI / 2,
            flap: t * FLAP_HZ * Math.PI * 2 + bird.flap
        };
    }

    // Two wings meeting along the body (x forward, y across, z up), each a thin triangle raised
    // toward its tip (a shallow V, so a bird seen from the side is not a line); a vertex's distance
    // from the body (|y|) is how far its wing lifts on a flap.
    function wingPositions() {
        const half = WING_SPAN_M / 2;
        const lift = half * 0.25;
        return new Float32Array([
            0.3, 0, 0, -0.25, 0, 0, -0.08, half, lift,
            -0.25, 0, 0, 0.3, 0, 0, -0.08, -half, lift
        ]);
    }

    const FLAP_VERTEX = `
#include <begin_vertex>
transformed.z += abs(transformed.y) * 0.9 * sin(cbFlap);`;

    // The cell (metres from the origin) whose flocks fly over a point, and the seed they come from.
    function cellOf(x, y, seed) {
        const cx = Math.round(x / CELL_M), cy = Math.round(y / CELL_M);
        return { key: `${cx}|${cy}`, x: cx * CELL_M, y: cy * CELL_M, seed: (seed ^ Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0 };
    }

    function create(THREE, { seed = 1 } = {}) {
        let flocks = createFlocks(seed);
        let anchor = { key: null, x: 0, y: 0 };
        const count = flocks.reduce((n, flock) => n + flock.birds.length, 0);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(wingPositions(), 3));
        geometry.computeVertexNormals();
        const flapPhase = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
        flapPhase.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('cbFlap', flapPhase);
        // Near-black silhouettes: a mid grey vanished against walls and roofs.
        const material = new THREE.MeshBasicMaterial({ color: 0x1c1e22, side: THREE.DoubleSide });
        material.onBeforeCompile = shader => {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nattribute float cbFlap;')
                .replace('#include <begin_vertex>', FLAP_VERTEX);
        };
        material.customProgramCacheKey = () => 'cb-birds';
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.raycast = () => { };
        mesh.userData.noShadowCast = true;
        const group = new THREE.Group();
        group.name = 'Birds';
        group.add(mesh);
        group.visible = false;

        const dummy = new THREE.Object3D();
        // The flocks over the cell under a point (metres from the origin); true when they changed.
        function follow(x, y) {
            const cell = cellOf(x, y, seed);
            if (cell.key === anchor.key) return false;
            anchor = cell;
            flocks = createFlocks(cell.seed);
            return true;
        }

        // Places every bird for time t (seconds).
        function update(t) {
            let i = 0;
            for (const flock of flocks) {
                for (const bird of flock.birds) {
                    const pose = birdPose(flock, bird, t);
                    dummy.position.set(anchor.x + pose.x, anchor.y + pose.y, pose.z);
                    dummy.rotation.set(0, 0, pose.heading);
                    dummy.updateMatrix();
                    mesh.setMatrixAt(i, dummy.matrix);
                    flapPhase.array[i] = pose.flap % (Math.PI * 2);
                    i++;
                }
            }
            mesh.instanceMatrix.needsUpdate = true;
            flapPhase.needsUpdate = true;
        }

        // Birds fly by day: hidden once the dusk is half deep, and in photo view.
        function setShown(night, hidden) {
            const shown = !hidden && night < 0.5;
            group.visible = shown;
            return shown;
        }

        function dispose() {
            geometry.dispose();
            material.dispose();
        }

        return { group, follow, update, setShown, dispose, get visible() { return group.visible; }, count };
    }

    return { create, createFlocks, birdPose, cellOf, wingPositions, FLOCKS, BIRDS_PER_FLOCK, WING_SPAN_M, SPEED_M_PER_S, CELL_M };
});
