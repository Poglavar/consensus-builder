// One material that colours a building mesh in horizontal bands, for Highlight by use
// (building-use-highlight.js): each band, a share of the mesh's height, has its own colour and
// opacity, so a residential building with shops can light its ground floor and fade the storeys above.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ThreeUseBands = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const MAX_BANDS = 4;

    // bands: [{ from, to (0–1 of the height), color (#rrggbb), opacity }]; zMin/zMax: the mesh's
    // world height range (the scene's z is up).
    function createBandMaterial(THREE, bands, { zMin, zMax }) {
        if (!bands.length || bands.length > MAX_BANDS) throw new Error(`A band material takes 1–${MAX_BANDS} bands, not ${bands.length}`);
        const material = new THREE.MeshPhongMaterial({ color: 0xffffff, specular: 0x222222, shininess: 12, transparent: true,
            depthWrite: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const pad = (list, value) => [...list, ...new Array(MAX_BANDS - list.length).fill(value)];
        const uniforms = {
            cbZMin: { value: zMin }, cbZMax: { value: zMax }, cbCount: { value: bands.length },
            cbFrom: { value: pad(bands.map(band => band.from), 2) },
            cbColors: { value: pad(bands.map(band => new THREE.Color(band.color)), new THREE.Color(0xffffff)) },
            cbAlphas: { value: pad(bands.map(band => band.opacity), 1) }
        };
        material.onBeforeCompile = shader => {
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nvarying float vCbWorldZ;')
                .replace('#include <project_vertex>', '#include <project_vertex>\nvCbWorldZ = (modelMatrix * vec4(transformed, 1.0)).z;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>
varying float vCbWorldZ;
uniform float cbZMin; uniform float cbZMax; uniform int cbCount;
uniform float cbFrom[${MAX_BANDS}]; uniform vec3 cbColors[${MAX_BANDS}]; uniform float cbAlphas[${MAX_BANDS}];`)
                .replace('#include <color_fragment>', `#include <color_fragment>
float cbT = clamp((vCbWorldZ - cbZMin) / max(cbZMax - cbZMin, 1e-4), 0.0, 1.0);
vec3 cbColor = cbColors[0]; float cbAlpha = cbAlphas[0];
for (int i = 1; i < ${MAX_BANDS}; i++) { if (i < cbCount && cbT >= cbFrom[i]) { cbColor = cbColors[i]; cbAlpha = cbAlphas[i]; } }
diffuseColor = vec4(cbColor, cbAlpha);`);
        };
        material.customProgramCacheKey = () => 'cb-use-bands';
        material.userData.cbUseBands = bands;
        return material;
    }

    return { MAX_BANDS, createBandMaterial };
});
