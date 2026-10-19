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

    // The widest applied-work box a plain 3D entry loads in one request (its diagonal). Past it the
    // buildings of a whole city's worth of scattered proposals would come down at once.
    const MAX_APPLIED_WORK_SPAN_M = 1500;

    // [minLng, minLat, maxLng, maxLat] of a geometry's coordinates, or null.
    function geometryBox(geometry) {
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        const walk = node => {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number') {
                if (Number.isFinite(node[0]) && Number.isFinite(node[1])) {
                    minLng = Math.min(minLng, node[0]); maxLng = Math.max(maxLng, node[0]);
                    minLat = Math.min(minLat, node[1]); maxLat = Math.max(maxLat, node[1]);
                }
                return;
            }
            node.forEach(walk);
        };
        walk(geometry && geometry.coordinates);
        return Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
    }

    // Metres between two [lng, lat] points (equirectangular; ample for a city-scale box).
    function metresBetween(a, b) {
        const k = Math.PI / 180;
        const x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
        const y = (b[1] - a[1]) * k;
        return Math.hypot(x, y) * 6371008.8;
    }

    // Applied work frames the scene only where the user is looking at it: the entry point lies in
    // its box (or within the load radius of it) and the box is small enough to load. Otherwise the
    // scene loads where the 2D map was, as the camera and the trees do: a plan applied across town,
    // or proposals kilometres apart, used to send the buildings there and leave the view empty.
    function appliedWorkFramesEntry(appliedWorkGeometry, entryAnchorGeometry, radiusMeters, maxSpanMeters) {
        const box = geometryBox(appliedWorkGeometry);
        if (!box) return false;
        const [w, s, e, n] = box;
        if (metresBetween([w, s], [e, n]) > maxSpanMeters) return false;
        const anchor = entryAnchorGeometry && entryAnchorGeometry.type === 'Point' ? entryAnchorGeometry.coordinates : null;
        if (!anchor || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) return true;
        const nearest = [Math.min(Math.max(anchor[0], w), e), Math.min(Math.max(anchor[1], s), n)];
        return metresBetween(anchor, nearest) <= (Number.isFinite(radiusMeters) ? radiusMeters : 0);
    }

    function resolveSceneLoadGeometry(options = {}) {
        if (options.proposalGeometry) return options.proposalGeometry;
        const maxSpan = Number.isFinite(options.maxAppliedWorkSpanMeters) ? options.maxAppliedWorkSpanMeters : MAX_APPLIED_WORK_SPAN_M;
        if (options.appliedWorkGeometry
            && appliedWorkFramesEntry(options.appliedWorkGeometry, options.entryAnchorGeometry, options.radiusMeters, maxSpan)) {
            return options.appliedWorkGeometry;
        }
        return options.entryAnchorGeometry || null;
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
        MAX_APPLIED_WORK_SPAN_M,
        captureSceneLoadAnchor,
        resolveSceneLoadGeometry,
        buildLoadRadiusPreview,
        configurePannableOrbitControls,
        resolveExitMapCenter
    };
});
