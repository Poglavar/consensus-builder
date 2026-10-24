// One host camera lease, deterministic playback and free camera input for a flight editing session.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightSession = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function create(win, initial, callbacks = {}) {
        const THREE = win.THREE, internals = win.getThreeModeInternals();
        if (!internals) throw new Error('The model view is not ready.');
        const adapter = win.CameraFlightCamera.createAdapter({ THREE, internals, frame: initial.frame, metricFrame: win.__metricFrame });
        const canvas = internals.renderer.domElement, doc = win.document;
        let record = initial, compiled = win.CameraFlight.compile(record), time = 0, playing = false, disposed = false;
        let lease = null, poseVersion = 0, playVersion = 0, settingsVersion = 0, settingsQueue = Promise.resolve(true), snapshotSignature = null;
        let previousNow = null, activeHook = false, inspection = false, pointer = null, speed = 15, pendingSettings = false;
        const originalSettings = win.ThreeViewState.normalize(win.getThreeInteriorView());
        let freePose = adapter.capture(), lastSettings = JSON.stringify(originalSettings), pausedForVisibility = false;
        let applyingSettings = null, cleanupPromise = null;
        const held = new Set();
        const pathRoot = new THREE.Group(); pathRoot.name = 'CameraFlightPath';
        const snapshotRoot = new THREE.Group(); snapshotRoot.name = 'CameraFlightInteriors';
        let hiddenFloorRoot = null, hiddenFloorVisibility = true, pointMesh = null, pointIds = [], cleanupWalk = null;
        const stroke = new THREE.LineBasicMaterial({ color: palette('--cb-flight-path', '#e28b36'), depthTest: false });
        const nodeMaterial = new THREE.MeshBasicMaterial({ color: palette('--cb-flight-node', '#297dc0'), depthTest: false });
        const nodeGeometry = new THREE.SphereGeometry(1, 10, 8);
        const notify = () => callbacks.onUpdate?.({ time, duration: compiled.duration, playing, inspection, walking: !!cleanupWalk });
        function palette(name, fallback) { return win.getComputedStyle(doc.documentElement).getPropertyValue(name).trim() || fallback; }
        function report(error) { if (callbacks.onError) callbacks.onError(error); else console.error('[camera-flight]', error); }
        function wake() { if (!activeHook && !disposed) { activeHook = true; previousNow = null; win.registerThreeModeFrameHook(frame); } win.invalidateThreeView(); }
        function sleep() { if (activeHook) { win.unregisterThreeModeFrameHook(frame); activeHook = false; previousNow = null; } }
        function drawRoute() {
            pathRoot.children.slice().forEach(child => { pathRoot.remove(child); if (child.isInstancedMesh) child.dispose(); child.geometry?.dispose(); });
            pointMesh = null; pointIds = record.route.map(point => point.id);
            if (!record.route.length) return;
            const samples = Math.min(512, Math.max(2, record.route.length * 24));
            const positions = [];
            for (let i = 0; i <= samples; i++) positions.push(adapter.toScene(compiled.evaluate(compiled.duration * i / samples).position));
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(positions), stroke); line.renderOrder = 1000;
            pathRoot.add(line);
            // Shared sphere buffers and instancing keep an edited route to two draw calls.
            pointMesh = new THREE.InstancedMesh(nodeGeometry.clone(), nodeMaterial, record.route.length);
            pointMesh.renderOrder = 1001; pointMesh.frustumCulled = false;
            const radius = Math.max(.15, Math.min(4, internals.camera.position.distanceTo(internals.controls.target) * .008));
            const matrix = new THREE.Matrix4();
            record.route.forEach((point, i) => {
                matrix.makeScale(radius, radius, radius); matrix.setPosition(adapter.toScene(point.position)); pointMesh.setMatrixAt(i, matrix);
            });
            pointMesh.instanceMatrix.needsUpdate = true; pathRoot.add(pointMesh); pathRoot.visible = !playing && !cleanupWalk;
            win.invalidateThreeView();
        }
        function snapshotFeatures({ live = false } = {}) {
            const source = internals.scene.getObjectByName('FloorPlans');
            if (!live) return JSON.parse(JSON.stringify(record.interiors));
            return (source?.children || []).filter(group => group.visible !== false && group.userData.interiorFeature).map((group, index) => ({
                id: 'interior-' + index,
                feature: JSON.parse(JSON.stringify(group.userData.interiorFeature))
            }));
        }
        function installSnapshots(entries = record.interiors) {
            const signature = JSON.stringify(entries);
            if (signature === snapshotSignature) return;
            const next = [];
            try {
                for (const entry of entries) {
                    const errors = win.__buildingFloorPlans.validateFloorPlans(entry.feature.properties.floorPlans);
                    if (errors.length) throw new Error(errors.join('; '));
                    const group = win.__threeFloorPlans.createBuildingGroup(THREE, entry.feature,
                        (lng, lat) => internals.latLngToXY(lat, lng), win.__buildingFloorPlans);
                    if (!group) throw new Error('The saved interior could not be displayed.');
                    group.userData.interiorFeature = entry.feature; next.push(group);
                }
            } catch (error) {
                next.forEach(group => win.__threeFloorPlans.disposeGroup(group)); throw error;
            }
            snapshotRoot.children.slice().forEach(group => { snapshotRoot.remove(group); win.__threeFloorPlans.disposeGroup(group); });
            next.forEach(group => snapshotRoot.add(group)); snapshotSignature = signature;
            syncSnapshotVisibility(win.getThreeInteriorView());
        }
        function syncSnapshotVisibility(settings) {
            const source = internals.scene.getObjectByName('FloorPlans');
            if (snapshotRoot.children.length) {
                if (hiddenFloorRoot !== source) {
                    if (hiddenFloorRoot) hiddenFloorRoot.visible = hiddenFloorVisibility;
                    hiddenFloorRoot = source; hiddenFloorVisibility = source?.visible ?? true;
                }
                if (source) source.visible = false;
                snapshotRoot.visible = settings.xray === '1'; lease.floorRoot = snapshotRoot;
                const cut = settings.cutaway === 'all' ? null : Number(settings.cutaway);
                snapshotRoot.children.forEach(group => win.__threeFloorPlans.setCutaway(group, cut));
            } else {
                if (hiddenFloorRoot) hiddenFloorRoot.visible = hiddenFloorVisibility;
                hiddenFloorRoot = null; lease.floorRoot = null; snapshotRoot.visible = false;
            }
        }
        function applySettings(settings) {
            const next = win.ThreeViewState.normalize(settings), signature = JSON.stringify(next);
            if (disposed) return Promise.resolve(false);
            if (!pendingSettings && signature === lastSettings) { syncSnapshotVisibility(next); return Promise.resolve(true); }
            const version = ++settingsVersion;
            pendingSettings = true; previousNow = null;
            // Serialize host geometry rebuilds. A newer requested state supersedes queued work;
            // an already running rebuild finishes before the latest state is installed.
            const task = settingsQueue.catch(() => {}).then(async () => {
                if (disposed || version !== settingsVersion) return false;
                if (signature !== lastSettings) {
                    applyingSettings = signature;
                    try { await win.applyThreeInteriorView(next); }
                    catch (error) { lastSettings = ''; throw error; }
                    finally { applyingSettings = null; }
                }
                // Even superseded host work changed the real scene, so remember its state.
                if (disposed) return false;
                const actual = win.ThreeViewState.normalize(win.getThreeInteriorView());
                lastSettings = JSON.stringify(actual);
                if (version !== settingsVersion) return false;
                syncSnapshotVisibility(actual); win.invalidateThreeView(); return true;
            });
            settingsQueue = task;
            return task.finally(() => {
                if (version === settingsVersion) { pendingSettings = false; previousNow = null; }
            });
        }
        function apply(pose) {
            if (disposed) return;
            adapter.apply(pose); freePose = adapter.capture(); win.invalidateThreeView();
        }
        async function seek(value) {
            if (!Number.isFinite(value)) throw new TypeError('Flight time must be finite.');
            if (disposed) return false;
            pause(); held.clear(); sleep();
            const version = ++poseVersion, target = Math.max(0, Math.min(compiled.duration, value));
            const pose = compiled.evaluate(target); inspection = false; internals.controls.enabled = false;
            const ready = await applySettings(pose.settings);
            if (disposed || version !== poseVersion || !ready) return false;
            time = target; apply(pose); notify(); return true;
        }
        function pause() { if (disposed) return; playVersion++; playing = false; previousNow = null; pathRoot.visible = !cleanupWalk; if (!held.size && !inspection) sleep(); notify(); }
        async function play() {
            if (disposed) return;
            exitWalking(); inspection = false; held.clear();
            const ready = seek(time >= compiled.duration ? 0 : time), version = playVersion;
            if (!await ready || disposed || version !== playVersion || compiled.duration <= 0) return;
            playing = true; pathRoot.visible = false; wake(); notify();
        }
        function move(dt) {
            const scalar = speed * dt * (held.has('ShiftLeft') || held.has('ShiftRight') ? 4 : 1);
            const q = new THREE.Quaternion().fromArray(freePose.quaternion);
            const direction = new THREE.Vector3((held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0),
                (held.has('KeyR') ? 1 : 0) - (held.has('KeyF') ? 1 : 0),
                (held.has('KeyS') ? 1 : 0) - (held.has('KeyW') ? 1 : 0));
            if (direction.lengthSq()) {
                direction.normalize().applyQuaternion(q).multiplyScalar(scalar);
                freePose.position = new THREE.Vector3().fromArray(freePose.position).add(direction).toArray();
            }
            const yaw = (held.has('ArrowLeft') ? 1 : 0) - (held.has('ArrowRight') ? 1 : 0);
            const pitch = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0);
            const roll = (held.has('KeyQ') ? 1 : 0) - (held.has('KeyE') ? 1 : 0);
            if (yaw) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw * dt));
            if (pitch) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch * dt));
            if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), roll * dt));
            freePose.quaternion = q.normalize().toArray(); apply(freePose);
        }
        function advance(target, pose) {
            time = target; apply(pose); notify();
            if (time >= compiled.duration) { pause(); callbacks.onEnd?.(); }
        }
        function frame(now) {
            if (disposed) return;
            if (pendingSettings) { previousNow = null; return; }
            const dt = previousNow === null ? 0 : Math.max(0, Math.min(.1, (now - previousNow) / 1000)); previousNow = now;
            if (playing) {
                const target = Math.min(compiled.duration, time + dt), pose = compiled.evaluate(target);
                if (JSON.stringify(win.ThreeViewState.normalize(pose.settings)) !== lastSettings) {
                    const version = ++poseVersion;
                    sleep();
                    applySettings(pose.settings).then(ready => {
                        if (!disposed && playing && version === poseVersion && ready) {
                            advance(target, pose); if (playing) wake();
                        }
                    }).catch(error => { pause(); report(error); });
                    return;
                }
                advance(target, pose);
            } else if (!cleanupWalk && !inspection && held.size) move(dt);
            const orbitMoving = inspection && internals.controls.enabled ? internals.controls.update() : false;
            if (!playing && !held.size && !orbitMoving) sleep();
        }
        function eventPoint(event) {
            const box = canvas.getBoundingClientRect();
            return new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
        }
        function down(event) {
            if (cleanupWalk || playing || event.button !== 0) return;
            const ray = new THREE.Raycaster(); ray.setFromCamera(eventPoint(event), internals.camera);
            const hit = pathRoot.visible && pointMesh ? ray.intersectObject(pointMesh)[0] : null;
            if (hit && hit.instanceId !== undefined) {
                const id = pointIds[hit.instanceId], point = record.route.find(p => p.id === id);
                pointer = { id: event.pointerId, node: id, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -adapter.toScene(point.position).z), value: null };
                callbacks.onSelect?.(id); internals.controls.enabled = false;
            } else if (inspection) return;
            else pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
            canvas.setPointerCapture(event.pointerId); event.preventDefault(); event.stopImmediatePropagation();
        }
        function pointerMove(event) {
            if (!pointer || pointer.id !== event.pointerId) return;
            if (pointer.node) {
                const ray = new THREE.Raycaster(); ray.setFromCamera(eventPoint(event), internals.camera);
                const hit = ray.ray.intersectPlane(pointer.plane, new THREE.Vector3());
                if (hit) { pointer.value = adapter.fromScene(hit); callbacks.onDrag?.(pointer.node, pointer.value); }
            } else {
                const q = new THREE.Quaternion().fromArray(freePose.quaternion);
                const dx = (event.clientX - pointer.x) * .005, dy = (event.clientY - pointer.y) * .005;
                if (event.altKey) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), -dx));
                else {
                    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx));
                    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy));
                }
                freePose.quaternion = q.normalize().toArray(); apply(freePose);
                pointer.x = event.clientX; pointer.y = event.clientY;
            }
            event.preventDefault(); event.stopImmediatePropagation();
        }
        function up(event) {
            if (!pointer || pointer.id !== event.pointerId) return;
            const current = pointer; pointer = null;
            if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
            if (inspection) internals.controls.enabled = true;
            if (current.node && current.value && event.type === 'pointerup') callbacks.onMove?.(current.node, current.value);
            event.stopImmediatePropagation();
        }
        const keys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
        function keyDown(event) {
            if (disposed || cleanupWalk) return;
            const tag = event.target?.tagName;
            if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(tag) || event.target?.isContentEditable) return;
            if (event.key === 'Escape') { callbacks.onClose?.(); event.preventDefault(); event.stopImmediatePropagation(); return; }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                callbacks.onUndo?.(event.shiftKey); event.preventDefault(); event.stopImmediatePropagation(); return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey || event.key === 'Tab' || /^F\d+$/.test(event.key)) return;
            if (keys.has(event.code) && !inspection && !playing) { held.add(event.code); wake(); event.preventDefault(); }
            if (!(['BUTTON', 'A'].includes(tag) && ['Enter', ' '].includes(event.key))) event.stopImmediatePropagation();
        }
        function keyUp(event) { held.delete(event.code); if (!held.size && !playing && !inspection) sleep(); }
        function blur() { held.clear(); if (!playing) sleep(); }
        function visibility() { if (doc.hidden) { pausedForVisibility = playing; pause(); held.clear(); } else if (pausedForVisibility) { pausedForVisibility = false; notify(); } }
        function inspect(on) {
            if (disposed) return;
            pause(); exitWalking(); inspection = on; internals.controls.enabled = on;
            if (on) {
                const box = new THREE.Box3(); record.route.forEach(p => box.expandByPoint(adapter.toScene(p.position)));
                const center = box.getCenter(new THREE.Vector3()), radius = Math.max(20, box.getSize(new THREE.Vector3()).length());
                internals.camera.up.set(0, 0, 1); internals.controls.target.copy(center);
                internals.camera.position.copy(center).add(new THREE.Vector3(radius, -radius, radius)); internals.controls.update();
                wake();
            } else { apply(freePose); if (!held.size) sleep(); }
            pathRoot.visible = true; notify(); win.invalidateThreeView();
        }
        const orbitStart = () => { if (inspection) wake(); };
        function exitWalking() {
            if (!cleanupWalk) return;
            const cleanup = cleanupWalk; cleanupWalk = null; cleanup();
            internals.controls.enabled = false; freePose = adapter.capture(); pathRoot.visible = !playing; notify();
        }
        function setWalking(cleanup) { if (disposed) { cleanup?.(); return; } pause(); exitWalking(); cleanupWalk = cleanup; pathRoot.visible = false; notify(); }
        function setRecord(next) {
            if (disposed) return;
            if (JSON.stringify(next.frame) !== JSON.stringify(initial.frame)) throw new Error('A session cannot change its metric frame.');
            const nextCompiled = win.CameraFlight.compile(next);
            installSnapshots(next.interiors);
            poseVersion++; pause(); record = next; compiled = nextCompiled; time = Math.min(time, compiled.duration);
            drawRoute(); notify();
        }
        function viewChanged(event) {
            if (disposed) return;
            const state = win.ThreeViewState.normalize(event.detail || win.getThreeInteriorView());
            const signature = JSON.stringify(state);
            // A host toggle supersedes an in-flight cue; notifications from our own setter do not.
            if (applyingSettings && applyingSettings !== signature) {
                settingsVersion++; poseVersion++; pendingSettings = false; pause();
            }
            lastSettings = signature;
            syncSnapshotVisibility(state); win.invalidateThreeView();
        }
        const disposeEvent = () => callbacks.onClose?.();
        function dispose() {
            if (disposed) return cleanupPromise;
            disposed = true; playing = false; held.clear(); poseVersion++; playVersion++; settingsVersion++; sleep();
            const errors = [];
            const sameScene = () => win.getThreeModeInternals()?.scene === internals.scene;
            let restoring;
            // The host setter changes fields and invalidates old rebuild generations synchronously.
            // Do this before releasing the lease, then await all outstanding host work before re-entry.
            try { if (lease && sameScene()) restoring = win.applyThreeInteriorView(originalSettings); }
            catch (error) { errors.push(error); }
            try {
                if (cleanupWalk) { const cleanup = cleanupWalk; cleanupWalk = null; cleanup(); }
            } catch (error) { errors.push(error); }
            try {
                if (pointer && canvas.hasPointerCapture?.(pointer.id)) canvas.releasePointerCapture(pointer.id); pointer = null;
                canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', pointerMove, true);
                canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', up, true);
                win.removeEventListener('keydown', keyDown, true); win.removeEventListener('keyup', keyUp, true); win.removeEventListener('blur', blur);
                doc.removeEventListener('visibilitychange', visibility); win.removeEventListener('threecameradispose', disposeEvent);
                win.removeEventListener('threeinteriorviewchange', viewChanged);
                internals.controls.removeEventListener('start', orbitStart);
                pathRoot.children.forEach(child => { if (child.isInstancedMesh) child.dispose(); child.geometry?.dispose(); });
                nodeGeometry.dispose(); nodeMaterial.dispose(); stroke.dispose();
                snapshotRoot.children.forEach(group => win.__threeFloorPlans.disposeGroup(group));
                internals.scene.remove(pathRoot, snapshotRoot);
            } catch (error) { errors.push(error); }
            finally {
                if (hiddenFloorRoot) hiddenFloorRoot.visible = hiddenFloorVisibility;
                if (lease) { lease.floorRoot = null; lease.release(); }
            }
            cleanupPromise = Promise.allSettled([settingsQueue, restoring]).then(async results => {
                results.forEach(result => { if (result.status === 'rejected') errors.push(result.reason); });
                // A host adapter may finish old work after the synchronous restoration. Reassert the
                // original state only in the same scene, before the caller opens its next session.
                if (lease && sameScene() && JSON.stringify(win.ThreeViewState.normalize(win.getThreeInteriorView())) !== JSON.stringify(originalSettings)) {
                    try { await win.applyThreeInteriorView(originalSettings); }
                    catch (error) { errors.push(error); }
                }
                if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Camera flight cleanup failed.');
            });
            cleanupPromise.catch(report);
            return cleanupPromise;
        }
        try {
            lease = win.claimThreeCamera('camera-flight');
            internals.scene.add(pathRoot, snapshotRoot);
            installSnapshots(); drawRoute();
            canvas.addEventListener('pointerdown', down, true); canvas.addEventListener('pointermove', pointerMove, true);
            canvas.addEventListener('pointerup', up, true); canvas.addEventListener('pointercancel', up, true);
            win.addEventListener('keydown', keyDown, true); win.addEventListener('keyup', keyUp, true); win.addEventListener('blur', blur);
            doc.addEventListener('visibilitychange', visibility); win.addEventListener('threecameradispose', disposeEvent);
            win.addEventListener('threeinteriorviewchange', viewChanged);
            internals.controls.addEventListener('start', orbitStart);
        } catch (error) { dispose(); throw error; }
        return {
            ...adapter, apply, seek, play, pause, inspect, setRecord, snapshotFeatures, setWalking, exitWalking, setView: applySettings,
            get time() { return time; }, get playing() { return playing; }, get inspection() { return inspection; },
            get internals() { return internals; },
            setSpeed(value) { if (Number.isFinite(value) && value > 0 && value <= 200) speed = value; },
            nudge(axis, amount) { if (disposed) return; pause(); inspection = false; internals.controls.enabled = false;
                const direction = new THREE.Vector3().fromArray(axis).applyQuaternion(new THREE.Quaternion().fromArray(freePose.quaternion));
                freePose.position = new THREE.Vector3().fromArray(freePose.position).addScaledVector(direction, amount).toArray(); apply(freePose); },
            rotate(axis, radians) { if (disposed) return; pause(); inspection = false; internals.controls.enabled = false;
                const q = new THREE.Quaternion().fromArray(freePose.quaternion), turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().fromArray(axis), radians);
                q.multiply(turn); freePose.quaternion = q.normalize().toArray(); apply(freePose); },
            level() {
                if (disposed) return;
                const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(freePose.quaternion));
                const yaw = Math.atan2(forward.y, forward.x), q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(
                    new THREE.Vector3(), new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0), new THREE.Vector3(0, 0, 1)));
                freePose.quaternion = q.toArray(); apply(freePose);
            },
            get ready() { return settingsQueue; },
            dispose
        };
    }
    return { create };
});
