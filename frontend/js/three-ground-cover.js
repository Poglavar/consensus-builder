// The ground of the 3D model view outside streets, parks and designs: what covers it (grass, shrubs,
// crops, bare soil, sand, rock, built-up ground, forest floor, wetland, snow), from GET /decor/ground
// (ESA WorldCover cells, OpenStreetMap sand and rock, the local Sentinel-2 colour of each look), painted
// by a procedural pattern in the ground material's shader instead of grey pavement everywhere. Each
// look is a blend of four patterns (grass, shrub, bare soil, rock) in its local colour; two
// small textures over the scene carry the blend weights and the colour per cell, filtered linearly
// and sampled through a warped position, so looks fade into each other instead of showing 20 m
// squares. Before the cover arrives, and where it says nothing, the ground is grass and shrubs.
// No image textures of the ground (its noise is a small generated texture), no extra draw calls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeGroundCover = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Pattern weights per look: [grass, shrub, bare soil, rock]. A built-up cell gives the
    // background a mineral tone. Mapped surfaces supply the actual outlines of paved ground.
    const PATTERNS = Object.freeze({
        grass: [1, 0, 0, 0],
        shrub: [0.55, 0.45, 0, 0],
        crop: [0.6, 0, 0.4, 0],
        bare: [0.15, 0.05, 0.8, 0],
        sand: [0.04, 0.03, 0.93, 0],
        rock: [0, 0, 0.25, 0.75],
        built: [0, 0, 1, 0],
        // Tree cover seen from above is canopy, which the scene draws as trees: under them, garden ground.
        forest: [0.45, 0.55, 0, 0],
        wetland: [0.8, 0.2, 0, 0],
        snow: [0, 0, 0.6, 0.4]
    });
    // The colour of a look where nothing local says otherwise (sRGB bytes).
    const COLORS = Object.freeze({
        grass: [85, 127, 47], shrub: [79, 106, 44], crop: [138, 150, 82], bare: [160, 138, 106],
        sand: [216, 196, 154], rock: [154, 149, 140], built: [170, 164, 154], forest: [66, 92, 38],
        wetland: [93, 110, 69], snow: [238, 242, 245]
    });
    const VEGETATION = new Set(['grass', 'shrub', 'crop', 'forest', 'wetland']);
    // What the ground is before any cover is known, and where the cover is silent: grass and shrubs.
    const DEFAULT_LOOK = Object.freeze({ mix: [0.6, 0.4, 0, 0], color: [83, 119, 46] });

    // The patterns' value noise reads its lattice from a texture instead of hashing four corners per
    // call: the pattern takes ~18 noise values a pixel, and computed they made this shader ~13× the
    // cost of the plain pavement (2.2 ms a frame at a phone's 3 Mpx on an M1 Pro). The lattice is
    // three-grass.js's hash at each integer point, so the patterns keep its character; it repeats
    // every NOISE_SIZE lattice cells (8 m for the finest grain, faded out beyond a few metres).
    const NOISE_SIZE = 512;
    const fract = x => x - Math.floor(x);
    function latticeHash(x, y) {
        let a = fract(x * 0.1031), b = fract(y * 0.1031), c = a;
        const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
        a += d; b += d; c += d;
        return fract((a + b) * c);
    }
    function noiseBytes(size = NOISE_SIZE) {
        const out = new Uint8Array(size * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = Math.round(255 * latticeHash(x, y));
        return out;
    }
    // One eased bilinear fetch per value (textureLod: also read inside the branches of FRAGMENT).
    const NOISE = `
uniform sampler2D uCoverNoise;
float cbCoverNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    return textureLod(uCoverNoise, (i + f * f * (3.0 - 2.0 * f) + 0.5) / ${NOISE_SIZE}.0, 0.0).r;
}`;

    const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

    // The colour of `look` from its local Sentinel-2 sample ({ rgb, ndvi, samples } or undefined).
    // The sample is an annual median, so a green place reads dull: vegetation goes from the sampled
    // colour (dry, as in a steppe) to its own green as the vegetation index rises. Bare ground, sand,
    // rock and snow take the sample unless it is vegetated (a beach in a park is coarser than the
    // colour cells) or too thin to trust.
    function lookColor(look, sample) {
        const own = COLORS[look] || DEFAULT_LOOK.color;
        if (!sample || !Array.isArray(sample.rgb) || !Number.isFinite(sample.ndvi)) return own.slice();
        if (look === 'built') {
            return sample.ndvi < 0.3 && sample.samples >= 20
                ? own.map((value, i) => Math.round(value * 0.4 + sample.rgb[i] * 0.6)) : own.slice();
        }
        if (VEGETATION.has(look)) {
            const green = smoothstep(0.3, 0.6, sample.ndvi);
            return sample.rgb.map((value, i) => Math.round(value + (own[i] - value) * green));
        }
        return sample.ndvi < 0.3 && sample.samples >= 20 ? sample.rgb.slice() : own.slice();
    }

    function decodeBase64(text) {
        if (typeof atob === 'function') {
            const binary = atob(text);
            const out = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
            return out;
        }
        return new Uint8Array(Buffer.from(text, 'base64'));
    }

    // A /decor/ground payload → the two RGBA textures' bytes, rows from the south (texture v = 0):
    // `mix` = grass, shrub, bare, rock weights; `tint` = the look's RGB colour (opaque).
    // `fallback` is the mean of the cells, for the ground beyond the cover, so its edge fades into
    // what lies inside.
    function coverData(payload) {
        const cols = payload && payload.cols, rows = payload && payload.rows;
        const names = (payload && payload.lookNames) || [];
        if (!(cols > 0 && rows > 0) || typeof payload.looks !== 'string') return null;
        const ids = decodeBase64(payload.looks);
        if (ids.length !== cols * rows) return null;
        const palette = payload.palette || {};
        // WorldCover marks settlement at cell resolution. Borrow the local dry ground colour so
        // that the cell blends with the landscape; the backend supplies no built-up palette.
        const localGround = palette.bare || palette.grass;
        const looks = names.map(name => (PATTERNS[name]
            ? { mix: PATTERNS[name], color: lookColor(name, name === 'built' ? localGround : palette[name]) } : null));
        // Each look's four texel bytes as one 32-bit word, so a cell is two word writes (a scene's
        // 65k cells took ~10 ms byte by byte on the main thread, ~1 ms so).
        const word = bytes => new Uint32Array(Uint8Array.from(bytes).buffer)[0];
        const words = look => [word(look.mix.map(value => Math.round(value * 255))), word([...look.color, 255])];
        const lookWords = looks.map(look => words(look || DEFAULT_LOOK));
        const defaultWords = words(DEFAULT_LOOK);
        const mix32 = new Uint32Array(cols * rows);
        const tint32 = new Uint32Array(cols * rows);
        const counts = new Uint32Array(256);
        for (let row = 0; row < rows; row++) {
            const from = (rows - 1 - row) * cols, to = row * cols;
            for (let col = 0; col < cols; col++) {
                const id = ids[from + col];
                const [m, t] = lookWords[id] || defaultWords;
                mix32[to + col] = m;
                tint32[to + col] = t;
                counts[id]++;
            }
        }
        const sum = [0, 0, 0, 0, 0, 0, 0];
        let known = 0;
        looks.forEach((look, id) => {
            if (!look || !counts[id]) return;
            known += counts[id];
            look.mix.forEach((value, k) => { sum[k] += value * counts[id]; });
            look.color.forEach((value, k) => { sum[4 + k] += value * counts[id]; });
        });
        const mix = new Uint8Array(mix32.buffer), tint = new Uint8Array(tint32.buffer);
        const fallback = known ? { mix: sum.slice(0, 4).map(value => value / known), color: sum.slice(4).map(value => Math.round(value / known)) }
            : DEFAULT_LOOK;
        return { cols, rows, mix, tint, fallback };
    }

    // Runs after Lambert's colour setup; `vCoverXY` is the position in metres in the frame of
    // `uCoverBox` (x0, y0, 1 / width, 1 / height of the cover). `uCoverPlot` brightens a parcel
    // slightly so it still reads as a plot (its outline is drawn separately).
    const FRAGMENT = `
{
    vec2 gxy = vCoverXY;
    // Derivatives are taken here, outside the branches below, where they are defined everywhere.
    float footprint = length(fwidth(gxy));
    vec2 warp = vec2(cbCoverNoise(gxy / 17.0), cbCoverNoise(gxy / 17.0 + 47.0)) - 0.5;
    vec2 uv = (gxy + warp * 6.0 - uCoverBox.xy) * uCoverBox.zw;
    vec2 edgeIn = smoothstep(vec2(0.0), vec2(0.08), uv) * smoothstep(vec2(1.0), vec2(0.92), uv);
    float inside = uCoverOn * edgeIn.x * edgeIn.y;
    vec4 w = mix(uCoverFallbackMix, texture2D(uCoverMix, uv), inside);
    vec3 tint = mix(uCoverFallbackTint, texture2D(uCoverTint, uv).rgb, inside);
    float fine = 1.0 - smoothstep(0.06, 0.25, footprint);
    float finer = 1.0 - smoothstep(0.02, 0.09, footprint);
    float mid = 1.0 - smoothstep(0.15, 0.6, footprint);
    float patches = cbCoverNoise(gxy / 9.0) * 0.6 + cbCoverNoise(gxy / 3.1 + 11.0) * 0.4;
    vec3 grassLook = mix(vec3(0.93, 0.97, 0.9), vec3(1.07, 1.03, 0.96), smoothstep(0.3, 0.75, patches))
        * (1.0 + 0.36 * ((cbCoverNoise(gxy * 8.0) - 0.5) * fine + (cbCoverNoise(gxy * 23.0 + 9.0) - 0.5) * finer));
    // Each pattern only where its look is present (a branch the whole area takes alike).
    vec3 shrubLook = grassLook;
    if (w.g > 0.004) {
        float clump = smoothstep(0.58, 0.7, cbCoverNoise(gxy / 1.7 + 5.0) * 0.75 + cbCoverNoise(gxy / 5.0 + 3.0) * 0.25);
        shrubLook = mix(grassLook, vec3(0.66, 0.7, 0.58) * (0.9 + 0.2 * cbCoverNoise(gxy * 3.0)), clump);
    }
    vec3 bareLook = vec3(1.0);
    if (w.b > 0.004) {
        float mottle = cbCoverNoise(gxy / 4.0 + 21.0) * 0.6 + cbCoverNoise(gxy / 1.3 + 7.0) * 0.4;
        bareLook = vec3(0.9 + 0.2 * mottle) * (1.0 + 0.3 * (cbCoverNoise(gxy * 11.0 + 2.0) - 0.5) * fine
            + 0.25 * (cbCoverNoise(gxy * 31.0) - 0.5) * finer);
        float tuft = smoothstep(0.78, 0.86, cbCoverNoise(gxy * 0.9 + 13.0)) * mid;
        bareLook = mix(bareLook, vec3(0.72, 0.74, 0.6), tuft * 0.6);
    }
    vec3 rockLook = vec3(1.0);
    if (w.a > 0.004) {
        float facet = floor(cbCoverNoise(gxy / 2.4 + 37.0) * 5.0) / 5.0;
        float crack = (1.0 - smoothstep(0.0, 0.03, abs(cbCoverNoise(gxy / 1.6 + 71.0) - 0.5))) * fine;
        rockLook = vec3(0.82 + 0.3 * facet) * (1.0 - 0.35 * crack);
    }
    vec3 openLook = (grassLook * w.r + shrubLook * w.g + bareLook * w.b + rockLook * w.a) / max(w.r + w.g + w.b + w.a, 1e-3);
    // Open ground is never one even tone from afar: broad darker, greener patches of vegetation and
    // lighter, barer ones, tens of metres across (two rotated layers, so no lattice shows).
    float broad = cbCoverNoise(mat2(0.8, -0.6, 0.6, 0.8) * gxy / 90.0 + 3.0) * 0.55
        + cbCoverNoise(mat2(0.6, 0.8, -0.8, 0.6) * gxy / 37.0 + 8.0) * 0.45;
    openLook *= mix(vec3(0.82, 0.85, 0.78), vec3(1.1, 1.07, 1.03), smoothstep(0.2, 0.8, broad));
    diffuseColor.rgb = pow(tint, vec3(2.2)) * openLook * (1.0 + 0.07 * uCoverPlot);
}`;

    const toUnit = values => values.map(value => value / 255);

    function create(options) {
        const THREE = options.THREE;
        function texture(bytes, cols, rows) {
            const tex = new THREE.DataTexture(bytes, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
            tex.magFilter = THREE.LinearFilter;
            tex.minFilter = THREE.LinearFilter;
            tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            return tex;
        }
        const empty = () => texture(new Uint8Array(4), 1, 1);
        function noiseTexture() {
            const tex = new THREE.DataTexture(noiseBytes(), NOISE_SIZE, NOISE_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
            tex.magFilter = tex.minFilter = THREE.LinearFilter;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            return tex;
        }
        // Shared by every material the cover is on, so a new cover reaches them all at once.
        const uniforms = {
            uCoverMix: { value: empty() },
            uCoverTint: { value: empty() },
            uCoverBox: { value: new THREE.Vector4(0, 0, 1, 1) },
            uCoverOn: { value: 0 },
            uCoverFallbackMix: { value: new THREE.Vector4(...DEFAULT_LOOK.mix) },
            uCoverFallbackTint: { value: new THREE.Vector3(...toUnit(DEFAULT_LOOK.color)) },
            uCoverNoise: { value: noiseTexture() }
        };
        let current = null;
        let shown = null; // { payload, data }: the payload whose textures are up

        // Give a ground material the cover. `metresPerUnit` converts the mesh's local XY to the
        // cover's metres (1 for the ground group, 1 / k for a mesh in Mercator-inflated scene units).
        function apply(material, metresPerUnit, { plot = false } = {}) {
            const scale = { value: Number.isFinite(metresPerUnit) && metresPerUnit > 0 ? metresPerUnit : 1 };
            const plotValue = { value: plot ? 1 : 0 };
            material.onBeforeCompile = function (shader) {
                Object.assign(shader.uniforms, uniforms, { uCoverScale: scale, uCoverPlot: plotValue });
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', '#include <common>\nvarying vec2 vCoverXY;\nuniform float uCoverScale;')
                    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoverXY = transformed.xy * uCoverScale;');
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', '#include <common>\nvarying vec2 vCoverXY;\nuniform sampler2D uCoverMix;\n'
                        + 'uniform sampler2D uCoverTint;\nuniform vec4 uCoverBox;\nuniform float uCoverOn;\nuniform float uCoverPlot;\n'
                        + 'uniform vec4 uCoverFallbackMix;\nuniform vec3 uCoverFallbackTint;' + NOISE)
                    .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT);
            };
            material.customProgramCacheKey = function () { return 'cb-ground-cover'; };
            material.userData = material.userData || {};
            material.userData.cbGroundCover = { scale, plot: plotValue };
            material.needsUpdate = true;
            return material;
        }

        // Show a /decor/ground payload; `project(lng, lat)` → [x, y] metres in the materials' frame.
        // Returns what it shows ({ cols, rows, fallback }) or null when the payload has no cover.
        // The same payload again (the ground rebuilt in the same place) only places its box again:
        // its textures are already up.
        function setCover(payload, project) {
            const same = !!shown && payload === shown.payload;
            const data = same ? shown.data : coverData(payload);
            if (!data || !Array.isArray(payload.bbox)) return null;
            const [w, s, e, n] = payload.bbox;
            const [x0, y0] = project(w, s);
            const [x1, y1] = project(e, n);
            if (!(x1 > x0 && y1 > y0)) return null;
            if (!same) {
                uniforms.uCoverMix.value.dispose();
                uniforms.uCoverTint.value.dispose();
                uniforms.uCoverMix.value = texture(data.mix, data.cols, data.rows);
                uniforms.uCoverTint.value = texture(data.tint, data.cols, data.rows);
                shown = { payload, data };
            }
            uniforms.uCoverBox.value.set(x0, y0, 1 / (x1 - x0), 1 / (y1 - y0));
            uniforms.uCoverFallbackMix.value.set(...data.fallback.mix);
            uniforms.uCoverFallbackTint.value.set(...toUnit(data.fallback.color));
            uniforms.uCoverOn.value = 1;
            current = { cols: data.cols, rows: data.rows, fallback: data.fallback, attribution: payload.attribution || null };
            return current;
        }

        // Back to the default ground (a new place, whose cover is not read yet).
        function reset() {
            uniforms.uCoverOn.value = 0;
            uniforms.uCoverFallbackMix.value.set(...DEFAULT_LOOK.mix);
            uniforms.uCoverFallbackTint.value.set(...toUnit(DEFAULT_LOOK.color));
            current = null;
        }

        function dispose() {
            uniforms.uCoverMix.value.dispose();
            uniforms.uCoverTint.value.dispose();
            uniforms.uCoverNoise.value.dispose();
        }

        return { uniforms, apply, setCover, reset, dispose, current: () => current };
    }

    return Object.freeze({ PATTERNS, COLORS, DEFAULT_LOOK, NOISE_SIZE, lookColor, coverData, noiseBytes, create });
});
