// Apartment camera handoffs preserve registered metrics and clean up host-owned walking hooks.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';
const require = createRequire(import.meta.url), THREE = require('three');
const Apartment = require('../../frontend/js/camera-flight-apartment.js');
const copy = value => JSON.parse(JSON.stringify(value));
const labels = { people: ['Camera', 'Apartment'], firstPerson: 'Explore', personView: () => 'Explore', back: 'Back',
    overview: 'Overview', choosePerson: 'Choose', walkStick: 'Walk', walkHint: () => 'Walking', noRoute: 'Unavailable' };
function choice(elevationM = 3) {
    const corners = [[0, 0], [0.02, 0], [0.02, 0.01], [0, 0.01]];
    return { feature: { type: 'Feature', properties: { floorPlans: { registration: { corners } } } }, unit: {
        id: 'floor-1/apartment/a', floorId: 'floor-1', apartmentId: 'a', elevationM, entryUv: [0.25, 0.3],
        registration: { corners: [[0.004, 0.002], [0.016, 0.002], [0.016, 0.008], [0.004, 0.008]] },
        architecture: { dimensionsM: [12, 6], wallHeightM: 2.8, slabs: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]] } } };
}
function setup() {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200000);
    const renderer = { toneMapping: 12 }, controls = { target: new THREE.Vector3(), enabled: false };
    camera.position.set(-10, -10, 2); camera.up.set(0, 0, 1); camera.updateMatrixWorld();
    let cleanup = null, settings = { xray: '0', suggested: '1', cutaway: 'all' };
    const hooks = new Set(), attachments = [], events = [];
    const session = { internals: { scene, camera, renderer, controls, latLngToXY: (lat, lng) => [lng * 2000, lat * 2000] },
        fromScene: p => [p[0] / 2, p[1] / 2, p[2]],
        capture: () => ({ position: [camera.position.x / 2, camera.position.y / 2, camera.position.z], quaternion: camera.quaternion.toArray(), fov: camera.fov }),
        apply: vi.fn(pose => { camera.position.set(pose.position[0] * 2, pose.position[1] * 2, pose.position[2]); camera.quaternion.fromArray(pose.quaternion); camera.fov = pose.fov; camera.updateMatrixWorld(); }),
        pause: vi.fn(() => events.push('pause')),
        exitWalking: vi.fn(() => { if (cleanup) { const fn = cleanup; cleanup = null; fn(); } }),
        setWalking: vi.fn(fn => { session.exitWalking(); cleanup = fn; }) };
    const win = { THREE, turf, ensureInteriorViewer: vi.fn(async () => { events.push('load'); }),
        getThreeInteriorView: () => copy(settings),
        applyThreeInteriorView: vi.fn(async next => { settings = { ...next }; events.push('settings'); }),
        invalidateThreeView: vi.fn(), registerThreeModeFrameHook: vi.fn(hook => hooks.add(hook)),
        unregisterThreeModeFrameHook: vi.fn(hook => hooks.delete(hook)), matchMedia: () => ({ matches: false }),
        InteriorViewer: { attach: vi.fn(options => {
            events.push('attach');
            const root = new THREE.Group(), group = new THREE.Group(), part = new THREE.Object3D(), figures = new THREE.Object3D();
            root.matrix.copy(options.placement.matrix); root.matrixAutoUpdate = false; root.add(group); scene.add(root);
            part.name = 'UnitPart:wall'; figures.name = 'ApartmentPeople'; group.add(part, figures);
            let saved = null;
            const update = vi.fn(() => true), remove = options.animate({ active: () => true, update });
            const attachment = { root, group, walkers: [{ x: 0, y: 0, heading: 0, path: [1], moving: true }], update,
                navigation: { canWalk: vi.fn(() => true) },
                personView: { enter: vi.fn(() => { saved = session.capture(); camera.fov = 75; camera.quaternion.setFromEuler(new THREE.Euler(0.2, 0, 0)); }) },
                dispose: vi.fn(() => { remove(); root.removeFromParent(); if (saved) session.apply(saved); }) };
            attachments.push(attachment); return attachment;
        }) } };
    session.setView = vi.fn(settings => win.applyThreeInteriorView(settings));
    const controller = Apartment.browser(win, session, { host: {}, labels });
    return { win, session, controller, scene, camera, renderer, controls, hooks, attachments, events };
}
const expectVector = (actual, expected, precision = 8) => actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i], precision));

describe('registered apartment camera geometry', () => {
    it('uses the source building UV for entry, true floor height and a level center-facing orientation', () => {
        const { session } = setup(), selected = choice();
        const pose = Apartment.entryPose({ THREE, session, ...selected, fov: 62 });
        expectVector(pose.position, [5, 3, 4.65]); expect(pose.fov).toBe(62);
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(pose.quaternion));
        expectVector(forward.toArray(), new THREE.Vector3(5, 2, 0).normalize().toArray());
        expectVector(new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().fromArray(pose.quaternion)).toArray(), [0, 0, 1]);
    });

    it('uses the eastward fallback only at a coincident center, retaining nearby intended aim', () => {
        const { session } = setup(), selected = choice(); selected.unit.entryUv = [0.5, 0.5];
        const forward = () => new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(
            Apartment.entryPose({ THREE, session, ...selected, fov: 45 }).quaternion));
        expect(forward().x).toBeCloseTo(1, 8);
        selected.unit.entryUv[0] += 0.00001; expect(forward().x).toBeCloseTo(-1, 8);
    });

    it('places all four unit-local corners at their projected registration corners and retains model Z', () => {
        const { session } = setup(), { unit } = choice(-3), matrix = Apartment.placement({ THREE, session, unit });
        const local = [[0, 6, 0], [12, 6, 0], [12, 0, 0], [0, 0, 0]];
        local.forEach((p, i) => expectVector(new THREE.Vector3(...p).applyMatrix4(matrix).toArray(), [unit.registration.corners[i][0] * 2000, unit.registration.corners[i][1] * 2000, -3]));
        expectVector(new THREE.Vector3(6, 3, 1.65).applyMatrix4(matrix).toArray(), [20, 10, -1.35]);
    });

    it('rejects materially skewed, degenerate and missing registrations without modifying the camera', () => {
        const { session, camera } = setup(), before = camera.position.toArray();
        for (const mutate of [u => { u.registration.corners[1][0] += 0.001; }, u => { u.registration.corners = Array(4).fill([0, 0]); },
            u => { u.architecture.dimensionsM[0] = 0; }, u => { u.elevationM = null; }, u => { delete u.registration.corners; }]) {
            const { unit } = choice(); mutate(unit); expect(() => Apartment.placement({ THREE, session, unit })).toThrow();
            expect(camera.position.toArray()).toEqual(before);
        }
        const selected = choice(); selected.unit.entryUv = [null, 0];
        expect(() => Apartment.entryPose({ THREE, session, ...selected, fov: 45 })).toThrow(/entry pose/);
    });
});

describe('shared scene apartment handoff', () => {
    it('enters after awaited x-ray setup and retains the scene settings, renderer and environment', async () => {
        const state = setup(), selected = choice(), environment = new THREE.Texture(); state.scene.environment = environment;
        let complete; state.win.applyThreeInteriorView.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const pending = state.controller.enter(selected);
        expect(state.session.apply).not.toHaveBeenCalled(); expect(state.session.pause).toHaveBeenCalled();
        complete(); const pose = await pending;
        expectVector(pose.position, [5, 3, 4.65]); expect(state.session.apply).toHaveBeenCalledWith(pose);
        expect(state.win.applyThreeInteriorView).toHaveBeenCalledWith({ xray: '1', suggested: '1', cutaway: 'all' });
        expect(state.scene.environment).toBe(environment); expect(state.renderer.toneMapping).toBe(12);
    });

    it('finds the actual containing unit using local placement, slab holes and floor eye height', () => {
        const state = setup(), selected = choice(), other = choice(9), matrix = Apartment.placement({ THREE, session: state.session, unit: selected.unit });
        const at = (x, y, z) => { state.camera.position.copy(new THREE.Vector3(x, y, z).applyMatrix4(matrix)); };
        at(4, 2, 1.65); expect(state.controller.chooseAtCamera([other, selected])).toBe(selected);
        for (const p of [[-1, 2, 1.65], [13, 2, 1.65], [4, 2, 0], [4, 2, 2.8], [4, 2, 4]]) {
            at(...p); expect(state.controller.chooseAtCamera([selected])).toBeNull();
        }
        selected.unit.architecture.slabs[0].push([[0.2, 0.5], [0.5, 0.5], [0.5, 0.9], [0.2, 0.9]]);
        at(4, 2, 1.65); expect(state.controller.chooseAtCamera([selected])).toBeNull();
    });

    it('excludes the buffered wall envelope from actual apartment selection', () => {
        const state = setup(), selected = choice(), matrix = Apartment.placement({ THREE, session: state.session, unit: selected.unit });
        selected.unit.boundary = [[[[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]]];
        state.camera.position.copy(new THREE.Vector3(0.3, 2, 1.65).applyMatrix4(matrix));
        expect(state.controller.chooseAtCamera([selected])).toBeNull();
        state.camera.position.copy(new THREE.Vector3(4, 2, 1.65).applyMatrix4(matrix));
        expect(state.controller.chooseAtCamera([selected])).toBe(selected);
    });

    it('lazy-loads walking, hides duplicate unit meshes and registers only host frame hooks', async () => {
        const state = setup(), attachment = await state.controller.explore(choice());
        expect(state.events.indexOf('load')).toBeLessThan(state.events.indexOf('attach'));
        expect(state.hooks.size).toBe(1); expect(attachment.group.getObjectByName('UnitPart:wall').visible).toBe(false);
        expect(attachment.group.getObjectByName('ApartmentPeople').visible).toBe(true);
        expectVector([attachment.walkers[0].x, attachment.walkers[0].y], [1, 5]);
        expect(attachment.walkers[0].path).toEqual([]); expect(attachment.walkers[0].controlled).toBe(true);
        expect(attachment.personView.enter).toHaveBeenCalledWith(0);
        const hook = [...state.hooks][0]; hook(1000); hook(1200);
        expect(attachment.update.mock.calls.map(call => call[0])).toEqual([0, 0.1]);
        const options = state.win.InteriorViewer.attach.mock.calls[0][0]; expect(options.labels).toBe(labels); expect(options.env).toBe(state.win);
        expect(options).not.toHaveProperty('environment'); expect(options).not.toHaveProperty('toneMapping');
        state.controller.exit(); state.controller.exit();
        expect(attachment.dispose).toHaveBeenCalledTimes(1); expect(state.hooks.size).toBe(0); expect(state.scene.children).toHaveLength(0);
    });

    it('preserves the exact flight-end eye and saved complete pose when exploring from inside', async () => {
        const state = setup(), selected = choice(), matrix = Apartment.placement({ THREE, session: state.session, unit: selected.unit });
        state.camera.position.copy(new THREE.Vector3(4, 2, 1.65).applyMatrix4(matrix));
        state.camera.quaternion.setFromEuler(new THREE.Euler(0.4, -0.3, 0.7)); state.camera.fov = 61; state.camera.updateMatrixWorld();
        const original = state.session.capture(), attachment = await state.controller.explore(selected, { preservePose: true });
        expectVector([attachment.walkers[0].x, attachment.walkers[0].y], [4, 2]);
        expectVector(state.camera.position.toArray(), [original.position[0] * 2, original.position[1] * 2, original.position[2]]);
        state.controller.exit(); expect(state.session.capture()).toEqual(original);
        state.camera.position.set(-100, -100, 4.65);
        await expect(state.controller.explore(selected, { preservePose: true })).rejects.toThrow(/outside/);
        expect(state.win.InteriorViewer.attach).toHaveBeenCalledTimes(1);
    });

    it('restores camera/settings and removes host hooks when attachment fails after registering', async () => {
        const state = setup(), before = state.session.capture(), settings = state.win.getThreeInteriorView();
        state.win.InteriorViewer.attach.mockImplementationOnce(options => {
            options.animate({ active: () => true, update: () => true }); throw new Error('attachment failed');
        });
        await expect(state.controller.explore(choice())).rejects.toThrow(/attachment failed/);
        expect(state.hooks.size).toBe(0); expect(state.session.capture()).toEqual(before); expect(state.win.getThreeInteriorView()).toEqual(settings);
        expect(state.session.setWalking).not.toHaveBeenCalled();
    });

    it('disposes a partial attachment when no walkable person view exists', async () => {
        const state = setup(), before = state.session.capture(), attach = state.win.InteriorViewer.attach.getMockImplementation();
        state.win.InteriorViewer.attach.mockImplementationOnce(options => { const result = attach(options); result.personView = null; return result; });
        await expect(state.controller.explore(choice())).rejects.toThrow(/walkable entry/);
        expect(state.attachments[0].dispose).toHaveBeenCalledTimes(1); expect(state.hooks.size).toBe(0); expect(state.scene.children).toHaveLength(0);
        expect(state.session.capture()).toEqual(before);
    });

    it('reports an actual nearby walkable entry and rejects unavailable or blocked preserved eye positions', async () => {
        const state = setup(), attach = state.win.InteriorViewer.attach.getMockImplementation();
        state.win.InteriorViewer.attach.mockImplementationOnce(options => {
            const result = attach(options); result.navigation.canWalk.mockImplementation(([x]) => x >= 1.25); return result;
        });
        const attachment = await state.controller.explore(choice());
        expect(attachment.entryPose.position[0]).toBeGreaterThanOrEqual(5.25);
        expect(attachment.entryPose.position[0]).toBeLessThanOrEqual(5.5);
        expect(attachment.walkers[0].x).toBeGreaterThanOrEqual(1.25); state.controller.exit();
        const before = state.session.capture();
        state.win.InteriorViewer.attach.mockImplementationOnce(options => {
            const result = attach(options); result.navigation.canWalk.mockReturnValue(false); return result;
        });
        await expect(state.controller.explore(choice())).rejects.toThrow(/0.5 metres/);
        expect(state.session.capture()).toEqual(before); expect(state.hooks.size).toBe(0);
        state.win.InteriorViewer.attach.mockImplementationOnce(options => {
            const result = attach(options); result.navigation.canWalk.mockReturnValue(false); return result;
        });
        await expect(state.controller.explore(choice(), { preservePose: true })).rejects.toThrow(/not a walkable/);
        expect(state.session.capture()).toEqual(before); expect(state.hooks.size).toBe(0);
    });

    it('rolls back failed entry settings and rejects incomplete localized walking labels before loading', async () => {
        const state = setup(), before = state.session.capture(), settings = state.win.getThreeInteriorView();
        state.win.applyThreeInteriorView.mockRejectedValueOnce(new Error('settings failed'));
        await expect(state.controller.enter(choice())).rejects.toThrow(/settings failed/);
        expect(state.session.capture()).toEqual(before); expect(state.win.getThreeInteriorView()).toEqual(settings);
        const invalid = Apartment.browser(state.win, state.session, { host: {}, labels: {} });
        await expect(invalid.explore(choice())).rejects.toThrow(/localized labels/); expect(state.win.ensureInteriorViewer).not.toHaveBeenCalled();
    });

    it('cancels a pending lazy load on exit without moving the camera or attaching resources', async () => {
        const state = setup(), before = state.session.capture(); let complete;
        state.win.ensureInteriorViewer.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const pending = state.controller.explore(choice()); state.controller.exit(); complete();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(state.session.capture()).toEqual(before); expect(state.win.InteriorViewer.attach).not.toHaveBeenCalled(); expect(state.hooks.size).toBe(0);
    });
});
