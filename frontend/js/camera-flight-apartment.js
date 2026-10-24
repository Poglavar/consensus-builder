// Apartment entry and walking share the host scene, camera lease and frame loop.
(function (root, factory) {
    const api = factory(root, typeof require === 'function' ? require : null);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightApartment = api;
})(typeof window !== 'undefined' ? window : null, function (root, nodeRequire) {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const vector = (value, size) => Array.isArray(value) && value.length === size && Array.from(value).every(finite);
    const clone = value => JSON.parse(JSON.stringify(value));
    const geometryApi = () => root?.__buildingFloorPlans || (nodeRequire && nodeRequire('./building-floor-plans.js'));
    function corners(value) {
        if (!Array.isArray(value) || value.length !== 4 || !Array.from(value).every(p => vector(p, 2)
            && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) throw new Error('Invalid apartment registration corners.');
        return value;
    }
    function scenePoint(THREE, session, lngLat, elevationM) {
        const xy = session.internals.latLngToXY(lngLat[1], lngLat[0]);
        if (!vector(xy, 2) || !finite(elevationM)) throw new Error('Apartment scene projection failed.');
        return new THREE.Vector3(xy[0], xy[1], elevationM);
    }
    function placement({ THREE, session, unit }) {
        const [width, depth] = unit?.architecture?.dimensionsM || [];
        if (!finite(width) || !finite(depth) || width <= 0 || depth <= 0 || !finite(unit?.elevationM)) throw new Error('Invalid apartment metric dimensions.');
        const c = corners(unit.registration?.corners).map(p => scenePoint(THREE, session, p, unit.elevationM));
        const x = c[2].clone().sub(c[3]), y = c[0].clone().sub(c[3]);
        if (c[3].clone().add(x).add(y).distanceTo(c[1]) > 0.2) throw new Error('Apartment registration is not affine within 0.2 scene units.');
        x.divideScalar(width); y.divideScalar(depth);
        const matrix = new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3(0, 0, 1)); matrix.setPosition(c[3]);
        if (!matrix.elements.every(finite) || Math.abs(matrix.determinant()) < 1e-9) throw new Error('Apartment placement is degenerate.');
        return matrix;
    }
    function entryPose({ THREE, session, unit, feature, fov }) {
        if (!vector(unit?.entryUv, 2) || unit.entryUv.some(n => n < 0 || n > 1) || !finite(unit.elevationM)
            || !finite(fov) || fov < 20 || fov > 100) throw new Error('Invalid apartment entry pose.');
        const plans = feature?.properties?.floorPlans;
        corners(plans?.registration?.corners); corners(unit.registration?.corners);
        const geometry = geometryApi();
        if (!geometry?.registrationToLngLat) throw new Error('Apartment floor geometry is unavailable.');
        const lngLat = geometry.registrationToLngLat(plans)(...unit.entryUv);
        const eye = scenePoint(THREE, session, lngLat, unit.elevationM + 1.65);
        const center = unit.registration.corners.reduce((p, c) => [p[0] + c[0] / 4, p[1] + c[1] / 4], [0, 0]);
        const targetScene = scenePoint(THREE, session, center, eye.z);
        const position = session.fromScene(eye.toArray()), target = session.fromScene(targetScene.toArray());
        if (!vector(position, 3) || !vector(target, 3)) throw new Error('Apartment metric projection failed.');
        if (Math.hypot(target[0] - position[0], target[1] - position[1]) < 1e-10) target[0] += 1;
        const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(
            new THREE.Vector3().fromArray(position), new THREE.Vector3().fromArray(target), new THREE.Vector3(0, 0, 1))).normalize().toArray();
        return { position, quaternion, fov };
    }
    function browser(win, session, { host, labels } = {}) {
        const THREE = win.THREE;
        let version = 0;
        const stale = token => { if (version !== token) { const error = new Error('Apartment operation superseded.'); error.name = 'AbortError'; throw error; } };
        function contains(choice, eye) {
            const { unit } = choice, matrix = placement({ THREE, session, unit });
            const local = eye.clone().applyMatrix4(matrix.clone().invert()), [width, depth] = unit.architecture.dimensionsM;
            if (!finite(unit.architecture.wallHeightM) || local.z <= 0 || local.z >= unit.architecture.wallHeightM) return false;
            const uv = [local.x / width, 1 - local.y / depth];
            const inside = unit.architecture.slabs.some(rings => win.turf.booleanPointInPolygon(win.turf.point(uv),
                win.turf.polygon(rings.map(ring => ring.concat([ring[0]]))), { ignoreBoundary: true }));
            if (!inside || !unit.boundary) return inside;
            const toLngLat = geometryApi().registrationToLngLat(choice.feature.properties.floorPlans);
            const boundary = win.turf.multiPolygon(unit.boundary.map(rings => rings.map(ring => {
                const projected = ring.map(p => { const scene = scenePoint(THREE, session, toLngLat(...p), unit.elevationM); return [scene.x, scene.y]; });
                return projected.concat([projected[0]]);
            })));
            return win.turf.booleanPointInPolygon(win.turf.point([eye.x, eye.y]), boundary, { ignoreBoundary: true });
        }
        function chooseAtCamera(choices) {
            if (!Array.isArray(choices) || !win.turf?.booleanPointInPolygon) throw new Error('Apartment selection requires choices and Turf.');
            for (const choice of choices) {
                if (contains(choice, session.internals.camera.position)) return choice;
            }
            return null;
        }
        async function prepare(choice, token, preservePose) {
            if (!choice?.unit || !choice?.feature) throw new Error('Apartment choice is required.');
            const captured = session.capture(), fov = captured.fov;
            const pose = preservePose ? null : entryPose({ THREE, session, ...choice, fov });
            if (preservePose && chooseAtCamera([choice]) !== choice) throw new Error('Current camera is outside the chosen apartment.');
            session.pause(); session.exitWalking();
            const previous = session.capture(), settings = clone(win.getThreeInteriorView());
            try {
                const ready = await session.setView({ ...settings, xray: '1' }); stale(token);
                if (ready === false) { const error = new Error('Apartment view is unavailable.'); error.name = 'AbortError'; throw error; }
                const result = pose ? { ...pose, fov: previous.fov } : captured;
                session.apply(result); return result;
            } catch (error) {
                if (token === version) {
                    try { await session.setView(settings); }
                    finally { session.apply(previous); }
                }
                throw error;
            }
        }
        async function enter(choice) { return prepare(choice, ++version, false); }
        async function explore(choice, { preservePose = false } = {}) {
            const token = ++version;
            const matrix = placement({ THREE, session, unit: choice?.unit });
            if (!host || !labels || !Array.isArray(labels.people) || labels.people.length < 2
                || !['firstPerson', 'back', 'overview', 'choosePerson', 'walkStick', 'noRoute'].every(key => typeof labels[key] === 'string' && labels[key])
                || typeof labels.personView !== 'function' || typeof labels.walkHint !== 'function') throw new Error('Apartment walking requires a host and localized labels.');
            await win.ensureInteriorViewer(); stale(token);
            const previous = session.capture(), previousSettings = clone(win.getThreeInteriorView());
            await prepare(choice, token, preservePose); stale(token);
            const { scene, camera, renderer, controls } = session.internals, hooks = new Set();
            let attachment = null, disposed = false;
            const cleanup = () => {
                if (disposed) return; disposed = true;
                try { attachment?.dispose(); }
                finally { hooks.forEach(hook => win.unregisterThreeModeFrameHook(hook)); hooks.clear(); }
            };
            try {
                attachment = win.InteriorViewer.attach({ THREE, scene, camera, renderer, controls,
                    architecture: choice.unit.architecture, placement: { matrix }, host, walking: true, labels,
                    env: win, quality: { coarse: Boolean(win.matchMedia?.('(pointer: coarse)')?.matches) },
                    render: () => win.invalidateThreeView(),
                    animate(animator) {
                        let last = null, active = true;
                        const hook = now => {
                            if (!active || !finite(now) || !animator.active()) { last = null; return; }
                            const dt = last === null ? 0 : Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
                            if (animator.update(dt)) win.invalidateThreeView();
                        };
                        win.registerThreeModeFrameHook(hook); hooks.add(hook);
                        return () => { if (active) { active = false; hooks.delete(hook); win.unregisterThreeModeFrameHook(hook); } };
                    } });
                stale(token);
                attachment.group.traverse(object => { if (object.name?.startsWith('UnitPart:')) object.visible = false; });
                if (!attachment.personView || !attachment.walkers?.length || !attachment.navigation?.canWalk) throw new Error('Apartment has no walkable entry.');
                attachment.root.updateWorldMatrix(true, true);
                let local = attachment.group.worldToLocal(camera.position.clone());
                if (!attachment.navigation.canWalk([local.x, local.y])) {
                    if (preservePose) throw new Error('Current apartment eye is not a walkable position.');
                    let found = null;
                    for (let radius = 1; radius <= 5 && !found; radius++) for (let angle = 0; angle < 16 && !found; angle++) {
                        const candidate = local.clone().add(new THREE.Vector3(Math.cos(angle * Math.PI / 8), Math.sin(angle * Math.PI / 8), 0).multiplyScalar(radius * 0.1));
                        const world = attachment.group.localToWorld(candidate.clone());
                        if (attachment.navigation.canWalk([candidate.x, candidate.y]) && contains(choice, world)) found = candidate;
                    }
                    if (!found) throw new Error('Apartment has no walkable position within 0.5 metres of its entry.');
                    local = found;
                    const world = attachment.group.localToWorld(local.clone());
                    session.apply({ ...session.capture(), position: session.fromScene(world.toArray()) });
                }
                attachment.entryPose = clone(session.capture());
                const forward = camera.getWorldDirection(new THREE.Vector3());
                const aim = attachment.group.worldToLocal(camera.position.clone().add(forward)).sub(local);
                const walker = attachment.walkers[0];
                walker.x = local.x; walker.y = local.y; walker.path = []; walker.moving = false; walker.controlled = true;
                if (Math.hypot(aim.x, aim.y) > 1e-10) walker.heading = Math.atan2(aim.y, aim.x);
                attachment.personView.enter(0);
                session.setWalking(cleanup);
                return attachment;
            } catch (error) {
                try { cleanup(); }
                finally {
                    if (token === version) {
                        try { await session.setView(previousSettings); }
                        finally { session.apply(previous); }
                    }
                }
                throw error;
            }
        }
        function exit() { version++; session.exitWalking(); }
        return Object.freeze({ enter, explore, chooseAtCamera, exit });
    }
    return Object.freeze({ entryPose, placement, browser });
});
