// Provides stable screen-space transparency for dense 3D building meshes without blend sorting.

(function (global) {
    'use strict';

    const COVERAGE_KEY = 'cbScreenDoorCoverage';
    const UNIFORM_NAME = 'cbScreenDoorCoverage';
    const SHADER_VERSION = 'cb-screen-door-v1';
    const PRIMARY_MARKER = '#include <alphatest_fragment>';
    const FALLBACK_MARKER = '#include <dithering_fragment>';
    const CONFIG_STATE = '__cbScreenDoorState';

    function normalizeCoverage(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 1;
        return Math.min(1, Math.max(0, numeric));
    }

    function coverageOf(material) {
        if (!material || !material.userData) return 1;
        return normalizeCoverage(material.userData[COVERAGE_KEY]);
    }

    function patchFragmentShader(fragmentShader) {
        if (typeof fragmentShader !== 'string') {
            throw new TypeError('Screen-door transparency requires a fragment shader string.');
        }
        if (fragmentShader.includes(`uniform float ${UNIFORM_NAME};`)) return fragmentShader;

        const marker = fragmentShader.includes(PRIMARY_MARKER)
            ? PRIMARY_MARKER
            : (fragmentShader.includes(FALLBACK_MARKER) ? FALLBACK_MARKER : null);
        if (!marker) {
            throw new Error('Screen-door transparency could not find a supported Three.js shader marker.');
        }

        // Interleaved gradient noise gives each physical screen pixel a deterministic threshold.
        // There is intentionally no time or camera input: the mask stays fixed while orbiting,
        // and opaque depth writes make the visible fragments independent of mesh/object ordering.
        const discardChunk = [
            marker,
            'vec2 cbScreenDoorPixel = floor(gl_FragCoord.xy);',
            'float cbScreenDoorThreshold = fract(52.9829189 * fract(dot(cbScreenDoorPixel, vec2(0.06711056, 0.00583715))));',
            `if (${UNIFORM_NAME} <= cbScreenDoorThreshold) discard;`
        ].join('\n');

        return `uniform float ${UNIFORM_NAME};\n${fragmentShader.replace(marker, discardChunk)}`;
    }

    function configureMaterial(material, options = {}) {
        if (!material) throw new TypeError('A material is required for screen-door transparency.');
        const coverage = normalizeCoverage(options.coverage);
        material.userData = material.userData || {};
        material.userData[COVERAGE_KEY] = coverage;

        // Keep this material in Three.js's opaque pass. The shader discard supplies apparent
        // transparency while normal depth testing selects the nearest surface deterministically.
        material.transparent = false;
        material.opacity = 1;
        material.depthTest = true;
        material.depthWrite = true;
        if (options.depthFunc !== undefined) material.depthFunc = options.depthFunc;
        if ('alphaToCoverage' in material) material.alphaToCoverage = false;

        let state = material[CONFIG_STATE];
        if (!state) {
            state = {
                priorOnBeforeCompile: material.onBeforeCompile,
                priorProgramCacheKey: material.customProgramCacheKey
            };
            Object.defineProperty(material, CONFIG_STATE, {
                configurable: true,
                enumerable: false,
                value: state
            });
        }

        if (coverage < 1) {
            material.onBeforeCompile = function (shader, renderer) {
                if (typeof state.priorOnBeforeCompile === 'function') {
                    state.priorOnBeforeCompile.call(this, shader, renderer);
                }
                shader.uniforms = shader.uniforms || {};
                shader.uniforms[UNIFORM_NAME] = { value: coverageOf(this) };
                shader.fragmentShader = patchFragmentShader(shader.fragmentShader);
            };
            material.customProgramCacheKey = function () {
                const prior = typeof state.priorProgramCacheKey === 'function'
                    ? state.priorProgramCacheKey.call(this)
                    : '';
                return `${prior}|${SHADER_VERSION}`;
            };
        } else {
            material.onBeforeCompile = state.priorOnBeforeCompile;
            material.customProgramCacheKey = state.priorProgramCacheKey;
        }

        material.needsUpdate = true;
        return material;
    }

    const api = {
        COVERAGE_KEY,
        SHADER_VERSION,
        normalizeCoverage,
        coverageOf,
        patchFragmentShader,
        configureMaterial
    };

    if (global) global.__threeScreenDoor = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
