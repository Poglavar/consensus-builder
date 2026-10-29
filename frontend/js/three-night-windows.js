// Lit windows at night on the model view's buildings: a shader patch for the building materials
// (MeshPhong) that adds a warm emissive window grid when the sun is down. Plain massing uses a
// wall-local grid from the world position (storeys of 3 m, bays of 3.2 m); a procedural facade
// (three-building-facades.js) lights its own panes instead. Each window is on or off, warm, white or
// cool and brighter or dimmer by a hash of its address, never of the camera or time; more windows
// come on as the dusk deepens, ground floors (shops) more and brighter. Roofs never glow. No meshes
// and no material copies: the hook chains onto existing ones and every material shares two uniforms.
// UMD: window.__threeNightWindows in the browser, require()-able in node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeNightWindows = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const CACHE_KEY = '|cb-night-windows-v1';
    // Translucent planning hulls and warning-coloured blocks are not rooms.
    const DARK_ROLES = new Set(['massing', 'flagged']);
    const configured = new WeakSet();

    // cbNightGlow: 0 by day … 1 at night (the lamps' ramp); cbNightK: scene units per metre in XY.
    function createState() {
        return { cbNightGlow: { value: 0 }, cbNightK: { value: 1 } };
    }

    const VERTEX_HEADER = `
varying vec3 vCbNightWorld;
varying vec3 vCbNightNormal;
varying float vCbNightHeight;
`;
    // After project_vertex: the world position and normal (instancing and batching included), and the
    // height above the building's base, which is the object's own z = 0.
    const VERTEX_BODY = `
vec4 cbNightWorld = vec4(transformed, 1.0);
vec3 cbNightNormal = objectNormal;
#ifdef USE_BATCHING
cbNightWorld = batchingMatrix * cbNightWorld;
cbNightNormal = mat3(batchingMatrix) * cbNightNormal;
#endif
#ifdef USE_INSTANCING
cbNightWorld = instanceMatrix * cbNightWorld;
cbNightNormal = mat3(instanceMatrix) * cbNightNormal;
#endif
vCbNightWorld = (modelMatrix * cbNightWorld).xyz;
vCbNightNormal = mat3(modelMatrix) * cbNightNormal;
vCbNightHeight = transformed.z;
`;
    const FRAGMENT_HEADER = `
uniform float cbNightGlow;
uniform float cbNightK;
varying vec3 vCbNightWorld;
varying vec3 vCbNightNormal;
varying float vCbNightHeight;
float cbNightHash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
// One window's light: whether its room is in use (more of them as the night deepens), its colour
// and its brightness, all from its address. Ground floors are shops: more of them lit, brighter.
vec3 cbNightLit(vec3 address, float ground) {
    float share = mix(0.42, 0.8, ground) * cbNightGlow;
    float inUse = 1.0 - step(share, cbNightHash(address));
    float tone = cbNightHash(address + 17.31);
    vec3 color = mix(vec3(1.0, 0.6, 0.24), vec3(1.0, 0.84, 0.6), step(0.6, tone));
    color = mix(color, vec3(0.74, 0.84, 1.0), step(0.86, tone));
    float level = mix(0.35, 1.0, cbNightHash(address + 41.7)) * mix(1.0, 1.7, ground);
    return color * level * inUse;
}
// The average of many windows, for walls so far away that one window is smaller than a pixel.
vec3 cbNightAverage(float area, float ground) {
    return vec3(1.0, 0.7, 0.38) * 0.62 * area * mix(0.42, 0.8, ground) * cbNightGlow * mix(1.0, 1.7, ground);
}
vec3 cbNightWindowLight() {
    if (cbNightGlow <= 0.0) return vec3(0.0);
#ifdef CB_FACADE_WINDOWS
    if (cbFacadeEnabled > 0.5) {
        if (cbFacadeWindowGlass <= 0.0) return vec3(0.0);
        return cbNightLit(cbFacadeWindowCell, 1.0 - step(0.5, cbFacadeWindowCell.y)) * cbFacadeWindowGlass;
    }
#endif
    vec3 normal = normalize(vCbNightNormal);
    if (abs(normal.z) > 0.35 || vCbNightHeight < 0.0) return vec3(0.0);
    vec2 facing = normalize(normal.xy);
    float along = dot(vCbNightWorld.xy, vec2(-facing.y, facing.x)) / cbNightK;
    float across = dot(vCbNightWorld.xy, facing) / cbNightK;
    vec2 grid = vec2(along / 3.2, vCbNightHeight / 3.0);
    vec2 cell = floor(grid);
    float ground = 1.0 - step(1.0, cell.y);
    vec2 halfSize = mix(vec2(0.22, 0.19), vec2(0.38, 0.3), ground);
    vec2 offset = fract(grid) - vec2(0.5, mix(0.54, 0.46, ground));
    vec2 footprint = max(fwidth(grid), vec2(0.0001));
    vec2 edge = smoothstep(halfSize - footprint, halfSize + footprint, abs(offset));
    float glass = (1.0 - edge.x) * (1.0 - edge.y);
    // The wall's own address (its direction and plane), so parallel walls do not repeat a pattern.
    float wall = floor(across * 0.5) + dot(floor(facing * 8.0 + 0.5), vec2(3.1, 7.7));
    vec3 exact = cbNightLit(vec3(cell, wall), ground) * glass;
    float detail = 1.0 - smoothstep(0.3, 0.8, max(footprint.x, footprint.y));
    return mix(cbNightAverage(4.0 * halfSize.x * halfSize.y, ground), exact, detail);
}
`;

    function patchShader(shader) {
        if (!shader.vertexShader.includes('#include <project_vertex>')
            || !shader.fragmentShader.includes('#include <emissivemap_fragment>')) {
            throw new Error('Night windows require the Three.js Phong shader chunks.');
        }
        shader.vertexShader = VERTEX_HEADER + shader.vertexShader.replace(
            '#include <project_vertex>', '#include <project_vertex>\n' + VERTEX_BODY);
        shader.fragmentShader = FRAGMENT_HEADER + shader.fragmentShader.replace(
            '#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cbNightWindowLight();');
        return shader;
    }

    const lights = material => !DARK_ROLES.has(material.userData?.cbBuildingMaterialRole);

    // Chains onto the material's own hook (call before ghost/transparency/facade hooks wrap it: they
    // keep it as their prior). The role is read at compile time, when it is known.
    function configureMaterial(material, state) {
        if (!material?.isMeshPhongMaterial || configured.has(material)) return material;
        configured.add(material);
        const priorCompile = material.onBeforeCompile;
        const priorKey = material.customProgramCacheKey;
        material.onBeforeCompile = function (shader, renderer) {
            priorCompile?.call(this, shader, renderer);
            if (!lights(this)) return;
            Object.assign(shader.uniforms, state);
            patchShader(shader);
        };
        material.customProgramCacheKey = function () {
            return (priorKey ? priorKey.call(this) : '') + (lights(this) ? CACHE_KEY : '');
        };
        material.needsUpdate = true;
        return material;
    }

    // Returns whether a uniform changed (the caller's frame already draws it).
    function setState(state, glow, k) {
        const g = Math.round(Math.min(1, Math.max(0, Number(glow) || 0)) * 100) / 100;
        const scale = Number.isFinite(k) && k > 0 ? k : 1;
        if (state.cbNightGlow.value === g && state.cbNightK.value === scale) return false;
        state.cbNightGlow.value = g;
        state.cbNightK.value = scale;
        return true;
    }

    return { CACHE_KEY, createState, patchShader, configureMaterial, setState };
});
