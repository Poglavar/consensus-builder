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
        configurePannableOrbitControls,
        resolveExitMapCenter
    };
});
