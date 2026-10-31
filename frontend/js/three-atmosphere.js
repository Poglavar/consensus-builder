// Weather in the 3D model view: a layer of drifting clouds and the haze of distance. One cloud field
// (value-noise fBm on a plane CLOUD_BASE_M above the ground, in true metres, moving with the wind)
// is drawn three ways from the same GLSL: in the sky dome (three-sky.js), in the water's reflection
// (three-water-sheen.js), and as the clouds' shadows on every lit surface, which dims a surface's
// direct sunlight where the sun's ray to it crosses a cloud. Haze is three.js linear fog in the
// horizon's colour that starts past the camera's target, so what is looked at stays clear. No
// textures, no extra draws, no frames of its own: the clouds move only on frames drawn anyway.
// UMD: window.__threeAtmosphere in the browser, require()-able in node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeAtmosphere = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const CLOUD_BASE_M = 1500;
    // Fair-weather cumulus: the share of the sky covered, the drift and the size of one cloud cell.
    const CLOUD_COVER = 0.5;
    const WIND_M_PER_S = [5.2, 2.4];
    const CLOUD_CELL_M = 1100;
    // How much of the direct sunlight a cloud takes away from the ground it shades; it also hides a
    // quarter as much of the sky's light (the bright sky around the sun is behind it too). The
    // scene's sky light is strong, so the direct share alone left the shadows hard to see.
    const SHADOW_STRENGTH = 0.8;
    const CACHE_KEY = '|cb-clouds-v1';

    const CLOUD_GLSL = `
uniform float cbCloudTime;
uniform float cbCloudK;
uniform float cbCloudCover;
uniform float cbCloudShadow;
uniform vec2 cbCloudWind;
uniform vec3 cbCloudSun;
uniform vec3 cbCloudLit;
uniform vec3 cbCloudShade;
float cbCloudHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float cbCloudNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(cbCloudHash(i), cbCloudHash(i + vec2(1.0, 0.0)), u.x),
               mix(cbCloudHash(i + vec2(0.0, 1.0)), cbCloudHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Cloud density 0..1 at a point of the cloud layer (metres). Shadows take the first three octaves:
// a shadow is soft, and every lit pixel pays for it.
float cbCloudField(vec2 metres, float octaves) {
    vec2 p = (metres - cbCloudWind * cbCloudTime) / ${CLOUD_CELL_M.toFixed(1)};
    float sum = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
        if (float(i) >= octaves) break;
        sum += amplitude * cbCloudNoise(p);
        p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
        amplitude *= 0.5;
    }
    float edge = 1.0 - cbCloudCover;
    return smoothstep(edge * 0.94, edge * 0.94 + 0.2, sum / (1.0 - pow(0.5, octaves)));
}
// The clouds seen from a point (metres) along a direction (z up): colour and coverage. Far along a
// grazing ray the layer fades into the horizon instead of shimmering.
vec4 cbCloudSky(vec3 origin, vec3 dir) {
    if (cbCloudCover <= 0.0 || dir.z <= 0.01) return vec4(0.0);
    float t = (${CLOUD_BASE_M.toFixed(1)} - origin.z) / dir.z;
    if (t <= 0.0) return vec4(0.0);
    float density = cbCloudField(origin.xy + dir.xy * t, 4.0);
    float fade = 1.0 - smoothstep(6000.0, 24000.0, t);
    return vec4(mix(cbCloudLit, cbCloudShade, smoothstep(0.4, 1.0, density)), density * 0.9 * fade);
}
// How deep in a cloud's shadow a point (metres) is, 0 (in the sun) … cbCloudShadow.
float cbCloudShadowAt(vec3 point) {
    if (cbCloudShadow <= 0.0) return 0.0;
    float rise = max(cbCloudSun.z, 0.15);
    vec2 crossing = point.xy + cbCloudSun.xy / rise * (${CLOUD_BASE_M.toFixed(1)} - point.z);
    return cbCloudShadow * cbCloudField(crossing, 3.0);
}`;

    function createState() {
        return {
            cbCloudTime: { value: 0 },
            cbCloudK: { value: 1 },
            cbCloudCover: { value: CLOUD_COVER },
            cbCloudShadow: { value: 0 },
            cbCloudWind: { value: { x: WIND_M_PER_S[0], y: WIND_M_PER_S[1], isVector2: true } },
            cbCloudSun: { value: { x: 0, y: -1, z: 0, isVector3: true } },
            cbCloudLit: { value: { r: 1, g: 1, b: 1, isColor: true } },
            cbCloudShade: { value: { r: 0.7, g: 0.72, b: 0.76, isColor: true } }
        };
    }

    const clamp01 = v => Math.min(1, Math.max(0, v));
    const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

    // Cloud colours (linear RGB) for the sky of the moment (sky-colors.js skyColors(), whose colours
    // are sRGB 0..1) and the sun's altitude (null: the sun layer is off, a neutral daylight). By day
    // a sunlit top is near white and its underside grey; toward sunset both take the glow; at night
    // they are a little lighter than the sky, lit from below by the city.
    function cloudColors(sky, altitudeDeg) {
        const day = altitudeDeg == null ? 1 : clamp01((altitudeDeg + 4) / 14);
        const glow = clamp01(sky.glowStrength || 0) * 0.65;
        const lit = mixRgb(mixRgb([0.97, 0.97, 0.98], sky.glow, glow), mixRgb(sky.horizon, [1, 1, 1], 0.12), 1 - day);
        const shade = mixRgb(mixRgb([0.83, 0.85, 0.89], sky.horizon, 0.25 + 0.3 * glow), mixRgb(sky.zenith, sky.horizon, 0.6), 1 - day);
        const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        return { lit: lit.map(toLinear), shade: shade.map(toLinear), shadow: SHADOW_STRENGTH * (altitudeDeg == null ? 0 : clamp01(altitudeDeg / 6)) };
    }

    // The haze's range in scene units of view depth: clear to past the camera's target, thickest
    // HAZE_DEPTH_M beyond. Horizontal scene units are true metres times k.
    const HAZE_START = 1.2;
    const HAZE_MIN_START_M = 600;
    const HAZE_DEPTH_M = 5000;
    function hazeRange(targetDistanceM, k) {
        const scale = Number.isFinite(k) && k > 0 ? k : 1;
        const near = Math.max(HAZE_MIN_START_M, (Number(targetDistanceM) || 0) * HAZE_START);
        return { near: near * scale, far: (near + HAZE_DEPTH_M) * scale };
    }

    // Per frame drawn: the clock, the scene's scale, the sun's direction (z up, or null) and the
    // colours of cloudColors(). Writes uniform values only.
    function setState(state, { timeS, k, sunDirection, colors }) {
        state.cbCloudTime.value = Number.isFinite(timeS) ? timeS : 0;
        state.cbCloudK.value = Number.isFinite(k) && k > 0 ? k : 1;
        if (sunDirection) Object.assign(state.cbCloudSun.value, { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z });
        if (colors) {
            const [lr, lg, lb] = colors.lit, [sr, sg, sb] = colors.shade;
            Object.assign(state.cbCloudLit.value, { r: lr, g: lg, b: lb });
            Object.assign(state.cbCloudShade.value, { r: sr, g: sg, b: sb });
            state.cbCloudShadow.value = sunDirection ? colors.shadow : 0;
        }
    }

    const VERTEX_HEADER = 'varying vec3 vCbCloudWorld;';
    // After project_vertex: the world position, instancing and batching included.
    const VERTEX_BODY = `
{
    vec4 cbCloudWorld = vec4(transformed, 1.0);
#ifdef USE_BATCHING
    cbCloudWorld = batchingMatrix * cbCloudWorld;
#endif
#ifdef USE_INSTANCING
    cbCloudWorld = instanceMatrix * cbCloudWorld;
#endif
    vCbCloudWorld = (modelMatrix * cbCloudWorld).xyz;
}`;
    const FRAGMENT_SHADOW = `
{
    float cbShade = cbCloudShadowAt(vec3(vCbCloudWorld.xy / cbCloudK, vCbCloudWorld.z));
    reflectedLight.directDiffuse *= 1.0 - cbShade;
    reflectedLight.directSpecular *= 1.0 - cbShade;
    reflectedLight.indirectDiffuse *= 1.0 - 0.25 * cbShade;
}`;

    const LIT = material => !!(material && (material.isMeshLambertMaterial || material.isMeshPhongMaterial || material.isMeshStandardMaterial));
    const configured = new WeakSet();

    // Cloud shadows on a lit material, chained after its own hook (whatever it patched stays).
    function configureMaterial(material, state) {
        if (!LIT(material) || configured.has(material)) return false;
        configured.add(material);
        const priorCompile = material.onBeforeCompile;
        const priorKey = material.customProgramCacheKey;
        material.onBeforeCompile = function (shader, renderer) {
            if (priorCompile) priorCompile.call(this, shader, renderer);
            if (!shader.fragmentShader.includes('#include <lights_fragment_end>')
                || !shader.vertexShader.includes('#include <project_vertex>')) return;
            Object.assign(shader.uniforms, state);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}`)
                .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`);
            // The water's reflection (three-water-sheen.js) may have brought the cloud GLSL already.
            const glsl = shader.fragmentShader.includes('float cbCloudField(') ? '' : CLOUD_GLSL;
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}\n${glsl}`)
                .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAGMENT_SHADOW}`);
        };
        material.customProgramCacheKey = function () {
            return (priorKey ? priorKey.call(this) : '') + CACHE_KEY;
        };
        material.needsUpdate = true;
        return true;
    }

    // Every lit material under `root`, skipping subtrees marked userData.cbNoAtmosphere (the photo
    // tiles bring their own light). Already configured materials cost one set lookup.
    function configureTree(root, state) {
        let added = 0;
        const visit = object => {
            if (object.userData && object.userData.cbNoAtmosphere) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) if (configureMaterial(material, state)) added++;
            for (const child of object.children || []) visit(child);
        };
        visit(root);
        return added;
    }

    return {
        CLOUD_GLSL, CLOUD_BASE_M, CLOUD_COVER, SHADOW_STRENGTH, CACHE_KEY,
        createState, cloudColors, hazeRange, setState, configureMaterial, configureTree
    };
});
