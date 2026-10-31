// Sky and night (frontend/js/sky-colors.js, three-sky.js, three-night-windows.js): sky colours by sun
// altitude, the star field, the dome's change-only updates, and the night-window shader patch on the
// real Three.js Phong shader, chained with the ghost and facade hooks.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SkyColors = require('../../frontend/js/sky-colors.js');
const threeSky = require('../../frontend/js/three-sky.js');
const nightWindows = require('../../frontend/js/three-night-windows.js');
const facades = require('../../frontend/js/three-building-facades.js');
const screenDoor = require('../../frontend/js/three-screen-door.js');
const THREE = require('three');

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const phongShader = () => ({ uniforms: {}, vertexShader: THREE.ShaderLib.phong.vertexShader, fragmentShader: THREE.ShaderLib.phong.fragmentShader });

describe('sky colours', () => {
    it('is the neutral light gradient while the sun layer is off', () => {
        for (const off of [null, undefined, NaN]) expect(SkyColors.skyColors(off)).toBe(SkyColors.NEUTRAL);
        expect(SkyColors.NEUTRAL.stars).toBe(0);
        expect(SkyColors.NEUTRAL.glowStrength).toBe(0);
        expect(luminance(SkyColors.NEUTRAL.horizon)).toBeGreaterThan(0.95);
    });

    it('darkens from day through dusk to a dark blue night', () => {
        const zenith = [60, 20, 5, 0, -3, -6, -10, -18, -40].map(a => luminance(SkyColors.skyColors(a).zenith));
        zenith.slice(1).forEach((value, i) => expect(value).toBeLessThanOrEqual(zenith[i] + 1e-9));
        const night = SkyColors.skyColors(-30);
        expect(night.zenith[2]).toBeGreaterThan(night.zenith[0]);   // blue, not grey or black
        expect(luminance(night.zenith)).toBeLessThan(0.08);
        expect(SkyColors.skyColors(90)).toEqual(SkyColors.skyColors(60));   // clamped past the keys
    });

    it('warms the horizon toward a low sun, not at noon or deep night', () => {
        const sunset = SkyColors.skyColors(0.5);
        expect(sunset.glowStrength).toBeGreaterThan(0.8);
        expect(sunset.horizon[0]).toBeGreaterThan(sunset.horizon[2]);   // orange horizon
        expect(SkyColors.skyColors(40).glowStrength).toBe(0);
        expect(SkyColors.skyColors(-15).glowStrength).toBe(0);
    });

    it('shows stars only once the dusk is deep, and the sun disc only near or above the horizon', () => {
        expect(SkyColors.starStrength(10)).toBe(0);
        expect(SkyColors.starStrength(-3)).toBe(0);
        expect(SkyColors.starStrength(-8)).toBeCloseTo(0.5);
        expect(SkyColors.starStrength(-20)).toBe(1);
        expect(SkyColors.starStrength(null)).toBe(0);
        expect(SkyColors.skyColors(5).sunDisc).toBe(1);
        expect(SkyColors.skyColors(-2).sunDisc).toBe(0);
    });

    it('points the sun direction the SunCalc way: azimuth from south, positive toward west', () => {
        const south = SkyColors.sunDirection(0, 0);
        expect(south.y).toBeCloseTo(-1);
        const west = SkyColors.sunDirection(0, Math.PI / 2);
        expect(west.x).toBeCloseTo(-1);
        const high = SkyColors.sunDirection(Math.PI / 2, 1);
        expect(high.z).toBeCloseTo(1);
        expect(SkyColors.sunDirection(null, 0)).toBeNull();
    });

    it('builds a deterministic star field of unit directions above the horizon', () => {
        const a = SkyColors.starField(500, 7), b = SkyColors.starField(500, 7), c = SkyColors.starField(500, 8);
        expect(a.positions).toEqual(b.positions);
        expect(a.positions).not.toEqual(c.positions);
        for (let i = 0; i < 500; i++) {
            const [x, y, z] = a.positions.slice(i * 3, i * 3 + 3);
            expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
            expect(z).toBeGreaterThan(0.05);
            expect(a.brightness[i]).toBeGreaterThan(0);
            expect(a.brightness[i]).toBeLessThanOrEqual(1);
        }
        const bright = [...a.brightness].filter(v => v > 0.75).length;
        expect(bright).toBeLessThan(150);   // many faint stars, few bright ones
    });
});

describe('sky dome', () => {
    it('writes uniforms only when the sun moved, hides in photo view and shows stars at night', () => {
        const sky = threeSky.createSky(THREE, { pixelRatio: 2 });
        expect(sky.group.children).toHaveLength(2);
        sky.group.children.forEach(object => {
            expect(object.frustumCulled).toBe(false);
            expect(object.material.depthWrite).toBe(false);
            // After ordinary opaque objects (the depth test skips covered pixels), before the ghost
            // buildings' depth pre-pass at 1e6.
            expect(object.renderOrder).toBeGreaterThanOrEqual(threeSky.SKY_RENDER_ORDER);
            expect(object.renderOrder).toBeLessThan(1e6);
            expect(object.material.depthTest).toBe(true);
            expect(object.raycast(new THREE.Raycaster(), [])).toBeUndefined();
        });
        const [, stars] = sky.group.children;
        expect(sky.update(null)).toBe(true);
        expect(sky.update(null)).toBe(false);
        expect(stars.visible).toBe(false);
        const night = { altitudeDeg: -25, azimuthRad: 0.3 };
        expect(sky.update(night)).toBe(true);
        expect(sky.update({ ...night })).toBe(false);
        expect(stars.visible).toBe(true);
        expect(sky.starUniforms.cbStarStrength.value).toBe(1);
        expect(sky.update(night, true)).toBe(true);
        expect(sky.group.visible).toBe(false);
        expect(sky.update({ altitudeDeg: 30, azimuthRad: 0.3 })).toBe(true);
        expect(sky.group.visible).toBe(true);
        expect(stars.visible).toBe(false);
    });
});

describe('night windows', () => {
    const phong = () => new THREE.MeshPhongMaterial();

    it('patches the real Phong shader once, through shared uniforms, with its own cache key', () => {
        const state = nightWindows.createState();
        const first = phong(), second = phong();
        nightWindows.configureMaterial(first, state);
        nightWindows.configureMaterial(first, state);   // a second call does not chain twice
        nightWindows.configureMaterial(second, state);
        const s1 = phongShader(), s2 = phongShader();
        first.onBeforeCompile(s1);
        second.onBeforeCompile(s2);
        expect(s1.fragmentShader.match(/totalEmissiveRadiance \+= cbNightWindowLight\(\);/g)).toHaveLength(1);
        expect(s1.vertexShader).toContain('vCbNightHeight = transformed.z;');
        expect(s1.uniforms.cbNightGlow).toBe(s2.uniforms.cbNightGlow);
        expect(first.customProgramCacheKey()).toContain(nightWindows.CACHE_KEY);
        expect(nightWindows.setState(state, 0.5, 1.4)).toBe(true);
        expect(nightWindows.setState(state, 0.5, 1.4)).toBe(false);
        expect(s2.uniforms.cbNightGlow.value).toBe(0.5);
        expect(s2.uniforms.cbNightK.value).toBe(1.4);
    });

    it('leaves planning hulls, flagged blocks and non-Phong (imported) materials dark', () => {
        const state = nightWindows.createState();
        const hull = phong();
        nightWindows.configureMaterial(hull, state);
        hull.userData.cbBuildingMaterialRole = 'massing';   // the role is known only after configuration
        const shader = phongShader();
        hull.onBeforeCompile(shader);
        expect(shader.fragmentShader).not.toContain('cbNightWindowLight');
        expect(hull.customProgramCacheKey()).not.toContain(nightWindows.CACHE_KEY);
        const imported = new THREE.MeshStandardMaterial();
        nightWindows.configureMaterial(imported, state);
        expect(imported.customProgramCacheKey()).not.toContain(nightWindows.CACHE_KEY);
    });

    it('chains under grain transparency and procedural facades, which light their own panes', () => {
        const state = nightWindows.createState();
        const material = phong();
        nightWindows.configureMaterial(material, state);
        screenDoor.configureMaterial(material, { coverage: 0.5 });
        facades.configureMaterial(material, facades.buildingDesign('a', 20), facades.createState(THREE), THREE);
        const shader = phongShader();
        material.onBeforeCompile(shader);
        expect(shader.fragmentShader).toContain('discard;');
        expect(shader.fragmentShader).toContain('diffuseColor.rgb = cbFacadeColor(diffuseColor.rgb);');
        expect(shader.fragmentShader).toContain('totalEmissiveRadiance += cbNightWindowLight();');
        // The facade defines its window mask before the night code reads it.
        const define = shader.fragmentShader.indexOf('#define CB_FACADE_WINDOWS');
        expect(define).toBeGreaterThanOrEqual(0);
        expect(define).toBeLessThan(shader.fragmentShader.indexOf('#ifdef CB_FACADE_WINDOWS'));
        expect(shader.fragmentShader).toMatch(/cbFacadeWindowGlass = inWall \*/);
        const key = material.customProgramCacheKey();
        expect(key).toContain(nightWindows.CACHE_KEY);
        expect(key).toContain('cb-facades');
        expect(key).toContain(screenDoor.SHADER_VERSION);
    });

    it('by day mirrors the scene\'s sky in the panes and darkens the foot of each wall', () => {
        const state = nightWindows.createState();
        const material = phong();
        nightWindows.configureMaterial(material, state);
        const shader = phongShader();
        material.onBeforeCompile(shader);
        const fragment = shader.fragmentShader;
        expect(fragment).toContain('vec3 cbSkyColor(vec3 dir)');
        expect(fragment).toContain('diffuseColor.rgb *= cbWallFoot();');
        const glassAt = fragment.indexOf('outgoingLight = cbDayGlass(outgoingLight);');
        expect(glassAt).toBeGreaterThan(fragment.indexOf('vec3 outgoingLight'));
        expect(glassAt).toBeLessThan(fragment.indexOf('#include <opaque_fragment>'));
        // The glass reads whichever sky the scene has, by reference.
        const sky = threeSky.createSky(THREE);
        nightWindows.setSky(state, sky.uniforms);
        expect(shader.uniforms.cbSkyHorizon.value).toBe(sky.uniforms.cbSkyHorizon.value);
        sky.update({ altitudeDeg: 30, azimuthRad: 0 });
        expect(shader.uniforms.cbSkyGlowStrength.value).toBe(sky.uniforms.cbSkyGlowStrength.value);
        nightWindows.setSky(state, null);
        expect(shader.uniforms.cbSkyHorizon.value).toBe(sky.uniforms.cbSkyHorizon.value);
    });

    it('fails clearly if a Three upgrade removes a shader integration point', () => {
        expect(() => nightWindows.patchShader({ vertexShader: '', fragmentShader: '' })).toThrow(/shader chunks/);
    });
});
