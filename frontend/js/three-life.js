// Life renderer for the 3D model view: draws a life-agents simulation (life/life-agents.js) as a
// handful of InstancedMesh draws — vehicle bodies, glass and wheels; person heads, bodies, arms and
// legs; dogs (body and muzzle, head, legs, ears, tail and lead); at dusk and night headlamps, tail lamps and the pool of light ahead of each vehicle — and
// advances it from three-mode's frame hook. The group works in TRUE metres and is mounted
// with scale (k, k, 1) because the scene's XY is Mercator-inflated while Z is metric. Matrix writes go
// straight into the instance attribute arrays; the matrix maths is pure and exported for tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeLife = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const LIMB_SWING_RAD = 0.55;     // Station3D's walk-cycle amplitude
    const DOG_SWING_RAD = 0.35;      // a trot's leg swing
    const MAX_FRAME_DT_S = 0.1;      // a long stall never teleports agents

    // Writes M = T(p) · Rz(yaw) · T(o) · Ry(a) · S(s) into `target` (column-major, three.js layout)
    // at element `offset`. `o` is an offset in the agent's own frame (x forward, y left, z up) and
    // `a` a swing about the local Y axis, which is what hanging limbs need.
    function writeMatrix(target, offset, px, py, pz, yaw, a, sx, sy, sz, ox, oy, oz) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const ca = Math.cos(a), sa = Math.sin(a);
        target[offset + 0] = c * ca * sx; target[offset + 1] = s * ca * sx; target[offset + 2] = -sa * sx; target[offset + 3] = 0;
        target[offset + 4] = -s * sy; target[offset + 5] = c * sy; target[offset + 6] = 0; target[offset + 7] = 0;
        target[offset + 8] = c * sa * sz; target[offset + 9] = s * sa * sz; target[offset + 10] = ca * sz; target[offset + 11] = 0;
        target[offset + 12] = px + c * ox - s * oy; target[offset + 13] = py + s * ox + c * oy; target[offset + 14] = pz + oz; target[offset + 15] = 1;
    }

    function writeHidden(target, offset) {
        for (let i = 0; i < 16; i++) target[offset + i] = 0;
    }

    // Vehicle part placement (metres, vehicle frame). Pure so the proportions can be unit-tested.
    // 4 cm: the depth buffer separates it to about 600 m away, where a car is a few pixels.
    const TYRE_INSET_M = 0.04;
    function vehicleParts(v) {
        const parts = { body: null, glass: null, wheels: [], rider: null };
        if (v.kind === 'bus') {
            // Full-height body with a window band standing a hair proud of the sides.
            parts.body = { ox: 0, oy: 0, oz: v.clearance, sx: v.len, sy: v.width, sz: v.height - v.clearance };
            parts.glass = { ox: 0, oy: 0, oz: 1.3, sx: v.len * 0.86, sy: v.width * 1.02, sz: v.height - 1.65 };
        } else if (v.kind === 'car') {
            // Lower body up to the waistline, dark cabin on top: the classic two-box silhouette.
            const waist = 0.88;
            parts.body = { ox: 0, oy: 0, oz: v.clearance, sx: v.len, sy: v.width, sz: waist - v.clearance };
            parts.glass = { ox: -0.08 * v.len, oy: 0, oz: waist, sx: v.len * 0.5, sy: v.width * 0.92, sz: v.height - waist };
        } else {
            parts.body = { ox: 0, oy: 0, oz: v.clearance, sx: v.len, sy: v.width, sz: v.height - v.clearance };
        }
        const r = v.wheelRadius;
        if (v.kind === 'moto') {
            parts.wheels.push({ ox: v.frontAxle, oy: 0, oz: r, r, w: 0.12, steers: true }, { ox: -v.rearAxle, oy: 0, oz: r, r, w: 0.12 });
            parts.rider = true;
        } else {
            // The axles where the simulation steers them from (VEHICLE_KINDS frontAxle/rearAxle).
            // The tyre's outer face sits TYRE_INSET_M inside the body's side: flush with it, the two
            // faces were coplanar where the wheel rises into the body, and they fought.
            const tyre = v.kind === 'bus' ? 0.3 : 0.22;
            const y = v.width / 2 - tyre / 2 - TYRE_INSET_M;
            parts.wheels.push(
                { ox: v.frontAxle, oy: y, oz: r, r, w: tyre, steers: true }, { ox: v.frontAxle, oy: -y, oz: r, r, w: tyre, steers: true },
                { ox: -v.rearAxle, oy: y, oz: r, r, w: tyre }, { ox: -v.rearAxle, oy: -y, oz: r, r, w: tyre });
        }
        return parts;
    }

    // Person part placement for a figure of height h with a given limb swing (radians). A child is
    // not a scaled adult: for its height it has a bigger head, a shorter leg and a deeper body.
    function personParts(h, swing, child = false) {
        const g = h / 1.75;
        if (child) {
            return {
                body: { ox: 0, oy: 0, oz: 0.70 * g, a: 0, sx: 0.15 * g, sy: 0.20 * g, sz: 0.70 * g },
                head: { ox: 0, oy: 0, oz: 1.58 * g, a: 0, sx: 0.15 * g, sy: 0.15 * g, sz: 0.165 * g },
                legs: [
                    { ox: 0, oy: 0.10 * g, oz: 0.70 * g, a: swing, sx: 0.075 * g, sy: 0.075 * g, sz: 0.70 * g },
                    { ox: 0, oy: -0.10 * g, oz: 0.70 * g, a: -swing, sx: 0.075 * g, sy: 0.075 * g, sz: 0.70 * g }
                ],
                arms: [
                    { ox: 0, oy: 0.25 * g, oz: 1.33 * g, a: -swing * 0.8, sx: 0.05 * g, sy: 0.05 * g, sz: 0.52 * g },
                    { ox: 0, oy: -0.25 * g, oz: 1.33 * g, a: swing * 0.8, sx: 0.05 * g, sy: 0.05 * g, sz: 0.52 * g }
                ]
            };
        }
        return {
            body: { ox: 0, oy: 0, oz: 0.80 * g, a: 0, sx: 0.14 * g, sy: 0.19 * g, sz: 0.68 * g },
            head: { ox: 0, oy: 0, oz: 1.62 * g, a: 0, sx: 0.11 * g, sy: 0.11 * g, sz: 0.12 * g },
            legs: [
                { ox: 0, oy: 0.10 * g, oz: 0.80 * g, a: swing, sx: 0.075 * g, sy: 0.075 * g, sz: 0.80 * g },
                { ox: 0, oy: -0.10 * g, oz: 0.80 * g, a: -swing, sx: 0.075 * g, sy: 0.075 * g, sz: 0.80 * g }
            ],
            arms: [
                { ox: 0, oy: 0.24 * g, oz: 1.45 * g, a: -swing * 0.8, sx: 0.05 * g, sy: 0.05 * g, sz: 0.62 * g },
                { ox: 0, oy: -0.24 * g, oz: 1.45 * g, a: swing * 0.8, sx: 0.05 * g, sy: 0.05 * g, sz: 0.62 * g }
            ]
        };
    }

    // A rider sits on the saddle leaning forward, arms to the bars, thighs forward.
    function riderParts() {
        return {
            // The torso stands up from the saddle (geometry z 0..1), so a positive swing leans it
            // forward; limbs hang from their pivot (z −1..0), so theirs is negative to swing forward.
            body: { ox: -0.1, oy: 0, oz: 0.85, a: 0.25, sx: 0.16, sy: 0.2, sz: 0.62 },
            head: { ox: 0.08, oy: 0, oz: 1.57, a: 0, sx: 0.11, sy: 0.11, sz: 0.12 },
            legs: [
                { ox: -0.05, oy: 0.33, oz: 0.85, a: -1.2, sx: 0.07, sy: 0.07, sz: 0.45 },
                { ox: -0.05, oy: -0.33, oz: 0.85, a: -1.2, sx: 0.07, sy: 0.07, sz: 0.45 }
            ],
            arms: [
                { ox: 0.05, oy: 0.2, oz: 1.39, a: -1.3, sx: 0.045, sy: 0.045, sz: 0.55 },
                { ox: 0.05, oy: -0.2, oz: 1.39, a: -1.3, sx: 0.045, sy: 0.045, sz: 0.55 }
            ]
        };
    }

    // Lamps on a vehicle (metres, vehicle frame; box parts with z from oz up): two headlamps on the
    // front face and two tail lamps on the back, one of each on a motorcycle. Each stands a few
    // centimetres proud of the body so it is never buried in it.
    const LAMP_DEPTH_M = 0.06;
    function vehicleLamps(v) {
        const front = v.len / 2 + LAMP_DEPTH_M / 2 - 0.01;
        const back = -front;
        if (v.kind === 'moto') {
            return [
                { ox: front, oy: 0, oz: 0.72, sx: LAMP_DEPTH_M, sy: 0.16, sz: 0.14, head: true },
                { ox: back, oy: 0, oz: 0.7, sx: LAMP_DEPTH_M, sy: 0.12, sz: 0.08, head: false }
            ];
        }
        const bus = v.kind === 'bus';
        const y = v.width / 2 - (bus ? 0.35 : 0.3);
        const headZ = bus ? 0.75 : 0.6;
        const tailZ = bus ? 0.9 : 0.66;
        return [
            { ox: front, oy: y, oz: headZ, sx: LAMP_DEPTH_M, sy: 0.3, sz: 0.14, head: true },
            { ox: front, oy: -y, oz: headZ, sx: LAMP_DEPTH_M, sy: 0.3, sz: 0.14, head: true },
            { ox: back, oy: y, oz: tailZ, sx: LAMP_DEPTH_M, sy: 0.22, sz: 0.14, head: false },
            { ox: back, oy: -y, oz: tailZ, sx: LAMP_DEPTH_M, sy: 0.22, sz: 0.14, head: false }
        ];
    }
    const LAMPS_PER_VEHICLE = 4;

    // The pool of headlight on the road ahead: a flat patch from the front bumper, `sx` long and
    // `sy` wide at its far end (the pool geometry spans x 0…1 and y ±0.5), just above the road.
    function headlightPool(v) {
        if (v.kind === 'moto') return { ox: v.len / 2, oy: 0, oz: 0.03, sx: 11, sy: 4.5 };
        if (v.kind === 'bus') return { ox: v.len / 2, oy: 0, oz: 0.03, sx: 18, sy: 8 };
        return { ox: v.len / 2, oy: 0, oz: 0.03, sx: 16, sy: 7 };
    }

    // Alpha of the pool texture, `size`×`size`, row-major with u (forward, 0 at the bumper) along a
    // row and v across: a beam widening from the lamps, brightest a few metres out and fading to
    // nothing at its far end and sides. Values 0…1.
    function poolAlpha(size) {
        const out = new Float32Array(size * size);
        const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
        for (let row = 0; row < size; row++) {
            const v = (row + 0.5) / size;
            for (let col = 0; col < size; col++) {
                const u = (col + 0.5) / size;
                const halfWidth = 0.18 + 0.32 * u;
                const across = Math.abs(v - 0.5) / halfWidth;
                const side = 1 - smooth(0.55, 1, across);
                const along = smooth(0, 0.12, u) * Math.pow(1 - u, 1.6);
                out[row * size + col] = side * along;
            }
        }
        return out;
    }
    const POOL_TEXTURE_SIZE = 64;
    const POOL_OPACITY = 0.45;          // at full night
    const HEADLAMP_COLOR = 0xfff3d6;
    const TAIL_LAMP_COLOR = 0xff2a1a;

    // Dog part placement (metres, dog frame: x forward, z up from the ground under its body) for a
    // dog of the simulation (life-agents.js DOG_BREEDS sizes) with a given leg swing. The body and
    // the muzzle are columns lying along x (a = π/2); legs, ears and tail are limbs hanging from
    // their pivot (a = 0 down, π up). Legs move in diagonal pairs, as in a trot. `nose` (0…1) lowers
    // the head to sniff; the tail carries its own yaw (`yaw`, the wag) about its root.
    function dogParts(d, swing) {
        const nose = d.nose || 0;
        const bodyZ = d.legM + d.depthM / 2;
        const headX = d.bodyM / 2 + d.headM * 0.4;
        const headZ = d.legM + d.depthM + d.headM * 0.6 - nose * (d.depthM * 0.7 + d.headM * 0.6);
        const legPivot = d.legM + d.depthM * 0.25;
        const legR = Math.max(0.018, d.widthM * 0.16);
        const legX = d.bodyM * 0.36, legY = d.widthM * 0.3;
        const ears = [1, -1].map(side => d.earsUp
            ? { ox: headX - d.headM * 0.2, oy: side * d.headM * 0.5, oz: headZ + d.headM * 0.55, a: Math.PI, sx: d.earM * 0.25, sy: d.earM * 0.3, sz: d.earM }
            : { ox: headX - d.headM * 0.1, oy: side * d.headM * 0.85, oz: headZ + d.headM * 0.4, a: 0.15, sx: d.earM * 0.4, sy: 0.015, sz: d.earM });
        return {
            body: { ox: -d.bodyM / 2, oy: 0, oz: bodyZ, a: Math.PI / 2, sx: d.depthM / 2, sy: d.widthM / 2, sz: d.bodyM },
            head: { ox: headX, oy: 0, oz: headZ, a: 0, sx: d.headM * 1.1, sy: d.headM, sz: d.headM },
            snout: { ox: headX + d.headM * 0.5, oy: 0, oz: headZ - d.headM * 0.25, a: Math.PI / 2 + nose * 0.6, sx: d.headM * 0.5, sy: d.headM * 0.45, sz: d.snoutM },
            legs: [
                { ox: legX, oy: legY, oz: legPivot, a: swing, sx: legR, sy: legR, sz: legPivot },
                { ox: legX, oy: -legY, oz: legPivot, a: -swing, sx: legR, sy: legR, sz: legPivot },
                { ox: -legX, oy: legY, oz: legPivot, a: -swing, sx: legR, sy: legR, sz: legPivot },
                { ox: -legX, oy: -legY, oz: legPivot, a: swing, sx: legR, sy: legR, sz: legPivot }
            ],
            ears,
            tail: { ox: -d.bodyM / 2, oy: 0, oz: d.legM + d.depthM * 0.85, a: Math.PI / 2 + d.tailRad, yaw: Math.sin(d.wag || 0) * 0.5,
                sx: Math.max(0.015, d.widthM * 0.1), sy: Math.max(0.015, d.widthM * 0.1), sz: d.tailM },
            collar: { ox: d.bodyM / 2, oy: 0, oz: d.legM + d.depthM * 0.85 }
        };
    }

    // The lead from the walker's hand on the dog's side to the dog's collar, as a hanging limb:
    // pivot at the hand, yawed to face away from the dog so a positive swing `a` points it there.
    function leashSegment(owner, dog, collar) {
        const g = owner.height / 1.75;
        const side = dog.side || 1;
        const c = Math.cos(owner.heading), s = Math.sin(owner.heading);
        const hx = owner.x + c * 0.1 * g - s * side * 0.27 * g, hy = owner.y + s * 0.1 * g + c * side * 0.27 * g, hz = owner.z + 0.85 * g;
        const dc = Math.cos(dog.heading), ds = Math.sin(dog.heading);
        const cx = dog.x + dc * collar.ox - ds * collar.oy, cy = dog.y + ds * collar.ox + dc * collar.oy, cz = dog.z + collar.oz;
        const dx = cx - hx, dy = cy - hy, dz = cz - hz;
        const h = Math.hypot(dx, dy);
        return { x: hx, y: hy, z: hz, yaw: Math.atan2(dy, dx) + Math.PI, a: Math.atan2(h, -dz), len: Math.hypot(h, dz) };
    }
    const LEASH_COLOR = 0x7a1f1f;
    const LEASH_RADIUS_M = 0.008;
    const DOG_LIMBS = 8;   // four legs, two ears, the tail and the lead

    const RIDER_SKIN = [0xf1c9a5, 0xe0ac69, 0xc68642, 0x8d5524];
    const RIDER_SHIRT = [0x1f1f1f, 0x2f4f7f, 0x8b1e3f, 0x5b5b5b];

    function create(options) {
        const THREE = options.THREE;
        const group = new THREE.Group();
        group.name = 'Life';
        group.scale.set(options.k || 1, options.k || 1, 1);

        const geometries = {
            box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
            column: new THREE.CylinderGeometry(1, 1, 1, 10).rotateX(Math.PI / 2).translate(0, 0, 0.5),
            limb: new THREE.CylinderGeometry(1, 1, 1, 7).rotateX(Math.PI / 2).translate(0, 0, -0.5),
            head: new THREE.SphereGeometry(1, 10, 8),
            wheel: new THREE.CylinderGeometry(1, 1, 1, 10)
        };
        const materials = {
            tinted: new THREE.MeshLambertMaterial({ color: 0xffffff }),
            glass: new THREE.MeshLambertMaterial({ color: 0x1b2a3a }),
            wheel: new THREE.MeshLambertMaterial({ color: 0x1c1c1c })
        };
        // Lamps glow regardless of the scene's light; the pool adds light to whatever road it lies on.
        materials.lamp = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
        const poolTexels = poolAlpha(POOL_TEXTURE_SIZE);
        const poolData = new Uint8Array(poolTexels.length * 4);
        poolTexels.forEach((value, i) => poolData.fill(Math.round(value * 255), i * 4, i * 4 + 4));
        const poolTexture = new THREE.DataTexture(poolData, POOL_TEXTURE_SIZE, POOL_TEXTURE_SIZE, THREE.RGBAFormat);
        poolTexture.magFilter = THREE.LinearFilter;
        poolTexture.minFilter = THREE.LinearFilter;
        poolTexture.needsUpdate = true;
        materials.pool = new THREE.MeshBasicMaterial({
            color: HEADLAMP_COLOR, alphaMap: poolTexture, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false
        });
        // Light on the ground: over it, behind building faces (three-ground.js), like a design's ground.
        ((typeof window !== 'undefined' && window.__threeGround) || require('./three-ground.js')).designSurface(materials.pool, 2);
        geometries.pool = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
        let night = 0;

        let sim = null;
        let meshes = null;
        let lastNow = 0;
        let lastFrameMs = 0;
        let lastSimMs = 0;
        const color = new THREE.Color();

        function instanced(geometry, material, count) {
            const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
            mesh.frustumCulled = false;   // instances move every frame; the group is small
            mesh.count = Math.max(1, count);
            for (let i = 0; i < mesh.count; i++) writeHidden(mesh.instanceMatrix.array, i * 16);
            mesh.instanceMatrix.needsUpdate = true;
            mesh.userData.isLife = true;
            return mesh;
        }

        function clear() {
            if (meshes) {
                Object.values(meshes).forEach(mesh => { group.remove(mesh); try { mesh.dispose(); } catch (_) { } });
            }
            meshes = null;
            sim = null;
        }

        // Allocate instance buffers for this simulation's population and paint the fixed colours.
        function setSimulation(nextSim) {
            clear();
            sim = nextSim;
            if (!sim) return;
            const vehicles = sim.vehicles;
            const people = sim.people;
            const riders = vehicles.filter(v => v.kind === 'moto');
            const figures = people.length + riders.length;
            meshes = {
                bodies: instanced(geometries.box, materials.tinted, vehicles.length),
                glass: instanced(geometries.box, materials.glass, vehicles.length),
                wheels: instanced(geometries.wheel, materials.wheel, vehicles.length * 4),
                heads: instanced(geometries.head, materials.tinted, figures),
                torsos: instanced(geometries.column, materials.tinted, figures),
                arms: instanced(geometries.limb, materials.tinted, figures * 2),
                legs: instanced(geometries.limb, materials.tinted, figures * 2),
                lamps: instanced(geometries.box, materials.lamp, vehicles.length * LAMPS_PER_VEHICLE),
                pools: instanced(geometries.pool, materials.pool, vehicles.length)
            };
            meshes.pools.renderOrder = 1;
            const dogs = sim.dogs || [];
            if (dogs.length) {
                meshes.dogTrunks = instanced(geometries.column, materials.tinted, dogs.length * 2);
                meshes.dogHeads = instanced(geometries.head, materials.tinted, dogs.length);
                meshes.dogLimbs = instanced(geometries.limb, materials.tinted, dogs.length * DOG_LIMBS);
                dogs.forEach((d, i) => {
                    meshes.dogTrunks.setColorAt(i * 2, color.setHex(d.coat.body));
                    meshes.dogTrunks.setColorAt(i * 2 + 1, color.setHex(d.coat.head));
                    meshes.dogHeads.setColorAt(i, color.setHex(d.coat.head));
                    const limbColors = [d.coat.legs, d.coat.legs, d.coat.legs, d.coat.legs, d.coat.head, d.coat.head, d.coat.body, LEASH_COLOR];
                    limbColors.forEach((hex, slot) => meshes.dogLimbs.setColorAt(i * DOG_LIMBS + slot, color.setHex(hex)));
                });
            }
            vehicles.forEach((v, i) => {
                meshes.bodies.setColorAt(i, color.setHex(v.color));
                for (let slot = 0; slot < LAMPS_PER_VEHICLE; slot++) {
                    meshes.lamps.setColorAt(i * LAMPS_PER_VEHICLE + slot, color.setHex(slot < 2 ? HEADLAMP_COLOR : TAIL_LAMP_COLOR));
                }
            });
            people.forEach((p, i) => {
                meshes.heads.setColorAt(i, color.setHex(p.colors.skin));
                meshes.torsos.setColorAt(i, color.setHex(p.colors.shirt));
                meshes.arms.setColorAt(i * 2, color.setHex(p.colors.shirt));
                meshes.arms.setColorAt(i * 2 + 1, color.setHex(p.colors.shirt));
                meshes.legs.setColorAt(i * 2, color.setHex(p.colors.legs));
                meshes.legs.setColorAt(i * 2 + 1, color.setHex(p.colors.legs));
            });
            riders.forEach((v, j) => {
                const i = people.length + j;
                const skin = RIDER_SKIN[v.id % RIDER_SKIN.length];
                const shirt = RIDER_SHIRT[(v.id * 7) % RIDER_SHIRT.length];
                meshes.heads.setColorAt(i, color.setHex(skin));
                meshes.torsos.setColorAt(i, color.setHex(shirt));
                meshes.arms.setColorAt(i * 2, color.setHex(shirt));
                meshes.arms.setColorAt(i * 2 + 1, color.setHex(shirt));
                meshes.legs.setColorAt(i * 2, color.setHex(0x2b2b3a));
                meshes.legs.setColorAt(i * 2 + 1, color.setHex(0x2b2b3a));
            });
            Object.values(meshes).forEach(mesh => {
                if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
                group.add(mesh);
            });
            lastNow = 0;
            applyNight();
            writeAll();
        }

        function applyNight() {
            if (!meshes) return;
            meshes.lamps.visible = night > 0;
            meshes.pools.visible = night > 0;
            materials.pool.opacity = POOL_OPACITY * night;
        }

        // How dark it is, 0 (day: no lamps, nothing drawn) … 1 (night: full beams).
        function setNight(strength) {
            const next = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
            if (next === night) return;
            const switchedOn = night === 0 && next > 0;
            night = next;
            applyNight();
            if (switchedOn) writeAll();
        }

        // Lamps and pools ride on the vehicle; written only while they are shown.
        function writeLamps(v, i) {
            const lamps = meshes.lamps.instanceMatrix.array;
            const parts = vehicleLamps(v);
            for (let slot = 0; slot < LAMPS_PER_VEHICLE; slot++) {
                const offset = (i * LAMPS_PER_VEHICLE + slot) * 16;
                // A motorcycle's two lamps fill the head slot 0 and the tail slot 2.
                const lamp = v.kind === 'moto' ? (slot === 0 ? parts[0] : slot === 2 ? parts[1] : null) : parts[slot];
                if (!lamp) { writeHidden(lamps, offset); continue; }
                writeMatrix(lamps, offset, v.x, v.y, v.z, v.heading, 0, lamp.sx, lamp.sy, lamp.sz, lamp.ox, lamp.oy, lamp.oz);
            }
            const pool = headlightPool(v);
            writeMatrix(meshes.pools.instanceMatrix.array, i * 16, v.x, v.y, v.z, v.heading, 0, pool.sx, pool.sy, 1, pool.ox, pool.oy, pool.oz);
        }

        function writeFigure(index, x, y, z, yaw, parts) {
            const m = meshes;
            writeMatrix(m.torsos.instanceMatrix.array, index * 16, x, y, z, yaw, parts.body.a, parts.body.sx, parts.body.sy, parts.body.sz, parts.body.ox, parts.body.oy, parts.body.oz);
            writeMatrix(m.heads.instanceMatrix.array, index * 16, x, y, z, yaw, parts.head.a, parts.head.sx, parts.head.sy, parts.head.sz, parts.head.ox, parts.head.oy, parts.head.oz);
            for (let side = 0; side < 2; side++) {
                const leg = parts.legs[side], arm = parts.arms[side];
                const slot = (index * 2 + side) * 16;
                writeMatrix(m.legs.instanceMatrix.array, slot, x, y, z, yaw, leg.a, leg.sx, leg.sy, leg.sz, leg.ox, leg.oy, leg.oz);
                writeMatrix(m.arms.instanceMatrix.array, slot, x, y, z, yaw, arm.a, arm.sx, arm.sy, arm.sz, arm.ox, arm.oy, arm.oz);
            }
        }

        function writePart(mesh, index, x, y, z, yaw, part) {
            if (part.yaw) {
                // A part with its own yaw (the tail's wag) turns about its root: place the root, then yaw there.
                const c = Math.cos(yaw), s = Math.sin(yaw);
                writeMatrix(mesh.instanceMatrix.array, index * 16, x + c * part.ox - s * part.oy, y + s * part.ox + c * part.oy, z, yaw + part.yaw, part.a, part.sx, part.sy, part.sz, 0, 0, part.oz);
            } else {
                writeMatrix(mesh.instanceMatrix.array, index * 16, x, y, z, yaw, part.a, part.sx, part.sy, part.sz, part.ox, part.oy, part.oz);
            }
        }

        function writeDogs() {
            const dogs = sim.dogs || [];
            if (!dogs.length || !meshes.dogTrunks) return;
            const m = meshes;
            dogs.forEach((d, i) => {
                const parts = dogParts(d, Math.sin(d.stride) * DOG_SWING_RAD * d.amp);
                writePart(m.dogTrunks, i * 2, d.x, d.y, d.z, d.heading, parts.body);
                writePart(m.dogTrunks, i * 2 + 1, d.x, d.y, d.z, d.heading, parts.snout);
                writePart(m.dogHeads, i, d.x, d.y, d.z, d.heading, parts.head);
                const base = i * DOG_LIMBS;
                parts.legs.forEach((leg, k) => writePart(m.dogLimbs, base + k, d.x, d.y, d.z, d.heading, leg));
                writePart(m.dogLimbs, base + 4, d.x, d.y, d.z, d.heading, parts.ears[0]);
                writePart(m.dogLimbs, base + 5, d.x, d.y, d.z, d.heading, parts.ears[1]);
                writePart(m.dogLimbs, base + 6, d.x, d.y, d.z, d.heading, parts.tail);
                const lead = leashSegment(sim.people[d.owner], d, parts.collar);
                writeMatrix(m.dogLimbs.instanceMatrix.array, (base + 7) * 16, lead.x, lead.y, lead.z, lead.yaw, lead.a, LEASH_RADIUS_M, LEASH_RADIUS_M, lead.len, 0, 0, 0);
            });
        }

        function writeAll() {
            if (!sim || !meshes) return;
            const m = meshes;
            const bodies = m.bodies.instanceMatrix.array;
            const glass = m.glass.instanceMatrix.array;
            const wheels = m.wheels.instanceMatrix.array;
            let riderIndex = sim.people.length;
            const rider = riderParts();
            sim.vehicles.forEach((v, i) => {
                const parts = vehicleParts(v);
                const b = parts.body;
                writeMatrix(bodies, i * 16, v.x, v.y, v.z, v.heading, 0, b.sx, b.sy, b.sz, b.ox, b.oy, b.oz);
                if (parts.glass) {
                    const gl = parts.glass;
                    writeMatrix(glass, i * 16, v.x, v.y, v.z, v.heading, 0, gl.sx, gl.sy, gl.sz, gl.ox, gl.oy, gl.oz);
                } else {
                    writeHidden(glass, i * 16);
                }
                for (let w = 0; w < 4; w++) {
                    const slot = (i * 4 + w) * 16;
                    const wheel = parts.wheels[w];
                    if (!wheel) { writeHidden(wheels, slot); continue; }
                    // A steered wheel turns about its own hub, so place the hub on the body and yaw it there.
                    const c = Math.cos(v.heading), s = Math.sin(v.heading);
                    const yaw = v.heading + (wheel.steers ? v.steer || 0 : 0);
                    writeMatrix(wheels, slot, v.x + c * wheel.ox - s * wheel.oy, v.y + s * wheel.ox + c * wheel.oy, v.z, yaw, 0, wheel.r, wheel.w, wheel.r, 0, 0, wheel.oz);
                }
                if (parts.rider) { writeFigure(riderIndex, v.x, v.y, v.z, v.heading, rider); riderIndex++; }
                if (night > 0) writeLamps(v, i);
            });
            sim.people.forEach((p, i) => {
                const swing = Math.sin(p.stride) * LIMB_SWING_RAD * (p.amp == null ? 1 : p.amp) * (p.swing == null ? 1 : p.swing);
                writeFigure(i, p.x, p.y, p.z, p.heading, personParts(p.height, swing, !!p.child));
            });
            writeDogs();
            // Hidden lamps are not rewritten, so they need no upload either.
            Object.values(m).forEach(mesh => { if (mesh.visible) mesh.instanceMatrix.needsUpdate = true; });
        }

        // Frame hook body: advance the simulation by real elapsed time (clamped) and rewrite poses.
        function onFrame(now) {
            if (!sim || !meshes) return 0;
            const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const dt = lastNow ? Math.min(MAX_FRAME_DT_S, Math.max(0, (now - lastNow) / 1000)) : 1 / 60;
            lastNow = now;
            sim.step(dt);
            const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            writeAll();
            const t2 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            lastSimMs = t1 - t0;
            lastFrameMs = t2 - t0;
            return lastFrameMs;
        }

        function dispose() {
            clear();
            Object.values(geometries).forEach(g => { try { g.dispose(); } catch (_) { } });
            Object.values(materials).forEach(mat => { try { mat.dispose(); } catch (_) { } });
            try { poolTexture.dispose(); } catch (_) { }
        }

        return {
            group, setSimulation, setNight, onFrame, clear, dispose,
            stats: () => ({
                frameMs: lastFrameMs, simMs: lastSimMs, drawCalls: meshes ? Object.values(meshes).filter(mesh => mesh.visible).length : 0,
                vehicles: sim ? sim.vehicles.length : 0, people: sim ? sim.people.length : 0, dogs: sim && sim.dogs ? sim.dogs.length : 0
            })
        };
    }

    return { create, writeMatrix, writeHidden, vehicleParts, vehicleLamps, headlightPool, poolAlpha, personParts, riderParts, dogParts, leashSegment, LIMB_SWING_RAD, DOG_SWING_RAD };
});
