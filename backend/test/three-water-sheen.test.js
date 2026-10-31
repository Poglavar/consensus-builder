// Water reflects the scene's sky (frontend/js/three-water-sheen.js): the shader patch, the Fresnel
// term and the sky uniforms that follow whichever sky the current scene has.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sheen = require('../../frontend/js/three-water-sheen.js');
const { SKY_COLOR_GLSL, DOME_FRAGMENT } = require('../../frontend/js/three-sky.js');
const atmosphere = require('../../frontend/js/three-atmosphere.js');

const SHADER = () => ({
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\nvec3 outgoingLight = vec3(0.0);\n#include <opaque_fragment>\n}'
});

describe('water sheen', () => {
    it('reflects little looking straight down and almost everything at a grazing angle', () => {
        expect(sheen.fresnel(1)).toBeCloseTo(sheen.F0, 6);
        expect(sheen.fresnel(0)).toBeCloseTo(1, 6);
        expect(sheen.fresnel(0.5)).toBeGreaterThan(sheen.fresnel(0.9));
    });

    it('patches the material to blend the sky along the reflected ray before its output', () => {
        const material = {};
        sheen.apply(material, { skyGlsl: SKY_COLOR_GLSL, skyUniforms: () => null });
        const shader = SHADER();
        material.onBeforeCompile(shader);
        expect(shader.vertexShader).toContain('vCbWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        expect(shader.fragmentShader).toContain('vec3 cbSkyColor(vec3 dir)');
        const sheenAt = shader.fragmentShader.indexOf('cbSkyColor(normalize(cbReflected))');
        expect(sheenAt).toBeGreaterThan(-1);
        expect(sheenAt).toBeLessThan(shader.fragmentShader.indexOf('#include <opaque_fragment>'));
        expect(material.customProgramCacheKey()).toBe('cb-water-sheen');
    });

    it('reads the sky uniforms of the current scene, and zeros before there is a sky', () => {
        let sky = null;
        const material = {};
        sheen.apply(material, { skyGlsl: SKY_COLOR_GLSL, skyUniforms: () => sky });
        const shader = SHADER();
        material.onBeforeCompile(shader);
        expect(Object.keys(shader.uniforms).sort()).toEqual(['cbSkyGlow', 'cbSkyGlowStrength', 'cbSkyHorizon', 'cbSkySun', 'cbSkySunDisc', 'cbSkyZenith']);
        expect(shader.uniforms.cbSkyZenith.value).toEqual([0, 0, 0]);
        expect(shader.uniforms.cbSkySunDisc.value).toBe(0);
        const zenith = { r: 0.2, g: 0.4, b: 0.9 };
        sky = { cbSkyZenith: { value: zenith }, cbSkySunDisc: { value: 1 } };
        expect(shader.uniforms.cbSkyZenith.value).toBe(zenith);
        expect(shader.uniforms.cbSkySunDisc.value).toBe(1);
    });

    it('shares one sky function with the dome', () => {
        expect(DOME_FRAGMENT.startsWith(SKY_COLOR_GLSL)).toBe(true);
        expect(DOME_FRAGMENT).toContain('mix(cbSkyColor(cbDir), cbCloud.rgb, cbCloud.a)');
    });

    it('reflects the clouds and moves its ripple on the weather clock when given the weather', () => {
        const plain = {};
        sheen.apply(plain, { skyGlsl: SKY_COLOR_GLSL, skyUniforms: () => null });
        const still = SHADER();
        plain.onBeforeCompile(still);
        expect(still.fragmentShader).not.toContain('cbCloudSky');
        expect(still.fragmentShader).toContain('float cbT = 0.0;');

        const state = atmosphere.createState();
        const weathered = {};
        sheen.apply(weathered, { skyGlsl: SKY_COLOR_GLSL, skyUniforms: () => null, clouds: { glsl: atmosphere.CLOUD_GLSL, state } });
        const shader = SHADER();
        weathered.onBeforeCompile(shader);
        expect(shader.fragmentShader).toContain('float cbCloudField(');
        expect(shader.fragmentShader).toContain('float cbT = cbCloudTime;');
        expect(shader.fragmentShader).toContain('cbSky = mix(cbSky, cbCloud.rgb, cbCloud.a);');
        expect(shader.uniforms.cbCloudTime).toBe(state.cbCloudTime);
        expect(weathered.customProgramCacheKey()).toBe('cb-water-sheen-clouds');
    });
});
