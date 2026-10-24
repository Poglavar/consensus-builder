// Full camera pose conversion preserves metric position and unrestricted orientation.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), THREE = require('three');
const proj4 = require('../../frontend/vendor/proj4-2.22.0/proj4.js');
vi.stubGlobal('proj4', proj4);
afterAll(() => vi.unstubAllGlobals());
const { createAdapter } = require('../../frontend/js/camera-flight-camera.js');
const metricFrame = require('../../frontend/js/metric-frame.js');

function setup(anchor = [16, 46], origin = [15.8, 45.9], angle = 0) {
    const projection = proj4('EPSG:4326', 'EPSG:3857'), offset = projection.forward(origin);
    const c = Math.cos(angle), s = Math.sin(angle), camera = new THREE.PerspectiveCamera(45, 1, 1, 2000);
    const controls = { target: new THREE.Vector3(), update: vi.fn() };
    const internals = {
        camera, controls, renderer: { dispose: vi.fn() },
        latLngToXY(lat, lng) {
            const p = projection.forward([lng, lat]), x = p[0] - offset[0], y = p[1] - offset[1];
            return [c * x - s * y, s * x + c * y];
        },
        xyToLatLng(x, y) {
            const p = projection.inverse([c * x + s * y + offset[0], -s * x + c * y + offset[1]]);
            return { lng: p[0], lat: p[1] };
        }
    };
    return { adapter: createAdapter({ THREE, internals, metricFrame, frame: { lng: anchor[0], lat: anchor[1], datum: 'model-ground' } }), internals };
}
function expectPosition(actual, expected, tolerance = 2e-6) {
    actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThan(tolerance));
}
function expectRotation(actual, expected, tolerance = 2e-7) {
    const a = new THREE.Quaternion().fromArray(actual), b = new THREE.Quaternion().fromArray(expected);
    expect(1 - Math.abs(a.dot(b))).toBeLessThan(tolerance);
}
function pose(position, x, y, z, fov = 64) {
    return { position, quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'ZYX')).toArray(), fov };
}

describe('metric flight camera adapter', () => {
    it('uses a domain-safe derivative stencil for poses at the 60 km circular edge', () => {
        const { adapter } = setup();
        for (const position of [[60000, 0, 1.65], [0, -60000, 1.65], [36000, 48000, 1.65]]) {
            const input = pose(position, 0.3, -0.4, 1.1);
            expect(() => adapter.apply(input)).not.toThrow();
            expectRotation(adapter.capture().quaternion, input.quaternion, 1e-10);
        }
    });
    it.each([[16, 46], [-73.9, 40.7], [18, 70], [31, -35], [0, 0]])('round-trips local-tmerc positions at anchor %j', (lng, lat) => {
        const { adapter, internals } = setup([lng, lat], [lng + .1, lat - .1]);
        const metric = metricFrame.frameAt([lng, lat]);
        for (const point of [[0, 0, 0], [125.75, -86.4, 1.65], [12000, 17000, -8.25]]) {
            const ll = metric.toLngLat(point), expected = internals.latLngToXY(ll[1], ll[0]);
            const scene = adapter.toScene(point);
            expectPosition(scene.toArray(), [...expected, point[2]], 1e-10);
            expectPosition(adapter.fromScene(scene), point);expectPosition(adapter.fromScene(scene.toArray()), point);
        }
    });
    it('keeps model Z in true metres while the high-latitude scene stretches horizontal metres', () => {
        const { adapter } = setup([12, 70], [12, 70]);
        const origin = adapter.toScene([0, 0, 0]), raised = adapter.toScene([1, 0, 1.65]);
        expect(raised.x - origin.x).toBeGreaterThan(2.8);expect(raised.z).toBe(1.65);
    });
    it.each([0, 1.2, -2.1])('round-trips arbitrary roll and pole crossings with scene rotation %s', angle => {
        const { adapter } = setup([16, 72], [16.2, 72.1], angle);
        const orientations = [[.5, .8, 1.7], [Math.PI, .3, -1.9], [0, 0, 2.8],
            [Math.PI / 2, 0, .9], [-Math.PI / 2, 0, -2.4], [Math.PI / 2 + 1e-8, 0, 1.4]];
        for (const orientation of orientations) {
            const input = pose([22000, 12000, 1.65], ...orientation);adapter.apply(input);
            const output = adapter.capture();expectPosition(output.position, input.position);expectRotation(output.quaternion, input.quaternion, 1e-12);expect(output.fov).toBe(input.fov);
            adapter.apply(output);expectRotation(adapter.capture().quaternion, input.quaternion, 1e-12);
        }
    });
    it('maps camera forward using the actual projection derivative, including rotated local axes', () => {
        const { adapter, internals } = setup([16, 70], [16, 69.9], .65);
        const input = pose([22000, -10000, 1.65], .7, -.9, 1.3);adapter.apply(input);
        const rotation = new THREE.Quaternion().fromArray(input.quaternion), localForward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation);
        const epsilon = .01, end = input.position.map((p, i) => p + localForward.getComponent(i) * epsilon);
        const expected = adapter.toScene(end).sub(adapter.toScene(input.position)).normalize();
        expect(internals.camera.getWorldDirection(new THREE.Vector3()).distanceTo(expected)).toBeLessThan(1e-6);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(internals.camera.quaternion);
        expect(up.distanceTo(internals.camera.up)).toBeLessThan(1e-12);
    });
    it('captures an existing independently rotated scene camera and reapplies the same complete pose', () => {
        const { adapter, internals } = setup([25, 60], [24.9, 60.1], -.7), camera = internals.camera;
        camera.position.copy(adapter.toScene([1500, -2300, 36]));camera.quaternion.setFromEuler(new THREE.Euler(1.9, -.7, 2.5, 'XYZ'));camera.fov = 73;
        const position = camera.position.clone(), quaternion = camera.quaternion.clone();const captured = adapter.capture();adapter.apply(captured);
        expect(camera.position.distanceTo(position)).toBeLessThan(2e-6);expectRotation(camera.quaternion.toArray(), quaternion.toArray(), 1e-12);expect(camera.fov).toBe(73);
    });
    it('uses bounded indoor clipping and never lets controls or renderer own the camera', () => {
        const { adapter, internals } = setup();const camera = internals.camera;camera.far = 9000;
        adapter.apply(pose([0, 0, 1.65], .2, -.4, .7));expect(camera.near).toBe(.035);expect(camera.far).toBe(5000);
        expect(internals.controls.target.distanceTo(camera.position)).toBeCloseTo(10);expect(internals.controls.update).not.toHaveBeenCalled();expect(internals.renderer.dispose).not.toHaveBeenCalled();
        camera.far = 100;adapter.apply(pose([0, 0, 1.65], .2, -.4, .7));expect(camera.far).toBe(5000);
        adapter.apply(pose([10000, 0, 0], .2, -.4, .7));expect(camera.far).toBe(20000);
        adapter.apply(pose([0, 0, 1e7], .2, -.4, .7));expect(camera.far).toBe(200000);
    });
    it('rejects malformed, non-normalized and out-of-domain poses before changing the camera', () => {
        const { adapter, internals } = setup(), camera = internals.camera, before = camera.position.toArray();
        const input = pose([1, 2, 3], 0, 0, 0);
        for (const invalid of [{ ...input, fov: 180 }, { ...input, fov: NaN }, { ...input, position: [0, Infinity, 1] },
            { ...input, quaternion: [0, 0, 0, 2] }, { ...input, quaternion: [0, 0, 0, 0] }, { ...input, position: [90000, 0, 0] }]) {
            expect(() => adapter.apply(invalid)).toThrow();expect(camera.position.toArray()).toEqual(before);
        }
        expect(() => adapter.toScene([1, 2])).toThrow('three finite');expect(() => adapter.fromScene([NaN, 0, 0])).toThrow('finite');
    });
    it('requires canonical anchors and the explicit model-ground vertical datum', () => {
        const { internals } = setup();
        expect(() => createAdapter({ THREE, internals, metricFrame, frame: { lng: 16.1234567, lat: 46, datum: 'model-ground' } })).toThrow('6 decimals');
        expect(() => createAdapter({ THREE, internals, metricFrame, frame: { lng: 16, lat: 46, datum: 'sea-level' } })).toThrow('model-ground');
    });
});
