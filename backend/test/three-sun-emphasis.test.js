// The design's shadow stands out in the 3D model view while Effects on neighbours is shown
// (frontend/js/three-sun.js emphasise): a second light carries a share of the sun that only the
// design blocks, its shadow map drawn from the design's meshes alone, and the scene's pass skips it.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sun = require('../../frontend/js/three-sun.js');

class Vec {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    clone() { return new Vec(this.x, this.y, this.z); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}
class Obj {
    constructor() { this.position = new Vec(); this.children = []; this.parent = null; this.userData = {}; this.visible = true; }
    add(...objects) { objects.forEach(object => { object.parent = this; this.children.push(object); }); }
    remove(...objects) { this.children = this.children.filter(child => !objects.includes(child)); objects.forEach(object => { object.parent = null; }); }
    updateMatrixWorld() {}
    traverse(fn) { fn(this); this.children.forEach(child => child.traverse(fn)); }
}
class Camera {
    constructor() { this.left = -1; this.right = 1; this.top = 1; this.bottom = -1; this.near = 1; this.far = 10; }
    copy(other) { Object.assign(this, { left: other.left, right: other.right, top: other.top, bottom: other.bottom, near: other.near, far: other.far }); return this; }
    updateProjectionMatrix() {}
}
class DirectionalLight extends Obj {
    constructor(color, intensity) {
        super();
        this.color = color ?? { r: 1, g: 1, b: 1 };
        this.intensity = intensity;
        this.castShadow = false;
        this.target = new Obj();
        this.shadow = { mapSize: new Vec(), camera: new Camera(), bias: 0, normalBias: 0, autoUpdate: true, needsUpdate: false };
        this.dispose = vi.fn();
    }
}
const THREE = { DirectionalLight, Group: Obj, PCFShadowMap: 'pcf', SRGBColorSpace: 'srgb' };

function setup() {
    const scene = new Obj();
    const light = new DirectionalLight({ r: 1, g: 1, b: 1 }, 2);
    scene.add(light);
    const design = new Obj();
    design.castShadow = true;
    const draftEnvelope = new Obj();
    draftEnvelope.castShadow = false;
    design.add(draftEnvelope);
    const passes = [];
    const renderer = { capabilities: { maxTextureSize: 4096 }, shadowMap: { enabled: false, autoUpdate: true, needsUpdate: false,
        render: vi.fn((lights, holder) => { passes.push({ lights, casters: holder.children.slice() }); renderer.shadowMap.needsUpdate = false; }) } };
    const camera = { position: new Vec(0, -300, 300) };
    const handle = sun.attach({ THREE, scene, renderer, light, hemi: null,
        getOrigin: () => ({ lat: 51.5, lng: -0.1 }), getK: () => 1, getCamera: () => camera, getTarget: () => new Vec(),
        isPhotoActive: () => false, isAwake: () => true, invalidate: () => {}, excludedRoots: () => [],
        emphasisRoots: () => [design], addFrameHook: () => {}, removeFrameHook: () => {} });
    const emphasis = scene.children.find(child => child.name === 'sun-design-emphasis');
    return { scene, light, emphasis, design, draftEnvelope, renderer, passes, handle };
}
// Summer noon in London: the sun is up.
const NOON = new Date(Date.UTC(2026, 5, 21, 12, 0));

describe('the design shadow emphasis', () => {
    it("lets the sun's light through as before while nothing is emphasised", () => {
        sun.state.enabled = true;
        sun.state.dateISO = '2026-06-21';
        sun.state.minutes = 12 * 60;
        const { light, emphasis, renderer, passes, handle } = setup();
        sun.emphasise(false);
        handle.beforeRender({ fullFrame: true, sceneChanged: true }, NOON);
        expect(light.castShadow).toBe(true);
        expect(emphasis.intensity).toBe(0);
        expect(emphasis.castShadow).toBe(false);
        expect(passes).toEqual([]);
        expect(renderer.shadowMap.needsUpdate).toBe(true);
        handle.detach();
    });

    it("moves a share of the sun to a light only the design's casting meshes block, drawn in a pass of its own", () => {
        sun.state.enabled = true;
        sun.state.dateISO = '2026-06-21';
        sun.state.minutes = 12 * 60;
        const { scene, light, emphasis, design, renderer, passes, handle } = setup();
        handle.beforeRender({ fullFrame: true, sceneChanged: true }, NOON);
        const full = light.intensity;
        sun.emphasise(true);
        handle.beforeRender({ fullFrame: true, sceneChanged: false }, NOON);
        expect(light.intensity + emphasis.intensity).toBeCloseTo(full, 6);
        expect(emphasis.intensity / full).toBeCloseTo(sun.EMPHASIS_SHARE, 6);
        expect(emphasis.castShadow).toBe(true);
        // The same place and frame as the sun.
        expect(emphasis.position).toEqual(light.position);
        expect(emphasis.target.position).toEqual(light.target.position);
        expect(emphasis.shadow.camera.left).toBe(light.shadow.camera.left);
        // Its own pass: that light alone, the design's casting meshes alone (not its envelope).
        expect(passes.at(-1).lights).toEqual([emphasis]);
        expect(passes.at(-1).casters).toEqual([design]);
        // The scene's pass still runs and does not redraw the second light's map.
        expect(renderer.shadowMap.needsUpdate).toBe(true);
        expect(emphasis.shadow.autoUpdate).toBe(false);
        // Off again: the sun takes its whole light back.
        sun.emphasise(false);
        handle.beforeRender({ fullFrame: true, sceneChanged: false }, NOON);
        expect(light.intensity).toBeCloseTo(full, 6);
        expect(emphasis.castShadow).toBe(false);
        handle.detach();
        expect(scene.children.includes(emphasis)).toBe(false);
        expect(emphasis.dispose).toHaveBeenCalled();
    });
});
