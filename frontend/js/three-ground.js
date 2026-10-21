// Ground renderer for the 3D model view: uploads the ground-geometry parts (life/ground-geometry.js)
// as two flat meshes, the pavement plane and the asphalt roadbed, both at z 0 and ordered against the
// parcel slabs, park and square grounds and corridor strips by polygon offsets (see OFFSET). The
// group works in TRUE metres and is mounted with scale (k, k, 1) like the life layer, because the
// scene's XY is Mercator-inflated while Z is metric. Two draw calls, no textures, no per-frame work.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeGround = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Pavement sits a shade under the 0xdddddd parcel slabs so a plot still reads as a plot on it;
    // asphalt is darker than the 0xb0b0b0 road parcels so a street reads as a street.
    const COLORS = Object.freeze({ pavement: 0xcdccc8, asphalt: 0x7d8085 });
    // Depth-offset order among the coplanar z 0 surfaces: the asphalt (-1) draws over parcel slabs
    // (0), so a cadastral road parcel shows its carriageway and the rest of it reads as sidewalk,
    // while park, square and proposal grounds (-2 and beyond) and corridor strips (z 0.05) stay on
    // top; the pavement (3) stays under everything and only fills where no parcel is drawn.
    const OFFSET = Object.freeze({ pavement: 3, asphalt: -1 });

    function create(options) {
        const THREE = options.THREE;
        const group = new THREE.Group();
        group.name = 'Ground';
        group.scale.set(options.k || 1, options.k || 1, 1);
        const materials = {
            pavement: new THREE.MeshLambertMaterial({ color: COLORS.pavement, polygonOffset: true, polygonOffsetFactor: OFFSET.pavement, polygonOffsetUnits: OFFSET.pavement }),
            asphalt: new THREE.MeshLambertMaterial({ color: COLORS.asphalt, polygonOffset: true, polygonOffsetFactor: OFFSET.asphalt, polygonOffsetUnits: OFFSET.asphalt })
        };
        let meshes = [];
        let lastStats = null;

        // A flat part (positions + indices from ground-geometry) as an indexed geometry facing up.
        function toGeometry(part) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
            const normals = new Float32Array(part.positions.length);
            for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
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
            const add = (part, material, name) => {
                if (!part || !part.triangles) return;
                const mesh = new THREE.Mesh(toGeometry(part), material);
                mesh.name = name;
                mesh.userData.isGround = true;
                group.add(mesh);
                meshes.push(mesh);
            };
            add(result.plane, materials.pavement, 'ground-pavement');
            add(result.roadbed, materials.asphalt, 'ground-roadbed');
            lastStats = result.stats || null;
        }

        function dispose() {
            clear();
            Object.values(materials).forEach(material => { try { material.dispose(); } catch (_) { } });
        }

        return {
            group, setGeometry, clear, dispose,
            stats: () => ({ drawCalls: meshes.length, ...(lastStats || {}) })
        };
    }

    return { create, COLORS, OFFSET };
});
