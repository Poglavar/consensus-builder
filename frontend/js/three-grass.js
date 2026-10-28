// Grass for the 3D model view: a procedural pattern in the ground material's shader, in true metres
// of world position, instead of a flat green or a tiled image (which shows its repeat). Three scales
// of value noise: patches of drier and lusher turf over metres, clumps around a metre, and a fine
// grain that fades out once a pixel covers more ground than the grain (no shimmer from afar).
// Variants: 'lawn' (parks, green proposal ground, mapped lawns), 'wild' (vacant plots and mapped
// meadows, with bare soil showing through) and 'forest' (a wood's floor: moss and leaf litter).
// No textures, no extra draw calls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeGrass = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Base colours the pattern modulates (sRGB, as the material colour).
    const COLORS = Object.freeze({ lawn: 0x557f2f, wild: 0x9a9c62, forest: 0x4f5a2e });

    // Hash without sin(): stable at the large coordinates a city-sized scene reaches.
    const NOISE = `
float cbGrassHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float cbGrassNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(cbGrassHash(i), cbGrassHash(i + vec2(1.0, 0.0)), u.x), mix(cbGrassHash(i + vec2(0.0, 1.0)), cbGrassHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

    // vGrassXY is metres. `footprint` = metres per pixel; each fine layer fades in only below it.
    const FRAGMENT = {
        lawn: `
vec2 gxy = vGrassXY;
float footprint = length(fwidth(gxy));
float patches = cbGrassNoise(gxy / 11.0) * 0.65 + cbGrassNoise(gxy / 4.3 + 17.0) * 0.35;
vec3 dry = vec3(1.16, 1.06, 0.7);
vec3 lush = vec3(0.82, 0.92, 0.8);
diffuseColor.rgb *= mix(lush, dry, smoothstep(0.35, 0.8, patches));
diffuseColor.rgb *= 1.0 + 0.18 * (cbGrassNoise(gxy * 1.4 + 5.0) - 0.5)
    + 0.16 * (cbGrassNoise(gxy * 3.7 + 9.0) - 0.5) * (1.0 - smoothstep(0.15, 0.6, footprint));
float grain = (cbGrassNoise(gxy * 9.0) - 0.5) * (1.0 - smoothstep(0.06, 0.25, footprint))
    + (cbGrassNoise(gxy * 26.0 + 3.0) - 0.5) * (1.0 - smoothstep(0.02, 0.09, footprint));
diffuseColor.rgb *= 1.0 + 0.32 * grain;`,
        wild: `
vec2 gxy = vGrassXY;
float footprint = length(fwidth(gxy));
float patches = cbGrassNoise(gxy / 9.0) * 0.6 + cbGrassNoise(gxy / 3.1 + 11.0) * 0.4;
diffuseColor.rgb *= mix(vec3(0.86, 0.98, 0.78), vec3(1.1, 1.02, 0.82), smoothstep(0.3, 0.75, patches));
float soil = smoothstep(0.66, 0.8, cbGrassNoise(gxy / 2.2 + 41.0) * 0.7 + patches * 0.3);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.33, 0.24), soil * 0.75);
diffuseColor.rgb *= 0.88 + 0.2 * cbGrassNoise(gxy * 1.7 + 2.0);
float grain = (cbGrassNoise(gxy * 8.0) - 0.5) * (1.0 - smoothstep(0.06, 0.25, footprint))
    + (cbGrassNoise(gxy * 23.0 + 9.0) - 0.5) * (1.0 - smoothstep(0.02, 0.09, footprint));
diffuseColor.rgb *= 1.0 + 0.4 * grain;`,
        forest: `
vec2 gxy = vGrassXY;
float footprint = length(fwidth(gxy));
float patches = cbGrassNoise(gxy / 7.0) * 0.6 + cbGrassNoise(gxy / 2.6 + 23.0) * 0.4;
diffuseColor.rgb *= mix(vec3(0.88, 0.96, 0.84), vec3(1.08, 0.99, 0.86), smoothstep(0.3, 0.8, patches));
float litter = smoothstep(0.5, 0.85, cbGrassNoise(gxy / 3.5 + 57.0) * 0.7 + cbGrassNoise(gxy / 1.1 + 13.0) * 0.3);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.40, 0.31, 0.20), litter * 0.35);
diffuseColor.rgb *= 0.92 + 0.14 * cbGrassNoise(gxy * 2.1 + 4.0);
float grain = (cbGrassNoise(gxy * 8.0) - 0.5) * (1.0 - smoothstep(0.06, 0.25, footprint))
    + (cbGrassNoise(gxy * 21.0 + 7.0) - 0.5) * (1.0 - smoothstep(0.02, 0.09, footprint));
diffuseColor.rgb *= 1.0 + 0.36 * grain;`
    };

    // Give a ground material the pattern. `metresPerUnit` converts the mesh's local XY to metres
    // (1 / k for a mesh laid out in Mercator-inflated scene units). Meshes are expected to sit at
    // their scene position with an identity transform, which every flat ground mesh here does.
    function grassTexture(material, metresPerUnit, variant = 'lawn') {
        const kind = FRAGMENT[variant] ? variant : 'lawn';
        const scale = { value: Number.isFinite(metresPerUnit) && metresPerUnit > 0 ? metresPerUnit : 1 };
        material.onBeforeCompile = function (shader) {
            shader.uniforms.uGrassScale = scale;
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nvarying vec2 vGrassXY;\nuniform float uGrassScale;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrassXY = transformed.xy * uGrassScale;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nvarying vec2 vGrassXY;' + NOISE)
                .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT[kind]);
        };
        material.customProgramCacheKey = function () { return 'cb-grass-' + kind; };
        material.userData = material.userData || {};
        material.userData.cbGrass = { variant: kind, scale };
        material.needsUpdate = true;
        return material;
    }

    return Object.freeze({ COLORS, grassTexture });
});
