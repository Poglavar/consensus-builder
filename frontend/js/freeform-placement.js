// Carry a new building outline until a map click or touch tap places it. Panning and pinch zoom
// remain navigation; the outline and pointer listeners belong only to this placement session.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FreeformPlacement = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function start({ map, pane, buildFootprint, onPlace }, env = window) {
        const doc = env.document;
        const container = map.getContainer();
        const pointers = new Set();
        let origin = null, moved = false, closed = false, outline = null, line = null, lineScene = null;
        let feature = buildFootprint(map.getCenter());
        const cursor = container.style.cursor;
        container.style.cursor = 'crosshair';
        const internals = () => env.isThreeModeActive?.() ? env.getThreeModeInternals?.() : null;
        function removeLine() {
            if (!line) return;
            lineScene.remove(line);
            line.geometry.dispose();
            line.material.dispose();
            line = null;
            lineScene = null;
        }
        function paint() {
            if (closed) return;
            const three = internals();
            if (three) {
                outline?.remove(); outline = null;
                if (lineScene !== three.scene) removeLine();
                if (!line) {
                    line = new env.THREE.LineLoop(new env.THREE.BufferGeometry(),
                        new env.THREE.LineBasicMaterial({ color: '#0d6efd', depthTest: false }));
                    line.renderOrder = 1000;
                    line.frustumCulled = false;
                    lineScene = three.scene;
                    lineScene.add(line);
                }
                line.geometry.setFromPoints(feature.geometry.coordinates[0].slice(0, -1).map(([lng, lat]) => {
                    const [x, y] = three.latLngToXY(lat, lng);
                    return new env.THREE.Vector3(x, y, 0.1);
                }));
            } else {
                removeLine();
                if (!outline) outline = env.L.geoJSON(null, { pane, interactive: false,
                    style: { color: '#0d6efd', weight: 3, fill: false, dashArray: '6 4', className: 'single-building-placement-outline' } }).addTo(map);
                outline.clearLayers();
                outline.addData(feature);
            }
        }
        function point(event) {
            if (event.target?.closest?.('.leaflet-control, .leaflet-popup, .on-map-editor, button, input, select, textarea, a')) return null;
            const three = internals();
            if (three) return event.target === three.renderer.domElement ? three.pickGroundLatLng(event) : null;
            return container.contains(event.target) ? map.mouseEventToLatLng(event) : null;
        }
        function down(event) {
            if (!point(event) || (event.button !== undefined && event.button !== 0)) return;
            if (!pointers.size) { origin = { x: event.clientX, y: event.clientY }; moved = false; }
            pointers.add(event.pointerId);
            if (pointers.size > 1) moved = true;
        }
        function move(event) {
            if (origin && pointers.size && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 6) moved = true;
            const at = point(event);
            if (!at || event.pointerType === 'touch' || pointers.size) return;
            feature = buildFootprint(at);
            paint();
        }
        function up(event) { pointers.delete(event.pointerId); }
        function cancel(event) { pointers.delete(event.pointerId); moved = true; }
        function click(event) {
            const at = point(event);
            if (!at || moved || (event.button !== undefined && event.button !== 0)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            feature = buildFootprint(at);
            destroy();
            onPlace(feature);
        }
        function key(event) {
            if (event.key !== 'Enter' || event.target?.closest?.('input, select, textarea, button, [contenteditable="true"]')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            destroy();
            onPlace(feature);
        }
        const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel, click, keydown: key };
        function destroy() {
            if (closed) return;
            closed = true;
            for (const [name, handler] of Object.entries(events)) doc.removeEventListener(name, handler, true);
            env.removeEventListener('mapmodechange', paint);
            outline?.remove();
            removeLine();
            container.style.cursor = cursor;
        }
        for (const [name, handler] of Object.entries(events)) doc.addEventListener(name, handler, true);
        env.addEventListener('mapmodechange', paint);
        try { paint(); } catch (error) { destroy(); throw error; }
        return { destroy };
    }
    return { start };
});
