// Derived vacant-plot scenery and ordinary sidewalk paving for building surroundings.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSiteGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function sidewalkMaterial(THREE, ground, metresPerUnit) {
        return ground.paveTexture(new THREE.MeshLambertMaterial({
            color: 0xcdccc8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        }), metresPerUnit);
    }

    // Metric height and post spacing, even when the map's horizontal units are Mercator-scaled.
    function fencePositions(geometry, project, metresPerUnit = 1) {
        const positions = [];
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        const line = (a, b, za, zb = za) => positions.push(a[0], a[1], za, b[0], b[1], zb);
        polygons.forEach(rings => rings.forEach(ring => {
            for (let i = 1; i < ring.length; i++) {
                const a = project(ring[i - 1]), b = project(ring[i]);
                const length = Math.hypot(b[0] - a[0], b[1] - a[1]) * metresPerUnit;
                if (length < 0.05) continue;
                line(a, b, 1.3); line(a, b, 0.55);
                const posts = Math.ceil(length / 3);
                for (let j = 0; j < posts; j++) {
                    const t = j / posts;
                    const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                    line(point, point, 0.08, 1.3);
                }
            }
        }));
        return positions;
    }

    function buildVacantPlots({ THREE, features, target, polygonMeshes, project, metresPerUnit, ownMaterial, ownGeometry }) {
        features.forEach(feature => {
            const grass = new THREE.MeshLambertMaterial({
                color: 0xadae75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
            });
            grass.onBeforeCompile = shader => {
                shader.uniforms.wildScale = { value: metresPerUnit };
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', '#include <common>\nvarying vec2 wildXY;\nuniform float wildScale;')
                    .replace('#include <begin_vertex>', '#include <begin_vertex>\nwildXY = transformed.xy * wildScale;');
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', '#include <common>\nvarying vec2 wildXY;')
                    .replace('#include <color_fragment>', '#include <color_fragment>\nfloat grassVariation = sin(wildXY.x * 0.7) * sin(wildXY.y * 0.9);\ndiffuseColor.rgb *= 0.9 + 0.13 * grassVariation;');
            };
            grass.customProgramCacheKey = () => 'vacant-wild-ground';
            polygonMeshes(feature, grass, 0.08, 0).forEach(mesh => {
                ownMaterial(mesh, grass);
                mesh.userData.isVacantPlot = true;
                target.add(mesh);
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(fencePositions(feature.geometry, project, metresPerUnit), 3));
            const material = new THREE.LineBasicMaterial({ color: 0x626650 });
            const fence = new THREE.LineSegments(geometry, material);
            ownGeometry(fence, geometry); ownMaterial(fence, material);
            fence.userData.isVacantPlotFence = true;
            target.add(fence);
        });
    }

    return { sidewalkMaterial, fencePositions, buildVacantPlots };
});
