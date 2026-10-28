// Camera sessions own host hooks, snapshots, playback and asynchronous cleanup.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), THREE = require('three');
const Flight = require('../../frontend/js/camera-flight.js');
const Camera = require('../../frontend/js/camera-flight-camera.js');
const Session = require('../../frontend/js/camera-flight-session.js');
const View = require('../../frontend/js/three-view-state.js');
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function flight() {
    const record = Flight.create({ view: { at: '45,16,18', mode: 'model', settings: { ...View.defaults } },
        frame: { lat: 45, lng: 16, datum: 'model-ground' }, pose: { position: [0, 0, 2], quaternion: [0, 0, 0, 1], fov: 45 } });
    record.route.push({ id: 'end', position: [10, 2, 4], quaternion: [0, 0, 0, 1], travelSeconds: 10, holdSeconds: 0, turn: null });return record;
}
// Cues anchor to views: insert a view at `time` on the straight route with explicit timing.
function cueAt(record, time, settings, id = 'cue-' + time) {
    const route = record.route, times = Flight.arrivals(record);
    let i = 0;while (i + 1 < route.length && times[i + 1] <= time) i++;
    const a = route[i], b = route[i + 1], fraction = (time - times[i]) / (times[i + 1] - times[i]);
    const point = { id: 'view-' + id, position: a.position.map((x, k) => x + (b.position[k] - x) * fraction), quaternion: [0, 0, 0, 1], travelSeconds: time - times[i], holdSeconds: 0, turn: null };
    b.travelSeconds = times[i + 1] - time;route.splice(i + 1, 0, point);record.cues.push({ id, at: point.id, settings });
}
function interior(id = 'inside') { return { id, feature: { type: 'Feature', properties: { floorPlans: { marker: id } },
    geometry: { type: 'Polygon', coordinates: [[[16,45],[16.001,45],[16.001,45.001],[16,45]]] } } }; }
class Target {
    listeners = new Map(); captured = new Set();
    addEventListener(type, handler, capture = false) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push({ handler, capture }); }
    removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.handler !== handler)); }
    emit(type, properties = {}) {
        const event = { type, target: { tagName: 'CANVAS' }, key: '', preventDefault: vi.fn(), stopImmediatePropagation() { this.stopped = true; }, ...properties };
        for (const { handler } of [...(this.listeners.get(type) || [])].sort((a,b) => Number(b.capture) - Number(a.capture))) { handler(event); if (event.stopped) break; }
        return event;
    }
    listenerCount() { return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0); }
    setPointerCapture(id) { this.captured.add(id); } hasPointerCapture(id) { return this.captured.has(id); } releasePointerCapture(id) { this.captured.delete(id); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; }
}
function environment() {
    const win = new Target(), canvas = new Target(), doc = new Target(), controls = new Target(), hooks = new Set();
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 1000), scene = new THREE.Scene(), source = new THREE.Group();
    source.name = 'FloorPlans';scene.add(source);camera.position.set(0, -10, 8);camera.up.set(0, 0, 1);camera.lookAt(0, 0, 2);
    controls.enabled = true;controls.target = new THREE.Vector3(0, 0, 2);controls.update = vi.fn(() => false);
    const internals = { camera, controls, renderer: { domElement: canvas }, scene,
        latLngToXY: (lat, lng) => [(lng - 16) * 1000, (lat - 45) * 1000],
        xyToLatLng: (x, y) => ({ lng: 16 + x / 1000, lat: 45 + y / 1000 }) };
    const lease = { floorRoot: null, release: vi.fn(() => { controls.enabled = true; }) };
    let settings = { ...View.defaults }, adapter;
    Object.assign(win, { THREE, document: doc, CameraFlight: Flight, ThreeViewState: View,
        getComputedStyle: () => ({ getPropertyValue: () => '' }), getThreeModeInternals: () => internals,
        __metricFrame: { CONTRACT: { MAX_RADIUS_FROM_ANCHOR_M: 100000 }, frameAt: () => ({ toLngLat: ([x,y]) => [16 + x / 1000, 45 + y / 1000], toMetric: ([lng,lat]) => [(lng - 16) * 1000, (lat - 45) * 1000] }) },
        CameraFlightCamera: { createAdapter(options) { const actual = Camera.createAdapter(options);adapter = { ...actual, apply: vi.fn(actual.apply) };return adapter; } },
        claimThreeCamera: vi.fn(() => { controls.enabled = false;return lease; }),
        registerThreeModeFrameHook: vi.fn(hook => hooks.add(hook)), unregisterThreeModeFrameHook: vi.fn(hook => hooks.delete(hook)), invalidateThreeView: vi.fn(),
        getThreeInteriorView: () => ({ ...settings }), applyThreeInteriorView: vi.fn(async next => { settings = { ...next }; }),
        __buildingFloorPlans: { validateFloorPlans: vi.fn(() => []) },
        __threeFloorPlans: {
            createBuildingGroup: vi.fn(() => { const group = new THREE.Group();group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));return group; }),
            setCutaway: vi.fn(), disposeGroup: vi.fn(group => group.traverse(object => { object.geometry?.dispose();object.material?.dispose(); }))
        }
    });
    return { win, canvas, doc, controls, camera, scene, source, hooks, lease, get adapter() { return adapter; },
        tick(now) { [...hooks].forEach(hook => hook(now)); }, settings(next) { settings = { ...next }; } };
}

describe('camera flight session lifecycle and deterministic clock', () => {
    it('starts idle, uses the supplied camera only, and pauses deterministically on seek', async () => {
        const env = environment(), session = Session.create(env.win, flight());expect(env.hooks.size).toBe(0);
        await session.play();expect(session.playing).toBe(true);expect(env.hooks.size).toBe(1);
        env.tick(1000);env.tick(1100);expect(session.time).toBeCloseTo(.1);expect(env.adapter.apply).toHaveBeenCalledTimes(3);
        expect(env.controls.update).not.toHaveBeenCalled();expect(env.controls.enabled).toBe(false);
        await session.seek(6);expect(session.playing).toBe(false);expect(session.time).toBe(6);expect(env.hooks.size).toBe(0);
        const expected = Flight.compile(flight()).evaluate(6), actual = session.capture();
        actual.position.forEach((value, i) => expect(value).toBeCloseTo(expected.position[i], 7));
        env.tick(90000);expect(session.time).toBe(6);session.dispose();
    });
    it('play waits for seek geometry and pause cancels a pending play without resurrecting hooks', async () => {
        const env = environment(), record = flight(), gate = deferred();record.view.settings.xray = '1';
        env.win.applyThreeInteriorView.mockImplementation(async next => { await gate.promise;env.settings(next); });
        const session = Session.create(env.win, record), playing = session.play();await flush();
        expect(session.playing).toBe(false);expect(env.hooks.size).toBe(0);expect(env.adapter.apply).not.toHaveBeenCalled();
        session.pause();gate.resolve();await playing;expect(session.playing).toBe(false);expect(env.hooks.size).toBe(0);session.dispose();
    });
    it('freezes both pose and clock at an asynchronous cue and resumes without wall-clock catchup', async () => {
        const env = environment(), record = flight(), gate = deferred();cueAt(record, .15, { xray: '1' }, 'xray');
        const session = Session.create(env.win, record);await session.play();env.tick(0);env.tick(100);const before = session.capture();
        env.win.applyThreeInteriorView.mockImplementation(async next => { await gate.promise;env.settings(next); });
        env.tick(200);await flush();expect(session.time).toBeCloseTo(.1);expect(session.capture()).toEqual(before);expect(env.hooks.size).toBe(0);
        env.tick(50000);expect(session.time).toBeCloseTo(.1);gate.resolve();await session.ready;await flush();expect(session.time).toBeCloseTo(.2);expect(env.hooks.size).toBe(1);
        env.tick(60000);expect(session.time).toBeCloseTo(.2);env.tick(60100);expect(session.time).toBeCloseTo(.3);session.dispose();
    });
    it('serializes concurrent state changes and only applies the latest seek pose', async () => {
        const env = environment(), record = flight(), gate = deferred();cueAt(record, .25, { xray: '1' }, 'on');cueAt(record, 1, { xray: '0' }, 'off');
        let active = 0, maximum = 0;
        env.win.applyThreeInteriorView.mockImplementation(async next => { active++;maximum = Math.max(maximum, active);if (next.xray === '1') await gate.promise;env.settings(next);active--; });
        const session = Session.create(env.win, record), first = session.seek(.5);await flush();const last = session.seek(2);await flush();
        expect(env.win.applyThreeInteriorView).toHaveBeenCalledTimes(1);gate.resolve();expect(await first).toBe(false);expect(await last).toBe(true);
        expect(maximum).toBe(1);expect(session.time).toBe(2);expect(env.win.getThreeInteriorView().xray).toBe('0');expect(env.adapter.apply).toHaveBeenCalledTimes(1);session.dispose();
    });
    it('pauses and reports a failed asynchronous cue, leaving no clock hook or new camera pose', async () => {
        const env = environment(), record = flight(), onError = vi.fn();cueAt(record, .05, { xray: '1' });
        const session = Session.create(env.win, record, { onError });await session.play();env.tick(0);const calls = env.adapter.apply.mock.calls.length;
        env.win.applyThreeInteriorView.mockRejectedValue(new Error('Geometry unavailable'));env.tick(100);await flush();
        expect(session.time).toBe(0);expect(session.playing).toBe(false);expect(env.hooks.size).toBe(0);expect(env.adapter.apply).toHaveBeenCalledTimes(calls);expect(onError).toHaveBeenCalledOnce();session.dispose();
    });
    it('installs first-added snapshots once, retains them on route edits and restores source visibility', () => {
        const env = environment(), initial = flight(), session = Session.create(env.win, initial), next = copy(initial);next.interiors = [interior()];
        session.setRecord(next);const snapshot = env.scene.getObjectByName('CameraFlightInteriors').children[0];
        expect(env.win.__threeFloorPlans.createBuildingGroup).toHaveBeenCalledTimes(1);expect(env.source.visible).toBe(false);expect(env.lease.floorRoot.children).toEqual([snapshot]);
        const changed = copy(next);changed.route[1].position[2] = 12;session.setRecord(changed);
        expect(env.win.__threeFloorPlans.createBuildingGroup).toHaveBeenCalledTimes(1);expect(session.snapshotFeatures()).toEqual(next.interiors);
        session.setRecord(initial);expect(env.source.visible).toBe(true);expect(env.lease.floorRoot).toBeNull();expect(env.win.__threeFloorPlans.disposeGroup).toHaveBeenCalledWith(snapshot);session.dispose();
    });
    it('releases a claimed lease and allocated resources if snapshot installation fails before listeners', () => {
        const env = environment(), record = flight();record.interiors = [interior('first'), interior('invalid')];
        env.win.__buildingFloorPlans.validateFloorPlans.mockImplementation(plans => plans.marker === 'invalid' ? ['Invalid source geometry'] : []);
        expect(() => Session.create(env.win, record)).toThrow('Invalid source geometry');expect(env.lease.release).toHaveBeenCalledOnce();
        expect(env.win.__threeFloorPlans.disposeGroup).toHaveBeenCalledOnce();expect(env.scene.children).toEqual([env.source]);
        expect(env.win.listenerCount() + env.canvas.listenerCount() + env.doc.listenerCount() + env.controls.listenerCount()).toBe(0);expect(env.hooks.size).toBe(0);
    });
    it('does not claim a lease when adapter capture or compilation fails', () => {
        const env = environment();env.win.CameraFlightCamera.createAdapter = () => { throw new Error('Invalid metric frame'); };
        expect(() => Session.create(env.win, flight())).toThrow('Invalid metric frame');expect(env.win.claimThreeCamera).not.toHaveBeenCalled();expect(env.scene.children).toEqual([env.source]);
    });
    it('disposes route instances and geometries on replacement and materials only on final close', () => {
        const env = environment(), session = Session.create(env.win, flight()), root = env.scene.getObjectByName('CameraFlightPath');
        const instances = root.children.find(child => child.isInstancedMesh), instanceDispose = vi.spyOn(instances, 'dispose'), bufferDispose = vi.spyOn(instances.geometry, 'dispose'), materialDispose = vi.spyOn(instances.material, 'dispose');
        session.setRecord(copy(flight()));expect(instanceDispose).toHaveBeenCalledOnce();expect(bufferDispose).toHaveBeenCalledOnce();expect(materialDispose).not.toHaveBeenCalled();
        const replacement = root.children.find(child => child.isInstancedMesh), replacementDispose = vi.spyOn(replacement, 'dispose');
        session.dispose();session.dispose();expect(replacementDispose).toHaveBeenCalledOnce();expect(materialDispose).toHaveBeenCalledOnce();expect(env.lease.release).toHaveBeenCalledOnce();
    });
    it('intercepts free-camera pointer input before orbit, and returns to idle as held keys release', () => {
        const env = environment(), session = Session.create(env.win, flight()), orbit = vi.fn();env.canvas.addEventListener('pointerdown', orbit);
        const press = env.canvas.emit('pointerdown', { button: 0, pointerId: 1, clientX: 620, clientY: 460 });expect(press.preventDefault).toHaveBeenCalledOnce();expect(orbit).not.toHaveBeenCalled();
        env.canvas.emit('pointermove', { pointerId: 1, clientX: 610, clientY: 450 });expect(env.adapter.apply).toHaveBeenCalledOnce();
        env.canvas.emit('pointerup', { pointerId: 1 });expect(env.canvas.captured.size).toBe(0);
        env.win.emit('keydown', { code: 'KeyW', key: 'w' });expect(env.hooks.size).toBe(1);env.tick(0);env.tick(100);
        env.win.emit('keyup', { code: 'KeyW', key: 'w' });expect(env.hooks.size).toBe(0);expect(env.controls.update).not.toHaveBeenCalled();
        env.canvas.removeEventListener('pointerdown', orbit);session.dispose();
    });
    it('close during pending geometry prevents late poses and removes listeners, hooks and hidden source state', async () => {
        const env = environment(), record = flight(), gate = deferred();record.interiors = [interior()];record.view.settings.xray = '1';env.source.visible = false;
        env.win.applyThreeInteriorView.mockImplementation(async next => { await gate.promise;env.settings(next); });
        const session = Session.create(env.win, record), seeking = session.seek(3);await flush();session.dispose();session.dispose();gate.resolve();await seeking;
        expect(env.adapter.apply).not.toHaveBeenCalled();expect(env.source.visible).toBe(false);expect(env.scene.children).toEqual([env.source]);expect(env.lease.release).toHaveBeenCalledOnce();
        expect(env.win.listenerCount() + env.canvas.listenerCount() + env.doc.listenerCount() + env.controls.listenerCount()).toBe(0);expect(env.hooks.size).toBe(0);
        session.inspect(true);session.nudge([1, 0, 0], 1);session.rotate([0, 0, 1], 1);session.level();await session.play();expect(env.adapter.apply).not.toHaveBeenCalled();expect(env.hooks.size).toBe(0);
    });
    it('rejects non-finite seeks and releases ownership even if a walking extension throws on close', async () => {
        const env = environment(), onError = vi.fn(), session = Session.create(env.win, flight(), { onError });await expect(session.seek(NaN)).rejects.toThrow('finite');
        session.setWalking(() => { throw new Error('Walking cleanup failed'); });await expect(session.dispose()).rejects.toThrow('Walking cleanup failed');expect(onError).toHaveBeenCalledOnce();
        expect(env.lease.release).toHaveBeenCalledOnce();expect(env.scene.children).toEqual([env.source]);expect(env.win.listenerCount()).toBe(0);session.dispose();
    });
    it('keeps frozen playback snapshots separate from explicit live authoring refreshes', async () => {
        const env = environment(), record = flight(); record.interiors = [interior('saved')];
        const fresh = new THREE.Group(), hidden = new THREE.Group();
        fresh.userData.interiorFeature = interior('fresh').feature;
        hidden.userData.interiorFeature = interior('hidden').feature; hidden.visible = false;
        env.source.add(fresh, hidden);
        const session = Session.create(env.win, record);
        expect(env.source.visible).toBe(false);
        expect(session.snapshotFeatures()).toEqual(record.interiors);
        const live = session.snapshotFeatures({ live: true });
        expect(live.map(entry => entry.feature.properties.floorPlans.marker)).toEqual(['fresh']);
        live[0].feature.properties.floorPlans.marker = 'edited';
        expect(fresh.userData.interiorFeature.properties.floorPlans.marker).toBe('fresh');
        expect(session.snapshotFeatures()).toEqual(record.interiors);
        await session.dispose();
    });
    it('synchronizes external x-ray and cutaway changes without revealing duplicate live floors', async () => {
        const env = environment(), record = flight(); record.interiors = [interior()];
        const session = Session.create(env.win, record), root = env.scene.getObjectByName('CameraFlightInteriors');
        const state = { ...View.defaults, xray: '1', cutaway: '2' };
        env.settings(state); env.source.visible = true;
        env.win.emit('threeinteriorviewchange', { detail: state });
        expect(root.visible).toBe(true); expect(env.source.visible).toBe(false);
        expect(env.win.__threeFloorPlans.setCutaway).toHaveBeenLastCalledWith(root.children[0], 2);
        env.settings({ ...state, xray: '0' }); env.win.emit('threeinteriorviewchange');
        expect(root.visible).toBe(false); expect(env.source.visible).toBe(false);
        await session.dispose(); expect(env.win.listeners.get('threeinteriorviewchange')).toEqual([]);
    });
    it('serializes explicit authoring view changes and resynchronizes snapshots even for unchanged settings', async () => {
        const env = environment(), record = flight(); record.interiors = [interior()];
        const session = Session.create(env.win, record), state = { ...View.defaults, xray: '1', cutaway: '-1' };
        expect(await session.setView(state)).toBe(true);
        const root = env.scene.getObjectByName('CameraFlightInteriors');
        expect(root.visible).toBe(true); expect(env.source.visible).toBe(false);
        env.source.visible = true;
        expect(await session.setView(state)).toBe(true); expect(env.source.visible).toBe(false);
        expect(env.win.applyThreeInteriorView).toHaveBeenCalledTimes(1);
        await session.dispose(); expect(await session.setView(state)).toBe(false);
    });
    it('restores original display immediately on close and after late cue work before another session opens', async () => {
        const env = environment(), original = { ...View.defaults, suggested: '1', cutaway: '3' }, record = flight(), gate = deferred();
        env.settings(original); cueAt(record, .5, { xray: '1', cutaway: '-1' });
        let first = true;
        env.win.applyThreeInteriorView.mockImplementation(async next => {
            env.settings(next);
            if (first) { first = false; await gate.promise; env.settings(next); }
        });
        const session = Session.create(env.win, record), seeking = session.seek(1); await flush();
        const cleanup = session.dispose();
        expect(session.dispose()).toBe(cleanup); expect(env.lease.release).toHaveBeenCalledOnce();
        expect(env.win.getThreeInteriorView()).toEqual(original); expect(env.hooks.size).toBe(0);
        let finished = false; cleanup.then(() => { finished = true; }); await flush(); expect(finished).toBe(false);
        gate.resolve(); await seeking; await cleanup;
        expect(env.adapter.apply).not.toHaveBeenCalled(); expect(env.win.getThreeInteriorView()).toEqual(original);
        const replacement = Session.create(env.win, record); await replacement.dispose();
        expect(env.win.getThreeInteriorView()).toEqual(original); expect(env.win.claimThreeCamera).toHaveBeenCalledTimes(2);
    });
    it('does not restore settings into a replacement scene or after the model scene is torn down', async () => {
        for (const replacement of [{ scene: new THREE.Scene() }, null]) {
            const env = environment(), session = Session.create(env.win, flight());
            env.win.getThreeModeInternals = () => replacement;
            await session.dispose(); expect(env.win.applyThreeInteriorView).not.toHaveBeenCalled();
            expect(env.lease.release).toHaveBeenCalledOnce();
        }
    });
    it('reports restoration errors and returns a rejected cleanup promise after releasing ownership', async () => {
        const env = environment(), onError = vi.fn(), session = Session.create(env.win, flight(), { onError });
        env.win.applyThreeInteriorView.mockRejectedValue(new Error('Restore failed'));
        await expect(session.dispose()).rejects.toThrow('Restore failed');
        expect(onError).toHaveBeenCalledOnce(); expect(env.lease.release).toHaveBeenCalledOnce();
        expect(env.scene.children).toEqual([env.source]); expect(env.win.listenerCount()).toBe(0);
    });

    it('lets an external display toggle supersede a pending cue without stale pose or frozen input', async () => {
        const env = environment(), record = flight(), gate = deferred(); record.interiors = [interior()];
        cueAt(record, .5, { xray: '1' }, 'on');
        env.win.applyThreeInteriorView.mockImplementation(async next => {
            env.settings(next); env.win.emit('threeinteriorviewchange', { detail: next });
            if (next.xray === '1') await gate.promise;
        });
        const session = Session.create(env.win, record), seeking = session.seek(1); await flush();
        const external = { ...View.defaults, cutaway: '2' };
        env.settings(external); env.win.emit('threeinteriorviewchange', { detail: external });
        gate.resolve(); expect(await seeking).toBe(false); expect(session.time).toBe(0);
        expect(env.scene.getObjectByName('CameraFlightInteriors').visible).toBe(false);
        expect(env.source.visible).toBe(false); expect(env.adapter.apply).not.toHaveBeenCalled();
        env.win.emit('keydown', { code: 'KeyW', key: 'w' }); env.tick(0); env.tick(100);
        expect(env.adapter.apply).toHaveBeenCalled(); await session.dispose();
    });

});
