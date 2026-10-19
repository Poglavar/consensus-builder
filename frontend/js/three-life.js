// Life renderer for the 3D model view: draws a life-agents simulation (life/life-agents.js) as a
// handful of InstancedMesh draws — vehicle bodies, glass and wheels; person heads, bodies, arms and
// legs — and advances it from three-mode's frame hook. The group works in TRUE metres and is mounted
// with scale (k, k, 1) because the scene's XY is Mercator-inflated while Z is metric. Matrix writes go
// straight into the instance attribute arrays; the matrix maths is pure and exported for tests.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeLife = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const LIMB_SWING_RAD = 0.55;     // Station3D's walk-cycle amplitude
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
            const tyre = v.kind === 'bus' ? 0.3 : 0.22;
            const y = v.width / 2 - tyre / 2;
            parts.wheels.push(
                { ox: v.frontAxle, oy: y, oz: r, r, w: tyre, steers: true }, { ox: v.frontAxle, oy: -y, oz: r, r, w: tyre, steers: true },
                { ox: -v.rearAxle, oy: y, oz: r, r, w: tyre }, { ox: -v.rearAxle, oy: -y, oz: r, r, w: tyre });
        }
        return parts;
    }

    // Person part placement for a figure of height h with a given limb swing (radians).
    function personParts(h, swing) {
        const g = h / 1.75;
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
                legs: instanced(geometries.limb, materials.tinted, figures * 2)
            };
            vehicles.forEach((v, i) => meshes.bodies.setColorAt(i, color.setHex(v.color)));
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
            writeAll();
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
            });
            sim.people.forEach((p, i) => {
                const swing = Math.sin(p.stride) * LIMB_SWING_RAD * (p.amp == null ? 1 : p.amp);
                writeFigure(i, p.x, p.y, p.z, p.heading, personParts(p.height, swing));
            });
            Object.values(m).forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
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
        }

        return {
            group, setSimulation, onFrame, clear, dispose,
            stats: () => ({
                frameMs: lastFrameMs, simMs: lastSimMs, drawCalls: meshes ? Object.keys(meshes).length : 0,
                vehicles: sim ? sim.vehicles.length : 0, people: sim ? sim.people.length : 0
            })
        };
    }

    return { create, writeMatrix, writeHidden, vehicleParts, personParts, riderParts, LIMB_SWING_RAD };
});
