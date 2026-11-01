// Sky reflection on water in the 3D model view: the water's shader looks up the sky (three-sky.js
// cbSkyColor, the same function and uniforms the dome draws) along the view ray reflected off a
// gently rippled surface, and blends it in by the Fresnel term, so water reads as glossy, bright at
// grazing angles and darker looking down, and follows the time of day. Given the weather's state
// (three-atmosphere.js), it also reflects the drifting clouds and its ripple moves with the same
// clock, on frames drawn anyway (none of its own). No second render, no cube map: one function call
// per water pixel. The ripple fades with distance, where it would only alias.
// UMD: window.__threeWaterSheen, require()-able in node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeWaterSheen = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Reflectance of water head-on (Schlick's F0 for n ≈ 1.33) and the most sky a pixel shows.
    const F0 = 0.02;
    const MAX_REFLECTION = 0.85;

    // Schlick's Fresnel term for the cosine between the eye and the surface normal.
    function fresnel(cosTheta) {
        const c = Math.min(1, Math.max(0, cosTheta));
        return F0 + (1 - F0) * Math.pow(1 - c, 5);
    }

    const VERTEX_DECLARATIONS = 'varying vec3 vCbWaterWorld;';
    const VERTEX_WORLD = 'vCbWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;';
    // `clouds`: whether the weather's GLSL and uniforms are there (its clock moves the ripple).
    const fragmentSheen = clouds => `
{
    vec3 cbToEye = cameraPosition - vCbWaterWorld;
    float cbDistance = length(cbToEye);
    cbToEye /= max(cbDistance, 1e-4);
    // Two crossed swells in scene units, travelling slowly; their slope tilts the normal a few degrees.
    vec2 cbP = vCbWaterWorld.xy;
    float cbT = ${clouds ? 'cbCloudTime' : '0.0'};
    vec2 cbSlope = vec2(sin(cbP.x * 0.9 + sin(cbP.y * 0.4) * 1.7 + cbT * 0.7) + 0.6 * sin(cbP.x * 2.3 - cbP.y * 1.1 - cbT * 1.3),
                        cos(cbP.y * 0.8 + sin(cbP.x * 0.5) * 1.3 + cbT * 0.6) + 0.6 * cos(cbP.y * 2.1 + cbP.x * 1.4 + cbT * 1.1));
    cbSlope *= 0.035 * clamp(80.0 / max(cbDistance, 1.0), 0.0, 1.0);
    vec3 cbNormal = normalize(vec3(-cbSlope, 1.0));
    vec3 cbReflected = reflect(-cbToEye, cbNormal);
    cbReflected.z = abs(cbReflected.z);
    float cbCos = clamp(dot(cbToEye, cbNormal), 0.0, 1.0);
    float cbFresnel = ${F0.toFixed(2)} + ${(1 - F0).toFixed(2)} * pow(1.0 - cbCos, 5.0);
    vec3 cbSky = cbSkyColor(normalize(cbReflected));
${clouds ? `    vec4 cbCloud = cbCloudSky(vec3(vCbWaterWorld.xy / cbCloudK, vCbWaterWorld.z), normalize(cbReflected));
    cbSky = mix(cbSky, cbCloud.rgb, cbCloud.a);` : ''}
    outgoingLight = mix(outgoingLight, cbSky, min(cbFresnel, ${MAX_REFLECTION.toFixed(2)}));
}`;
    const FRAGMENT_SHEEN = fragmentSheen(false);

    // Give a lit material (MeshPhong/Lambert) the reflection. `skyGlsl` is three-sky.js
    // SKY_COLOR_GLSL; `skyUniforms()` returns the current scene's sky uniforms (a scene's sky is
    // rebuilt with it, the material is not), or null before there is one. `clouds`: optional
    // { glsl, state }, three-atmosphere.js CLOUD_GLSL and its shared uniforms.
    function apply(material, { skyGlsl, skyUniforms, clouds = null }) {
        // Before a sky exists its uniforms read as zero (vec3 or float).
        const declared = [...skyGlsl.matchAll(/uniform\s+(\w+)\s+(\w+)\s*;/g)].map(([, type, name]) => ({ type, name }));
        material.onBeforeCompile = shader => {
            for (const { type, name } of declared) {
                const zero = type === 'vec3' ? [0, 0, 0] : 0;
                shader.uniforms[name] = { get value() { const live = skyUniforms(); return live && live[name] ? live[name].value : zero; } };
            }
            if (clouds) Object.assign(shader.uniforms, clouds.state);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
                .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_WORLD}`);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}\n${skyGlsl}${clouds ? `\n${clouds.glsl}` : ''}`)
                .replace('#include <opaque_fragment>', `${fragmentSheen(!!clouds)}\n#include <opaque_fragment>`);
        };
        material.customProgramCacheKey = () => (clouds ? 'cb-water-sheen-clouds' : 'cb-water-sheen');
        material.needsUpdate = true;
        return material;
    }

    return { apply, fresnel, F0, MAX_REFLECTION, FRAGMENT_SHEEN };
});
