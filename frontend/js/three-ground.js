// Ground renderer for the 3D model view: uploads the ground-geometry parts (life/ground-geometry.js)
// in TRUE metres, mounted with scale (k, k, 1) like the life layer, because the scene's XY is
// Mercator-inflated while Z is metric. The roadbed is sunk a kerb below the pavement, so the pavement
// plane and the parcel slabs need holes over it: the roadbed's lid (the same triangles at pavement
// level) is drawn first into the stencil buffer only, and every pavement-level material skips the
// pixels it marked (`cutHoles`). Parcels mark their coverage too so the background never competes
// with their coplanar triangles. Depth sorts the rest: the kerb walls show on the far side of a
// street, the near pavement edge hides the floor behind it. Lane lines are flat strips just above
// the asphalt; the pavement (and, in three-mode, the cadastral road parcels) carries a procedural
// paving pattern in its shader instead of a texture image. Five draw calls, no per-frame work.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeGround = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Pavement sits a shade under the 0xdddddd parcel slabs so a plot still reads as a plot on it;
    // asphalt is darker than the 0xb0b0b0 road parcels so a street reads as a street; the kerb is
    // darker than both, because a sunlit vertical face renders brighter than a flat one and a
    // light kerb read as a white line instead of a step.
    const COLORS = Object.freeze({ pavement: 0xcdccc8, asphalt: 0x5b5d61, kerb: 0x8e8c87, markings: 0xe9e7df });
    // Every ground surface is pushed back further than building faces (three-mode.js
    // makeBuildingMaterial pushes them by factor 1, units 1 so their edge lines stay in front). At
    // the same push or none, the faces' push put the foot of a wall seen at an angle behind the
    // paving, which covered its bottom pixels in a band that moved with every zoom and pan. Ground
    // surfaces are layered among themselves by stencil claims (ORDER), so the push leaves that alone.
    // Lane lines sit 1 cm over the asphalt and are pulled forward of it so they never sink into it at distance.
    // A design's ground (designSurface) lies over the city's ground and still behind every building
    // face: ranks 1..MAX_DESIGN_RANK sit between the faces (1) and the city's ground (OFFSET.ground).
    const OFFSET = Object.freeze({ ground: 8, markings: -1 });
    const MAX_DESIGN_RANK = OFFSET.ground - 3;
    function behindBuildings(material, extra = 0) {
        material.polygonOffset = true;
        material.polygonOffsetFactor = OFFSET.ground + extra;
        material.polygonOffsetUnits = OFFSET.ground + extra;
        return material;
    }
    // A design's ground surface: a park's lawn and water, a square's paving, a plot's fill, a site's
    // sidewalk, earth under construction, the light a lamp casts on the ground. Such surfaces used to
    // be pulled toward the camera (negative offsets), which put them in front of building faces too,
    // so they covered the foot of every wall standing on them by a band that changed with the zoom.
    // `rank` (1..MAX_DESIGN_RANK) keeps their order among themselves: a higher rank lies nearer.
    function designSurface(material, rank) {
        const r = Math.min(MAX_DESIGN_RANK, Math.max(1, Math.round(Number(rank) || 1)));
        return behindBuildings(material, -r);
    }
    // Procedural paving: slabs this big, a thin darker joint between them and a faint per-slab tint.
    const PAVE_SLAB_M = 1.5;
    // Runs after Lambert's colour setup. `vPaveXY` is the local XY in metres; the joint is
    // anti-aliased over one pixel (fwidth) and its weight shrinks as a pixel outgrows the joint, so
    // distant pavement settles to a flat tone instead of moiré.
    const PAVE_FRAGMENT = [
        '{',
        '    vec2 slab = vPaveXY / uPaveSlab;',
        '    vec2 cell = floor(slab);',
        '    vec2 edge = abs(fract(slab) - 0.5);',
        '    vec2 px = fwidth(slab);',
        '    vec2 joint = smoothstep(vec2(0.47) - px, vec2(0.47), edge);',
        '    float j = max(joint.x, joint.y) * clamp(0.06 / max(max(px.x, px.y), 1e-4), 0.0, 1.0);',
        '    float tint = fract(sin(dot(cell + 0.5, vec2(12.9898, 78.233))) * 43758.5453);',
        '    float detail = 1.0 - smoothstep(0.25, 1.0, max(px.x, px.y));',
        '    diffuseColor.rgb *= (1.0 + 0.05 * (tint - 0.5) * detail) * (1.0 - 0.12 * j);',
        '}'
    ].join('\n');
    // The stencil bit the lid marks. The ghost-building pass owns ref 1 under a full mask, but it
    // runs in the transparent list after every opaque surface here has been drawn, so the two
    // never meet; a NotEqual-1 test also passes on this bit exactly as it does on a clear pixel.
    // The lid's bit is above the claim bit, so one Greater test (parcelSurface) refuses both.
    const STENCIL_BIT = 0x08;
    const PARCEL_BIT = 0x04;
    // Draw order inside the opaque list: the lid must mark the stencil before any pavement-level
    // surface tests it.
    // Flat ground at pavement level is layered by draw order, never by depth: a polygon offset or a
    // lift of a few centimetres cannot reliably separate coplanar surfaces, especially large
    // triangles viewed at changing distances, and not at all on a phone's coarser depth buffer
    // (green areas striped through the parcels on Android, 2026-10-28). Each claiming surface
    // (parcelSurface) draws only on pixels nothing claimed before it and claims them: real-world
    // water (`water`) first, then the ground cover (`cover`, the real-world lawns, meadows and woods,
    // most specific first), then the parcel slabs at the default order (0), and the background fills
    // what is left afterwards.
    const ORDER = Object.freeze({ lid: -20, roadbed: -10, kerb: -10, markings: -10, water: -8, cover: -5, pavement: 1 });

    function create(options) {
        const THREE = options.THREE;
        const group = new THREE.Group();
        group.name = 'Ground';
        group.scale.set(options.k || 1, options.k || 1, 1);

        // A pavement-level material skips every pixel the lid marked.
        function cutHoles(material) {
            behindBuildings(material);
            material.stencilWrite = true;
            material.stencilWriteMask = 0;
            material.stencilFuncMask = STENCIL_BIT;
            material.stencilRef = STENCIL_BIT;
            material.stencilFunc = THREE.NotEqualStencilFunc;
            material.stencilFail = THREE.KeepStencilOp;
            material.stencilZFail = THREE.KeepStencilOp;
            material.stencilZPass = THREE.KeepStencilOp;
            material.needsUpdate = true;
            return material;
        }

        // A claiming surface: it draws only where neither the lid nor an earlier claim marked the
        // pixel (ref PARCEL_BIT is greater than the masked stencil only when both bits are clear),
        // and marks it claimed.
        function parcelSurface(material) {
            cutHoles(material);
            material.stencilRef = PARCEL_BIT;
            material.stencilFuncMask = STENCIL_BIT | PARCEL_BIT;
            material.stencilFunc = THREE.GreaterStencilFunc;
            material.stencilWriteMask = PARCEL_BIT;
            material.stencilZPass = THREE.ReplaceStencilOp;
            return material;
        }

        function backgroundSurface(material) {
            cutHoles(material);
            material.stencilFuncMask = STENCIL_BIT | PARCEL_BIT;
            material.stencilRef = 0;
            material.stencilFunc = THREE.EqualStencilFunc;
            return material;
        }

        // Give a pavement-level material the paving pattern. `metresPerUnit` converts the mesh's local
        // XY to metres (1 for the ground group, 1/k for a mesh laid out in scene units).
        function paveTexture(material, metresPerUnit) {
            material.userData = material.userData || {};
            const uniforms = material.userData.cbPave || (material.userData.cbPave = { uPaveScale: { value: 1 }, uPaveSlab: { value: PAVE_SLAB_M } });
            uniforms.uPaveScale.value = Number.isFinite(metresPerUnit) && metresPerUnit > 0 ? metresPerUnit : 1;
            material.onBeforeCompile = function (shader) {
                shader.uniforms.uPaveScale = uniforms.uPaveScale;
                shader.uniforms.uPaveSlab = uniforms.uPaveSlab;
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', '#include <common>\nvarying vec2 vPaveXY;\nuniform float uPaveScale;')
                    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaveXY = transformed.xy * uPaveScale;');
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', '#include <common>\nvarying vec2 vPaveXY;\nuniform float uPaveSlab;')
                    .replace('#include <color_fragment>', '#include <color_fragment>\n' + PAVE_FRAGMENT);
            };
            material.customProgramCacheKey = function () { return 'cb-pave'; };
            material.needsUpdate = true;
            return material;
        }

        const materials = {
            // Stencil only: no colour, no depth, marks the lid's footprint wherever it projects.
            lid: new THREE.MeshBasicMaterial({
                colorWrite: false, depthWrite: false, depthTest: false,
                stencilWrite: true, stencilRef: STENCIL_BIT, stencilWriteMask: STENCIL_BIT, stencilFuncMask: STENCIL_BIT,
                stencilFunc: THREE.AlwaysStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.ReplaceStencilOp
            }),
            asphalt: behindBuildings(new THREE.MeshLambertMaterial({ color: COLORS.asphalt })),
            kerb: behindBuildings(new THREE.MeshLambertMaterial({ color: COLORS.kerb, side: THREE.DoubleSide })),
            markings: behindBuildings(new THREE.MeshLambertMaterial({ color: COLORS.markings }), OFFSET.markings),
            pavement: paveTexture(backgroundSurface(new THREE.MeshLambertMaterial({ color: COLORS.pavement })), 1)
        };
        let meshes = [];
        let lastStats = null;

        // A part (positions + indices from ground-geometry) as an indexed geometry; flat parts face up.
        function toGeometry(part) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
            let normals = part.normals;
            if (!normals) {
                normals = new Float32Array(part.positions.length);
                for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
            }
            geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
            geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
            geometry.computeBoundingSphere();
            return geometry;
        }

        function clear() {
            meshes.forEach(mesh => { group.remove(mesh); try { mesh.geometry.dispose(); } catch (_) { } });
            meshes = [];
            lastStats = null;
        }

        // Replace the ground with a fresh ground-geometry result (null clears it).
        function setGeometry(result) {
            clear();
            if (!result) return;
            const add = (part, material, name, renderOrder) => {
                if (!part || !part.triangles) return;
                const mesh = new THREE.Mesh(toGeometry(part), material);
                mesh.name = name;
                mesh.renderOrder = renderOrder;
                mesh.userData.isGround = true;
                group.add(mesh);
                meshes.push(mesh);
            };
            add(result.lid, materials.lid, 'ground-lid', ORDER.lid);
            add(result.roadbed, materials.asphalt, 'ground-roadbed', ORDER.roadbed);
            add(result.kerb, materials.kerb, 'ground-kerb', ORDER.kerb);
            add(result.markings, materials.markings, 'ground-markings', ORDER.markings);
            add(result.plane, materials.pavement, 'ground-pavement', ORDER.pavement);
            lastStats = result.stats || null;
        }

        function dispose() {
            clear();
            Object.values(materials).forEach(material => { try { material.dispose(); } catch (_) { } });
        }

        return {
            group, setGeometry, clear, dispose, cutHoles, parcelSurface, paveTexture,
            stats: () => ({ drawCalls: meshes.length, ...(lastStats || {}) })
        };
    }

    return { create, designSurface, COLORS, OFFSET, MAX_DESIGN_RANK, ORDER, STENCIL_BIT, PARCEL_BIT, PAVE_SLAB_M };
});
