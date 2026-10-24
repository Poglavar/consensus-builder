// Full camera poses in the flight's local metric frame and the host's projected scene frame.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightCamera = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const vector = (value, size) => Array.isArray(value) && value.length === size && Array.from(value).every(finite);
    function createAdapter({ THREE, internals, frame, metricFrame }) {
        const camera = internals?.camera;
        if (!THREE?.Matrix3 || !camera?.isPerspectiveCamera || typeof internals.latLngToXY !== 'function'
            || typeof internals.xyToLatLng !== 'function' || typeof metricFrame?.frameAt !== 'function') {
            throw new TypeError('CameraFlightCamera requires THREE, a perspective camera and coordinate helpers');
        }
        if (!frame || !finite(frame.lat) || !finite(frame.lng) || frame.datum !== 'model-ground') {
            throw new TypeError('CameraFlightCamera requires a model-ground frame');
        }
        // The shared helper validates canonical six-decimal anchors and the local projection domain.
        const metric = metricFrame.frameAt([frame.lng, frame.lat]);
        let appliedPosition = null;
        function toScene(position) {
            if (!vector(position, 3)) throw new TypeError('CameraFlightCamera position must contain three finite metres');
            const [lng, lat] = metric.toLngLat(position.slice(0, 2));
            const xy = internals.latLngToXY(lat, lng);
            if (!vector(xy, 2)) throw new TypeError('CameraFlightCamera scene projection failed');
            // Scene XY are EPSG:3857 offsets; model elevation is already in true metres.
            return new THREE.Vector3(xy[0], xy[1], position[2]);
        }
        function fromScene(position) {
            const xyz = position?.isVector3 ? position.toArray() : position;
            if (!vector(xyz, 3)) throw new TypeError('CameraFlightCamera scene position must be finite');
            // Preserve an authored pose exactly while the host eye is unchanged. A redundant
            // projection round trip can put a boundary point nanometres outside the strict domain.
            if (appliedPosition && xyz.every((n, i) => n === appliedPosition.scene[i])) return appliedPosition.metric.slice();
            const ll = internals.xyToLatLng(xyz[0], xyz[1]);
            if (!ll || !finite(ll.lng) || !finite(ll.lat)) throw new TypeError('CameraFlightCamera inverse scene projection failed');
            const xy = metric.toMetric([ll.lng, ll.lat]);
            if (!vector(xy, 2)) throw new TypeError('CameraFlightCamera inverse metric projection failed');
            return [xy[0], xy[1], xyz[2]];
        }
        function jacobian(position) {
            // Central differences span one metric metre on each horizontal axis. This includes
            // local meridian convergence, map scale and any host scene-axis rotation.
            // At the circular domain edge, move the stencil one metre inward: even the tangent
            // axis otherwise has no nonzero coordinate step that remains inside the frame.
            const center = position.slice(), radius = metricFrame.CONTRACT.MAX_RADIUS_FROM_ANCHOR_M;
            const horizontal = Math.hypot(center[0], center[1]);
            if (horizontal > radius - 1) {
                center[0] *= (radius - 1) / horizontal; center[1] *= (radius - 1) / horizontal;
            }
            const columns = [0, 1].map(axis => {
                const a = center.slice(), b = center.slice();
                a[axis] -= .5; b[axis] += .5;
                return toScene(b).sub(toScene(a));
            });
            const [x, y] = columns;
            const matrix = new THREE.Matrix3().set(x.x, y.x, 0, x.y, y.y, 0, 0, 0, 1);
            if (!matrix.elements.every(finite) || Math.abs(matrix.determinant()) < 1e-12) {
                throw new TypeError('CameraFlightCamera projection has no invertible local frame');
            }
            return matrix;
        }
        function quaternion(value) {
            if (!vector(value, 4) || Math.abs(Math.hypot(...value) - 1) > 1e-5) {
                throw new TypeError('CameraFlightCamera quaternion must be finite and normalized');
            }
            return new THREE.Quaternion().fromArray(value).normalize();
        }
        function transformOrientation(rotation, matrix) {
            // Forward-first Gram-Schmidt preserves the aim, then the roll. Applying the inverse
            // Jacobian and the same orthogonalization recovers the original complete orientation.
            // No world-up cross product or Euler angles: looking straight up/down is well-defined.
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation).applyMatrix3(matrix).normalize();
            const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).applyMatrix3(matrix);
            up.addScaledVector(forward, -up.dot(forward));
            if (up.lengthSq() < 1e-20 || forward.lengthSq() < 1e-20) throw new TypeError('CameraFlightCamera orientation is degenerate');
            up.normalize();
            const right = new THREE.Vector3().crossVectors(forward, up).normalize();
            const back = forward.clone().negate();
            up.crossVectors(back, right).normalize();
            const basis = new THREE.Matrix4().makeBasis(right, up, back);
            return { quaternion: new THREE.Quaternion().setFromRotationMatrix(basis).normalize(), forward, up };
        }
        function capture() {
            const position = fromScene(camera.position);
            const rotation = quaternion(camera.quaternion.toArray());
            if (!finite(camera.fov) || camera.fov <= 0 || camera.fov >= 180) throw new TypeError('CameraFlightCamera field of view must be between 0 and 180 degrees');
            const orientation = transformOrientation(rotation, jacobian(position).invert());
            return { position, quaternion: orientation.quaternion.toArray(), fov: camera.fov };
        }
        function apply(pose) {
            if (!pose || !finite(pose.fov) || pose.fov <= 0 || pose.fov >= 180) throw new TypeError('CameraFlightCamera field of view must be between 0 and 180 degrees');
            const rotation = quaternion(pose.quaternion);
            const position = toScene(pose.position);
            const orientation = transformOrientation(rotation, jacobian(pose.position));
            // Compute and validate the whole pose before mutating the supplied camera.
            camera.position.copy(position);
            camera.quaternion.copy(orientation.quaternion);
            camera.up.copy(orientation.up);
            camera.fov = pose.fov;
            camera.near = .035;
            camera.far = Math.min(200000, Math.max(5000, Math.hypot(...pose.position) * 2));
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
            appliedPosition = { scene: position.toArray(), metric: pose.position.slice() };
            // Keep the host's sunlight/focus target useful without letting OrbitControls write
            // the pose. Camera ownership and restoration are entirely the host's responsibility.
            internals.controls?.target?.copy(position.clone().addScaledVector(orientation.forward, 10));
        }
        return { capture, apply, toScene, fromScene };
    }
    return { createAdapter };
});
