// Defines map-like 3D camera controls and keeps the scene's data-load anchor fixed while panning.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSnapshotNavigation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function cloneGeometry(geometry) {
        if (!geometry || typeof geometry !== 'object' || !geometry.type) return null;
        try { return JSON.parse(JSON.stringify(geometry)); } catch (_) { return null; }
    }

    function captureSceneLoadAnchor(focusGeometry) {
        return cloneGeometry(focusGeometry);
    }

    function resolveSceneLoadGeometry(options = {}) {
        return options.proposalGeometry
            || options.appliedWorkGeometry
            || options.entryAnchorGeometry
            || null;
    }

    // Use the frozen data anchor, not the movable camera target. Geographic circles retain their
    // metre radius after projection, including at latitudes where Mercator stretches the scene.
    function buildLoadRadiusPreview(geometry, radiusMeters, geo) {
        if (!geometry || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return null;
        const center = geo.center(geo.feature(geometry)).geometry.coordinates;
        if (!center.every(Number.isFinite)) return null;
        const circle = radius => geo.circle(center, radius, { units: 'meters', steps: 96 }).geometry.coordinates[0];
        return {
            center: { lng: center[0], lat: center[1] },
            radiusMeters,
            ring: circle(radiusMeters),
            innerRing: circle(Math.max(radiusMeters * 0.5, radiusMeters - Math.max(1.5, radiusMeters * 0.0075)))
        };
    }

    function configurePannableOrbitControls(controls, three) {
        if (!controls) return null;
        controls.enablePan = true;
        controls.enableRotate = true;
        controls.enableZoom = true;
        // Damping applies only a fraction of each pointer delta immediately, which makes a map pan
        // feel slow on press and continue drifting after release. 3D navigation should track the
        // pointer one-for-one and stop the instant the gesture ends.
        controls.enableDamping = false;
        controls.dampingFactor = 0;
        controls.screenSpacePanning = false;
        controls.panSpeed = 1.25;
        if (controls.mouseButtons && three?.MOUSE) {
            controls.mouseButtons.LEFT = three.MOUSE.PAN;
            controls.mouseButtons.MIDDLE = three.MOUSE.DOLLY;
            controls.mouseButtons.RIGHT = three.MOUSE.ROTATE;
            // Ctrl/Cmd held = left-drag rotates/tilts. Made explicit instead of relying on
            // OrbitControls' internal modifier flip: macOS turns ctrl+left-click into a
            // right-click at the browser level, and how that emulation meets the pointer-event
            // handling has shifted across three versions.
            const setRotateModifier = (on) => {
                controls.mouseButtons.LEFT = on ? three.MOUSE.ROTATE : three.MOUSE.PAN;
            };
            if (typeof window !== 'undefined') {
                window.addEventListener('keydown', (e) => {
                    if (e.ctrlKey || e.metaKey) setRotateModifier(true);
                });
                window.addEventListener('keyup', (e) => {
                    if (!e.ctrlKey && !e.metaKey) setRotateModifier(false);
                });
                window.addEventListener('blur', () => setRotateModifier(false));
            }
        }
        if (controls.touches && three?.TOUCH) {
            controls.touches.ONE = three.TOUCH.PAN;
            controls.touches.TWO = three.TOUCH.DOLLY_ROTATE;
        }
        return controls;
    }

    function resolveExitMapCenter(target, xyToLatLng) {
        if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
        if (typeof xyToLatLng !== 'function') return null;
        const center = xyToLatLng(target.x, target.y);
        if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return null;
        return { lat: center.lat, lng: center.lng };
    }

    return {
        captureSceneLoadAnchor,
        resolveSceneLoadGeometry,
        buildLoadRadiusPreview,
        configurePannableOrbitControls,
        resolveExitMapCenter
    };
});
