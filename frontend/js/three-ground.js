// Ground renderer for the 3D model view: uploads the ground-geometry parts (life/ground-geometry.js)
// in TRUE metres, mounted with scale (k, k, 1) like the life layer, because the scene's XY is
// Mercator-inflated while Z is metric. The roadbed is sunk a kerb below the pavement, so the pavement
// plane and the parcel slabs need holes over it: the roadbed's lid (the same triangles at pavement
// level) is drawn first into the stencil buffer only, and every pavement-level material skips the
// pixels it marked (`cutHoles`). Depth sorts the rest: the kerb walls show on the far side of a
// street, the near pavement edge hides the floor behind it. Four draw calls, no textures, no
// per-frame work.
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
    const COLORS = Object.freeze({ pavement: 0xcdccc8, asphalt: 0x7d8085, kerb: 0x8e8c87 });
    // The pavement is coplanar with the parcel slabs and stays under them by polygon offset.
    const OFFSET = Object.freeze({ pavement: 3 });
    // The stencil bit the lid marks. The ghost-building pass owns ref 1 under a full mask, but it
    // runs in the transparent list after every opaque surface here has been drawn, so the two
    // never meet; a NotEqual-1 test also passes on this bit exactly as it does on a clear pixel.
    const STENCIL_BIT = 0x02;
    // Draw order inside the opaque list: the lid must mark the stencil before any pavement-level
    // surface tests it; everything else is sorted by depth.
    const ORDER = Object.freeze({ lid: -20, roadbed: -10, kerb: -10, pavement: 0 });

    function create(options) {
        const THREE = options.THREE;
        const group = new THREE.Group();
        group.name = 'Ground';
        group.scale.set(options.k || 1, options.k || 1, 1);

        // A pavement-level material skips every pixel the lid marked.
        function cutHoles(material) {
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

        const materials = {
            // Stencil only: no colour, no depth, marks the lid's footprint wherever it projects.
            lid: new THREE.MeshBasicMaterial({
                colorWrite: false, depthWrite: false, depthTest: false,
                stencilWrite: true, stencilRef: STENCIL_BIT, stencilWriteMask: STENCIL_BIT, stencilFuncMask: STENCIL_BIT,
                stencilFunc: THREE.AlwaysStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.ReplaceStencilOp
            }),
            asphalt: new THREE.MeshLambertMaterial({ color: COLORS.asphalt }),
            kerb: new THREE.MeshLambertMaterial({ color: COLORS.kerb, side: THREE.DoubleSide }),
            pavement: cutHoles(new THREE.MeshLambertMaterial({ color: COLORS.pavement, polygonOffset: true, polygonOffsetFactor: OFFSET.pavement, polygonOffsetUnits: OFFSET.pavement }))
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
            add(result.plane, materials.pavement, 'ground-pavement', ORDER.pavement);
            lastStats = result.stats || null;
        }

        function dispose() {
            clear();
            Object.values(materials).forEach(material => { try { material.dispose(); } catch (_) { } });
        }

        return {
            group, setGeometry, clear, dispose, cutHoles,
            stats: () => ({ drawCalls: meshes.length, ...(lastStats || {}) })
        };
    }

    return { create, COLORS, OFFSET, ORDER, STENCIL_BIT };
});
