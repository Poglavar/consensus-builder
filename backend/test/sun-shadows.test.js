// Sun and shadows in the 3D model view: local wall-clock conversions through IANA zones, the sun's
// direction in the scene's Mercator-scaled frame, the daylight window, the shadow camera's fit, and
// how three-sun.js drives the scene's light and the meshes' shadow flags.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../frontend/js/sun-shadows.js');
const threeSun = require('../../frontend/js/three-sun.js');
const SunCalc = require('../../frontend/vendor/suncalc-1.9.0/suncalc.js');
const tzlookup = require('../../frontend/vendor/tz-lookup-11.7.0/tz.js');

const ZAGREB = { lat: 45.8131, lng: 15.9775, timeZone: 'Europe/Zagreb' };
const DEG = Math.PI / 180;

describe('local wall clock in a zone', () => {
    it('turns a local date and time into the instant, across DST', () => {
        expect(core.localToInstant('2026-06-21', 12 * 60, 'Europe/Zagreb').toISOString()).toBe('2026-06-21T10:00:00.000Z');
        expect(core.localToInstant('2026-01-15', 12 * 60, 'Europe/Zagreb').toISOString()).toBe('2026-01-15T11:00:00.000Z');
        expect(core.localToInstant('2026-07-04', 9 * 60 + 30, 'America/New_York').toISOString()).toBe('2026-07-04T13:30:00.000Z');
        expect(core.localToInstant('2026-12-31', 23 * 60, 'Pacific/Auckland').toISOString()).toBe('2026-12-31T10:00:00.000Z');
    });

    it('resolves a wall time skipped by spring-forward to the instant one offset later', () => {
        // 02:30 does not exist in Zagreb on 2026-03-29; it reads as 03:30 CEST.
        expect(core.localToInstant('2026-03-29', 2 * 60 + 30, 'Europe/Zagreb').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    });

    it('reads the date and minutes back on the zone clock, not the host clock', () => {
        const instant = new Date('2026-06-21T23:30:00Z');
        expect(core.localDateISO(instant, 'Europe/Zagreb')).toBe('2026-06-22');
        expect(core.localMinutes(instant, 'Europe/Zagreb')).toBe(90);
        expect(core.localDateISO(instant, 'America/Los_Angeles')).toBe('2026-06-21');
        expect(core.formatMinutes(90)).toBe('01:30');
        expect(core.formatMinutes(1439)).toBe('23:59');
    });

    it('rejects a malformed date instead of guessing one', () => {
        expect(() => core.localToInstant('21.6.2026', 600, 'Europe/Zagreb')).toThrow(RangeError);
        expect(() => core.localToInstant('2026-06-21', null, 'Europe/Zagreb')).toThrow(RangeError);
    });
});

describe('sun direction in the scene frame', () => {
    it('points south when the sun is due south, west when due west', () => {
        const south = core.sunDirection(45 * DEG, 0, 1);
        expect(south.x).toBeCloseTo(0, 9);
        expect(south.y).toBeCloseTo(-Math.SQRT1_2, 9);
        expect(south.z).toBeCloseTo(Math.SQRT1_2, 9);
        const west = core.sunDirection(0, Math.PI / 2, 1);
        expect(west.x).toBeCloseTo(-1, 9);
        expect(west.y).toBeCloseTo(0, 9);
    });

    it('scales the ground part by the Mercator factor, so shadows keep their true length', () => {
        // A 10 m pole under a 30° sun throws a 17.32 m shadow; in scene XY that is 17.32·k units.
        const k = 1 / Math.cos(ZAGREB.lat * DEG);
        const d = core.sunDirection(30 * DEG, 0.7, k);
        const sceneShadow = 10 * Math.hypot(d.x, d.y) / d.z;
        expect(sceneShadow).toBeCloseTo(10 / Math.tan(30 * DEG) * k, 6);
        expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12);
    });

    it('has no direction without finite inputs', () => {
        expect(core.sunDirection(null, 0, 1)).toBeNull();
        expect(core.sunDirection(0.3, 0, 0)).toBeNull();
    });

    it('fades the direct light in over the first ten degrees and has none at night', () => {
        expect(core.sunStrength(-0.1)).toBe(0);
        expect(core.sunStrength(0)).toBe(0);
        expect(core.sunStrength(5 * DEG)).toBeGreaterThan(0.4);
        expect(core.sunStrength(5 * DEG)).toBeLessThan(0.6);
        expect(core.sunStrength(30 * DEG)).toBe(1);
    });
});

describe('daylight at a place', () => {
    it('gives Zagreb its midsummer sunrise, sunset and solar noon in CEST', () => {
        const day = core.daylight(SunCalc, '2026-06-21', ZAGREB.lat, ZAGREB.lng, ZAGREB.timeZone);
        expect(day.sunrise).toBeGreaterThanOrEqual(4 * 60 + 55);
        expect(day.sunrise).toBeLessThanOrEqual(5 * 60 + 10);
        expect(day.sunset).toBeGreaterThanOrEqual(20 * 60 + 35);
        expect(day.sunset).toBeLessThanOrEqual(20 * 60 + 55);
        expect(day.solarNoon).toBeGreaterThanOrEqual(12 * 60 + 50);
        expect(day.solarNoon).toBeLessThanOrEqual(13 * 60 + 5);
        expect(day.polar).toBeNull();
        // Noon altitude at the solstice is 90° − latitude + 23.44°.
        const noon = core.localToInstant('2026-06-21', day.solarNoon, ZAGREB.timeZone);
        const altitude = SunCalc.getPosition(noon, ZAGREB.lat, ZAGREB.lng).altitude / DEG;
        expect(altitude).toBeCloseTo(90 - ZAGREB.lat + 23.44, 0);
    });

    it('tells polar day from polar night where the sun does not set or rise', () => {
        const polarDay = core.daylight(SunCalc, '2026-06-21', 69.65, 18.96, 'Europe/Oslo');
        expect(polarDay).toMatchObject({ sunrise: null, sunset: null, polar: 'day' });
        const polarNight = core.daylight(SunCalc, '2026-12-21', 69.65, 18.96, 'Europe/Oslo');
        expect(polarNight).toMatchObject({ sunrise: null, sunset: null, polar: 'night' });
    });

    it('opens on now while the sun is up; at night a playing day starts at sunrise, a paused one at noon', () => {
        const day = { sunrise: 300, sunset: 1240, solarNoon: 778 };
        expect(core.initialMinutes(600, day, true)).toBe(600);
        expect(core.initialMinutes(1300, day, true)).toBe(300);
        expect(core.initialMinutes(1300, day, false)).toBe(778);
        expect(core.initialMinutes(100, day, false)).toBe(778);
        expect(core.initialMinutes(100, { sunrise: null, sunset: null, solarNoon: 720 }, true)).toBe(100);
    });

    it('plays a full day per cycle and wraps past midnight', () => {
        expect(core.advanceMinutes(600, 60000, 60000)).toBeCloseTo(600, 9);
        expect(core.advanceMinutes(600, 1000, 60000)).toBeCloseTo(624, 9);
        expect(core.advanceMinutes(1430, 1000, 60000)).toBeCloseTo(14, 9);
        expect(core.advanceMinutes(600, 0, 60000)).toBe(600);
        expect(core.advanceMinutes(600, -5, 60000)).toBe(600);
    });

    it('brightens the sun icon from the horizon to 45° up, and has none at night', () => {
        expect(core.sunGlow(-0.2)).toBe(0);
        expect(core.sunGlow(22.5 * DEG)).toBeCloseTo(0.5, 9);
        expect(core.sunGlow(60 * DEG)).toBe(1);
        expect(core.formatMinutes(539.9)).toBe('08:59');
    });
});

describe('shadow camera fit', () => {
    it('grows with distance in 25% steps, so a small zoom keeps the same map', () => {
        const a = core.shadowFrame({ targetX: 0, targetY: 0, distance: 400, mapSize: 4096 });
        const b = core.shadowFrame({ targetX: 0, targetY: 0, distance: 405, mapSize: 4096 });
        expect(a.halfExtent).toBe(b.halfExtent);
        expect(a.halfExtent).toBeGreaterThanOrEqual(360);
        expect(a.halfExtent).toBeLessThan(360 * 1.25);
        expect(core.shadowFrame({ targetX: 0, targetY: 0, distance: 1, mapSize: 4096 }).halfExtent).toBe(30);
        expect(core.shadowFrame({ targetX: 0, targetY: 0, distance: 1e7, mapSize: 4096 }).halfExtent).toBe(3000);
    });

    it('snaps its centre to whole texels', () => {
        const f = core.shadowFrame({ targetX: 123.456, targetY: -78.9, distance: 300, mapSize: 2048 });
        expect(f.texel).toBeCloseTo(2 * f.halfExtent / 2048, 12);
        expect(Math.abs(f.centerX / f.texel - Math.round(f.centerX / f.texel))).toBeLessThan(1e-9);
        expect(Math.abs(f.centerX - 123.456)).toBeLessThanOrEqual(f.texel / 2);
        expect(f.far).toBeGreaterThan(f.lightDistance + 2 * f.halfExtent);
    });
});

// Minimal stand-ins for the three.js objects three-sun.js touches.
class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    clone() { return new Vec3(this.x, this.y, this.z); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}
const lit = () => ({ isMeshLambertMaterial: true, transparent: false });
function mesh(material, height, extra = {}) {
    return {
        isMesh: true, material, children: [], userData: {}, scale: { z: 1 },
        geometry: { uuid: `g${height}`, boundingBox: { min: { z: 0 }, max: { z: height } } }, ...extra
    };
}

describe('shadow flags', () => {
    it('lets lit tall meshes cast (ghosts too), lit meshes receive, and leaves out overlays and excluded roots', () => {
        const tower = mesh(lit(), 20);
        const ground = mesh(lit(), 0.05);
        const label = mesh({ isMeshBasicMaterial: true }, 5);
        const ghost = mesh({ isMeshPhongMaterial: true, transparent: true, opacity: 0.35 }, 20);
        const veil = mesh({ isMeshPhongMaterial: true, transparent: true, opacity: 0.05 }, 20);
        const person = mesh(lit(), 1.8);
        const life = { children: [person] };
        const scene = { children: [tower, ground, label, ghost, veil, life] };
        threeSun.applyShadowFlags(scene, true, new Set([life]));
        expect([tower.castShadow, tower.receiveShadow]).toEqual([true, true]);
        expect([ground.castShadow, ground.receiveShadow]).toEqual([false, true]);
        expect([label.castShadow, label.receiveShadow]).toEqual([false, false]);
        expect([ghost.castShadow, ghost.receiveShadow]).toEqual([true, true]);
        expect([veil.castShadow, veil.receiveShadow]).toEqual([false, true]);
        expect(person.castShadow).toBeUndefined();
    });
});

describe('the sun in the scene', () => {
    let scene, light, hemi, renderer, camera, target, origin, photo, invalidations, handle, hooks;

    beforeEach(() => {
        threeSun.detach();
        threeSun.state.enabled = true;
        threeSun.state.playing = false;
        threeSun.state.dateISO = '2026-06-21';
        threeSun.state.minutes = null;
        scene = { children: [mesh(lit(), 30)], add(o) { o.parent = scene; }, remove(o) { o.parent = null; } };
        light = {
            position: new Vec3(200, 200, 400), intensity: 2.5, castShadow: false,
            target: { position: new Vec3(), parent: null, updateMatrixWorld() {} },
            shadow: { mapSize: { set(w, h) { this.w = w; this.h = h; } }, camera: { updateProjectionMatrix() {} } }
        };
        hemi = { intensity: 1.9 };
        renderer = { shadowMap: {}, capabilities: { maxTextureSize: 16384 } };
        camera = { position: new Vec3(0, -300, 300) };
        target = new Vec3(0, 0, 0);
        origin = { lat: ZAGREB.lat, lng: ZAGREB.lng };
        photo = false;
        invalidations = 0;
        hooks = new Set();
        handle = attach();
    });

    function attach() {
        return threeSun.attach({
            THREE: { PCFShadowMap: 1 }, scene, renderer, light, hemi,
            getOrigin: () => origin, getK: () => 1 / Math.cos(ZAGREB.lat * DEG),
            getCamera: () => camera, getTarget: () => target,
            isPhotoActive: () => photo, invalidate: () => { invalidations++; }, excludedRoots: () => [],
            addFrameHook: fn => hooks.add(fn), removeFrameHook: fn => hooks.delete(fn)
        });
    }

    it('gives a replaced planning subtree its shadow flags before the next draw', () => {
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T10:00:00Z'));
        const replacement = mesh(lit(), 30);
        expect(replacement.castShadow).toBeFalsy();
        renderer.shadowMap.needsUpdate = false;
        handle.syncObjects(replacement);
        expect(replacement.castShadow).toBe(true);
        expect(replacement.receiveShadow).toBe(true);
        expect(renderer.shadowMap.needsUpdate).toBe(true);
        threeSun.state.enabled = false;
        handle.syncObjects(replacement);
        expect(replacement.castShadow).toBe(false);
        expect(replacement.receiveShadow).toBe(false);
    });

    it('plays the day from a frame hook only while playing, one full day per cycle', () => {
        expect(hooks.size).toBe(0);
        threeSun.state.playing = true;
        threeSun.state.minutes = 600;
        handle = attach();
        expect(hooks.size).toBe(1);
        const lightAt = () => light.position.clone();
        handle.beforeRender({ fullFrame: false }, new Date('2026-06-21T10:00:00Z'));
        const before = lightAt();
        handle.onFrame(1000);
        const wait = handle.onFrame(1000 + 50);   // 50 ms of a 60 s day = 1.2 minutes
        expect(threeSun.state.minutes).toBeCloseTo(600 + 50 * 1440 / threeSun.DAY_CYCLE_MS, 9);
        // The hook asks for its next frame just past the next 3-minute step: 1.8 minutes = 75 ms, plus a
        // one-frame margin.
        expect(wait).toBe(95);
        renderer.shadowMap.needsUpdate = false;
        handle.beforeRender({ fullFrame: false }, new Date('2026-06-21T10:00:00Z'));
        // The clock runs every frame, but the light (and the shadow pass) moves in 3-minute steps:
        // 601.2 is still in the step that began at 600.
        expect(lightAt().x).toBe(before.x);
        expect(renderer.shadowMap.needsUpdate).toBe(false);
        handle.onFrame(1000 + 150);  // 603.6 minutes: into the next step
        expect(threeSun.state.minutes).toBeCloseTo(600 + 150 * 1440 / threeSun.DAY_CYCLE_MS, 9);
        handle.beforeRender({ fullFrame: false }, new Date('2026-06-21T10:00:00Z'));
        expect(lightAt().x).not.toBe(before.x);
        // A frame that only advanced the day across a step re-renders the shadow map: the sun moved.
        expect(renderer.shadowMap.needsUpdate).toBe(true);
        handle.onFrame(1000 + 150 + 5000);  // a stalled tab moves the sun by at most one frame cap (500 ms)
        expect(threeSun.state.minutes).toBeCloseTo(600 + 650 * 1440 / threeSun.DAY_CYCLE_MS, 9);
        threeSun.detach();
        expect(hooks.size).toBe(0);
    });

    it('starts a playing night at sunrise and keeps running from there', () => {
        threeSun.state.playing = true;
        threeSun.state.dateISO = null;
        handle = attach();
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T22:00:00Z')); // midnight in Zagreb
        const day = core.daylight(SunCalc, '2026-06-22', ZAGREB.lat, ZAGREB.lng, ZAGREB.timeZone);
        expect(threeSun.state.minutes).toBe(day.sunrise);
    });

    it('puts the light up the sun ray over the place at the chosen local time, casting shadows', () => {
        threeSun.state.minutes = 9 * 60; // 09:00 CEST: the sun is in the east-south-east
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T07:00:00Z'));
        const offset = { x: light.position.x - light.target.position.x, y: light.position.y - light.target.position.y, z: light.position.z };
        expect(offset.x).toBeGreaterThan(0);                // east
        expect(offset.z).toBeGreaterThan(0);                // above the horizon
        expect(light.castShadow).toBe(true);
        expect(light.intensity).toBeCloseTo(2.5, 6);
        expect(renderer.shadowMap.enabled).toBe(true);
        expect(renderer.shadowMap.needsUpdate).toBe(true);
        expect(scene.children[0].castShadow).toBe(true);
        expect(light.target.parent).toBe(scene);
    });

    it('opens a night view on solar noon, and a chosen night time has no direct light', () => {
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T22:00:00Z')); // midnight in Zagreb
        expect(light.castShadow).toBe(true);
        threeSun.state.minutes = 23 * 60;
        threeSun.state.enabled = true;
        // The UI marks the sun dirty when the time changes; a re-attach does the same here.
        handle = attach();
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T22:00:00Z'));
        expect(light.castShadow).toBe(false);
        expect(light.intensity).toBe(0);
        expect(hemi.intensity).toBeCloseTo(1.9 * 0.6, 6);
    });

    it('restores the fixed light when switched off or in photo view', () => {
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T10:00:00Z'));
        expect(light.castShadow).toBe(true);
        photo = true;
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T10:00:00Z'));
        expect(light.castShadow).toBe(false);
        expect([light.position.x, light.position.y, light.position.z]).toEqual([200, 200, 400]);
        expect(light.intensity).toBe(2.5);
        photo = false;
        threeSun.state.enabled = false;
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T10:00:00Z'));
        expect(light.castShadow).toBe(false);
        expect(hemi.intensity).toBe(1.9);
    });

    it('follows the scene to another place and its time zone', () => {
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T10:00:00Z'));
        origin = { lat: 40.7128, lng: -74.006 };
        handle.beforeRender({ fullFrame: true }, new Date('2026-06-21T10:00:00Z'));
        expect(threeSun.placeOf(origin).timeZone).toBe('America/New_York');
        expect(tzlookup(ZAGREB.lat, ZAGREB.lng)).toBe('Europe/Zagreb');
    });
});
