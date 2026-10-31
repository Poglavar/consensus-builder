// One fountain model for the 3D model view, whoever placed the fountain: the ones people put in
// squares and the ones mapped in OpenStreetMap are drawn by this same renderer, so they look and
// move alike. A fountain is a stone basin filled with water (the scene's water material, which
// reflects the sky and ripples), a column in the middle and a jet of spray rising from it that
// pulses on the weather's clock (three-atmosphere.js), on frames drawn anyway. Every fountain of a
// group is one instance of four InstancedMeshes: four draws however many fountains there are.
// Sizes follow the basin's radius in true metres; the group works in true metres and is mounted
// with scale (k, k, 1). UMD: window.__threeFountains, require()-able in node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeFountains = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // A fountain placed in a square has this basin; OSM gives its own (backend osm-street-furniture.js).
    const PLACED_RADIUS_M = 2;
    const RADIUS_LIMITS_M = [1, 15];

    // The parts of one fountain (metres, z from its ground): basin (a stone drum), water (a disc on
    // top of it, leaving a rim), column and jet.
    function fountainParts(radiusM) {
        const r = Math.min(RADIUS_LIMITS_M[1], Math.max(RADIUS_LIMITS_M[0], Number(radiusM) || PLACED_RADIUS_M));
        const basinH = 0.45;
        const columnR = 0.1 + 0.06 * r;
        const columnH = 0.45 + 0.12 * r;
        return {
            basin: { radius: r, height: basinH, z: 0 },
            water: { radius: r * 0.88, z: basinH + 0.01 },
            column: { radius: columnR, height: columnH, z: basinH },
            jet: { radius: columnR * 1.1, height: 0.9 + 0.3 * r, z: basinH + columnH }
        };
    }

    // The jet breathes: its height pulses with a phase from where the fountain stands, and its
    // spray widens toward the top as it rises.
    const JET_VERTEX = `
#include <begin_vertex>
{
    float cbPhase = dot(instanceMatrix[3].xy, vec2(0.71, 0.37));
    float cbPulse = 0.88 + 0.12 * sin(cbCloudTime * 4.2 + cbPhase) + 0.04 * sin(cbCloudTime * 11.0 + cbPhase * 2.0);
    transformed.z *= cbPulse;
    transformed.xy *= 1.0 + 0.35 * transformed.z * (1.0 - cbPulse);
}`;

    // `fountains`: [{ x, y, z?, radiusM }] in true metres from the scene's origin. `waterMaterial`:
    // the scene's water (shared, not disposed here); `clock`: three-atmosphere.js state.
    function create(THREE, { fountains, waterMaterial, clock }) {
        const list = (Array.isArray(fountains) ? fountains : []).filter(f => f && Number.isFinite(f.x) && Number.isFinite(f.y));
        const group = new THREE.Group();
        group.name = 'Fountains';
        if (!list.length) return { group, count: 0, dispose() { } };

        const drum = new THREE.CylinderGeometry(1, 1, 1, 32);
        drum.rotateX(Math.PI / 2);
        drum.translate(0, 0, 0.5);
        const disc = new THREE.CircleGeometry(1, 32);
        const cone = new THREE.CylinderGeometry(0.25, 1, 1, 12, 1, true);
        cone.rotateX(Math.PI / 2);
        cone.translate(0, 0, 0.5);
        const stone = new THREE.MeshLambertMaterial({ color: 0xc9c2b4 });
        const spray = new THREE.MeshBasicMaterial({ color: 0xf2f7fb, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
        spray.onBeforeCompile = shader => {
            shader.uniforms.cbCloudTime = clock.cbCloudTime;
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nuniform float cbCloudTime;')
                .replace('#include <begin_vertex>', JET_VERTEX);
        };
        spray.customProgramCacheKey = () => 'cb-fountain-jet';

        const meshes = {
            basin: new THREE.InstancedMesh(drum, stone, list.length),
            water: new THREE.InstancedMesh(disc, waterMaterial, list.length),
            column: new THREE.InstancedMesh(drum, stone, list.length),
            jet: new THREE.InstancedMesh(cone, spray, list.length)
        };
        const dummy = new THREE.Object3D();
        list.forEach((fountain, i) => {
            const parts = fountainParts(fountain.radiusM);
            const base = Number.isFinite(fountain.z) ? fountain.z : 0;
            const place = (mesh, x, y, z, sx, sy, sz) => {
                dummy.position.set(fountain.x, fountain.y, base + z);
                dummy.scale.set(sx, sy, sz);
                dummy.updateMatrix();
                mesh.setMatrixAt(i, dummy.matrix);
            };
            place(meshes.basin, 0, 0, parts.basin.z, parts.basin.radius, parts.basin.radius, parts.basin.height);
            place(meshes.water, 0, 0, parts.water.z, parts.water.radius, parts.water.radius, 1);
            place(meshes.column, 0, 0, parts.column.z, parts.column.radius, parts.column.radius, parts.column.height);
            place(meshes.jet, 0, 0, parts.jet.z, parts.jet.radius, parts.jet.radius, parts.jet.height);
        });
        for (const [role, mesh] of Object.entries(meshes)) {
            mesh.instanceMatrix.needsUpdate = true;
            mesh.computeBoundingSphere();
            mesh.userData.fountainPart = role;
            if (role === 'jet' || role === 'water') mesh.userData.noShadowCast = true;
            group.add(mesh);
        }
        meshes.jet.renderOrder = 8000;

        function dispose() {
            drum.dispose(); disc.dispose(); cone.dispose();
            stone.dispose(); spray.dispose();
        }
        return { group, count: list.length, meshes, dispose };
    }

    return { create, fountainParts, PLACED_RADIUS_M };
});
