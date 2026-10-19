// Unit tests for the stable screen-door transparency used by dense 3D building meshes.

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    normalizeCoverage,
    coverageOf,
    patchFragmentShader,
    configureMaterial
} = require('../../frontend/js/three-screen-door.js');

function fakeMaterial() {
    return {
        userData: {},
        transparent: true,
        opacity: 0.4,
        depthTest: false,
        depthWrite: false,
        depthFunc: 'less-equal',
        alphaToCoverage: true,
        onBeforeCompile: vi.fn(),
        customProgramCacheKey: () => 'base'
    };
}

describe('three screen-door transparency', () => {
    it('normalizes invalid coverage and clamps numeric values', () => {
        expect(normalizeCoverage(undefined)).toBe(1);
        expect(normalizeCoverage(-0.1)).toBe(0);
        expect(normalizeCoverage(0.5)).toBe(0.5);
        expect(normalizeCoverage(2)).toBe(1);
    });

    it('moves a translucent material to the opaque depth-writing pass', () => {
        const material = fakeMaterial();
        configureMaterial(material, { coverage: 0.5, depthFunc: 'strict-less' });

        expect(material.transparent).toBe(false);
        expect(material.opacity).toBe(1);
        expect(material.depthTest).toBe(true);
        expect(material.depthWrite).toBe(true);
        expect(material.depthFunc).toBe('strict-less');
        expect(material.alphaToCoverage).toBe(false);
        expect(coverageOf(material)).toBe(0.5);
        expect(material.customProgramCacheKey()).toContain('cb-screen-door-v1');
    });

    it('injects a deterministic fragment discard and preserves an existing compile hook', () => {
        const material = fakeMaterial();
        const priorHook = material.onBeforeCompile;
        configureMaterial(material, { coverage: 0.3 });
        const shader = {
            uniforms: {},
            fragmentShader: 'void main() {\n#include <alphatest_fragment>\ngl_FragColor = vec4(1.0);\n}'
        };

        material.onBeforeCompile(shader, {});

        expect(priorHook).toHaveBeenCalledOnce();
        expect(shader.uniforms.cbScreenDoorCoverage.value).toBe(0.3);
        expect(shader.fragmentShader).toContain('floor(gl_FragCoord.xy)');
        expect(shader.fragmentShader).toContain('if (cbScreenDoorCoverage <= cbScreenDoorThreshold) discard;');
        expect(shader.fragmentShader).not.toContain('cameraPosition');
    });

    it('fails loudly if a Three.js shader has no supported insertion point', () => {
        expect(() => patchFragmentShader('void main() {}')).toThrow(/shader marker/);
    });
});
