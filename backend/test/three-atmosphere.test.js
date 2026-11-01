// The 3D model view's weather (frontend/js/three-atmosphere.js): cloud colours over the day, the
// haze range, and the cloud-shadow patch every lit material gets.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const atmosphere = require('../../frontend/js/three-atmosphere.js');
const SkyColors = require('../../frontend/js/sky-colors.js');
const threeSky = require('../../frontend/js/three-sky.js');
const THREE = require('three');

const SHADER = () => ({
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <lights_fragment_end>\nvec3 outgoingLight = reflectedLight.directDiffuse;\n}'
});
const brightness = rgb => rgb.reduce((sum, v) => sum + v, 0);

describe('clouds', () => {
    it('are near white by day, darker at night, and cast shadows only while the sun is up', () => {
        const noon = atmosphere.cloudColors(SkyColors.skyColors(45), 45);
        const night = atmosphere.cloudColors(SkyColors.skyColors(-30), -30);
        expect(Math.min(...noon.lit)).toBeGreaterThan(0.85);
        expect(brightness(night.lit)).toBeLessThan(brightness(noon.lit) / 3);
        expect(brightness(noon.shade)).toBeLessThan(brightness(noon.lit));
        expect(noon.shadow).toBeCloseTo(atmosphere.SHADOW_STRENGTH, 6);
        expect(night.shadow).toBe(0);
        expect(atmosphere.cloudColors(SkyColors.skyColors(null), null).shadow).toBe(0);
    });

    it('take the sun direction and colours into the shared uniforms, and no shadow without a sun', () => {
        const state = atmosphere.createState();
        const colors = atmosphere.cloudColors(SkyColors.skyColors(30), 30);
        atmosphere.setState(state, { timeS: 12.5, k: 1.6, sunDirection: { x: 0, y: -0.5, z: 0.87 }, colors });
        expect(state.cbCloudTime.value).toBe(12.5);
        expect(state.cbCloudK.value).toBe(1.6);
        expect(state.cbCloudSun.value).toMatchObject({ x: 0, y: -0.5, z: 0.87 });
        expect(state.cbCloudLit.value.r).toBeCloseTo(colors.lit[0], 6);
        expect(state.cbCloudShadow.value).toBeCloseTo(colors.shadow, 6);
        // A frame between sun changes only moves the clock.
        atmosphere.setState(state, { timeS: 13, k: 1.6, sunDirection: null, colors: null });
        expect(state.cbCloudShadow.value).toBeCloseTo(colors.shadow, 6);
        atmosphere.setState(state, { timeS: 14, k: 1.6, sunDirection: null, colors });
        expect(state.cbCloudShadow.value).toBe(0);
    });

    it('are drawn in the dome from the camera, with the weather uniforms shared', () => {
        expect(threeSky.DOME_FRAGMENT).toContain('float cbCloudField(');
        expect(threeSky.DOME_FRAGMENT).toContain('cbCloudSky(vec3(cameraPosition.xy / cbCloudK, cameraPosition.z), cbDir)');
        const state = atmosphere.createState();
        const sky = threeSky.createSky(THREE, { clouds: state });
        const dome = sky.group.children[0];
        expect(dome.material.uniforms.cbCloudTime).toBe(state.cbCloudTime);
        expect(dome.material.uniforms.cbSkyZenith).toBe(sky.uniforms.cbSkyZenith);
    });
});

describe('cloud shadows on lit materials', () => {
    it('dim the direct light after the lights are summed, chained after the material\'s own hook', () => {
        const state = atmosphere.createState();
        const material = new THREE.MeshLambertMaterial();
        const calls = [];
        material.onBeforeCompile = shader => { calls.push('own'); shader.fragmentShader += '\n// own'; };
        material.customProgramCacheKey = () => 'own-key';
        expect(atmosphere.configureMaterial(material, state)).toBe(true);
        expect(atmosphere.configureMaterial(material, state)).toBe(false);
        const shader = SHADER();
        material.onBeforeCompile(shader);
        expect(calls).toEqual(['own']);
        expect(shader.fragmentShader).toContain('// own');
        const at = shader.fragmentShader.indexOf('reflectedLight.directDiffuse *= 1.0 - cbShade;');
        expect(at).toBeGreaterThan(shader.fragmentShader.indexOf('#include <lights_fragment_end>'));
        expect(at).toBeLessThan(shader.fragmentShader.indexOf('vec3 outgoingLight'));
        expect(shader.vertexShader).toContain('vCbCloudWorld = (modelMatrix * cbCloudWorld).xyz;');
        expect(shader.uniforms.cbCloudShadow).toBe(state.cbCloudShadow);
        expect(material.customProgramCacheKey()).toBe('own-key' + atmosphere.CACHE_KEY);
    });

    it('declare the cloud field once when the water reflection already brought it', () => {
        const material = new THREE.MeshPhongMaterial();
        material.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${atmosphere.CLOUD_GLSL}`); };
        atmosphere.configureMaterial(material, atmosphere.createState());
        const shader = SHADER();
        material.onBeforeCompile(shader);
        expect(shader.fragmentShader.split('float cbCloudField(').length).toBe(2);
    });

    it('reach every lit material in a tree except unlit ones and the photo mesh', () => {
        const state = atmosphere.createState();
        const root = new THREE.Group();
        const lit = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
        const unlit = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
        const multi = new THREE.Mesh(new THREE.BufferGeometry(), [new THREE.MeshLambertMaterial(), new THREE.MeshPhongMaterial()]);
        const photo = new THREE.Group();
        photo.userData.cbNoAtmosphere = true;
        photo.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
        root.add(lit, unlit, multi, photo);
        expect(atmosphere.configureTree(root, state)).toBe(3);
        expect(atmosphere.configureTree(root, state)).toBe(0);
    });
});

describe('trees in the wind', () => {
    it('bend instanced trees along the wind on the weather clock, more toward the crown', () => {
        const state = atmosphere.createState();
        const material = atmosphere.configureSway(new THREE.MeshLambertMaterial({ vertexColors: true }), state);
        const shader = { uniforms: {}, vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}', fragmentShader: '' };
        material.onBeforeCompile(shader);
        expect(shader.uniforms.cbCloudTime).toBe(state.cbCloudTime);
        expect(shader.uniforms.cbCloudWind).toBe(state.cbCloudWind);
        const swayAt = shader.vertexShader.indexOf('transformed.xy += cbLocal');
        expect(swayAt).toBeGreaterThan(shader.vertexShader.indexOf('#include <begin_vertex>'));
        expect(swayAt).toBeLessThan(shader.vertexShader.indexOf('#include <project_vertex>'));
        expect(shader.vertexShader).toContain('cbBend * cbBend');
        expect(material.customProgramCacheKey()).toContain('cb-sway');
    });
});

describe('haze', () => {
    it('starts past the camera\'s target and is in scene units', () => {
        const near = atmosphere.hazeRange(100, 1);
        expect(near.near).toBe(600);
        expect(near.far).toBeGreaterThan(near.near);
        const far = atmosphere.hazeRange(2000, 1.6);
        expect(far.near).toBeCloseTo(2000 * 1.2 * 1.6, 6);
        expect(far.far - far.near).toBeCloseTo((near.far - near.near) * 1.6, 6);
    });
});
