// Drag handles for the open on-map building editor in the model view: an arrow above the building
// drives the editor's own height slider, the building itself drags to move it, and a knob on a ring
// round it turns it. The editor declares what it offers (OnMapEditor `modelHandles`) and keeps
// geometry, history and saving; this file only turns pointer rays into those calls.
(function (global) {
    'use strict';

    const HANDLE_PX = 28;          // on-screen height of the arrow and diameter of the knob
    const RING_Z = 0.5;            // the turn ring lies just above the ground, in metres
    const RING_MARGIN_M = 4;       // ring radius beyond the footprint's farthest corner
    const NUDGE = 0.05;            // step into a solid from its face, so a wall grab lands inside the outline
    // The height arrow follows the pointer along its axis on screen, but never faster than when the
    // axis is seen at this fraction of its side-on length: looking down it, a pixel stays a few cm.
    const MIN_FORESHORTENING = 0.35;
    const doc = global.document;

    let view = null;               // getThreeModeInternals() while the model view runs
    let controls = null;           // the camera controls whose 'change' rescales the handles
    let group = null;              // every handle object, in view.scene
    let arrow = null, guide = null, ring = null, knob = null, label = null;
    let spec = null;               // the editor's handles as last read
    let drag = null;               // the gesture in progress
    let knobDeg = -90;             // where the knob rests on its ring, counter-clockwise from east
    let hoverFrame = null, hoverEvent = null, cursorSet = false, swallowClick = false;

    const math = () => global.ModelEditHandlesMath;
    const THREE = () => global.THREE;

    function text(key, fallback, params) {
        const value = global.i18n?.t?.(key, params);
        if (value && value !== key) return value;
        return fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (params && name in params ? params[name] : match));
    }

    function palette() {
        const style = global.getComputedStyle(doc.documentElement);
        return {
            handle: style.getPropertyValue('--cb-primary').trim() || '#2563eb',
            outline: style.getPropertyValue('--cb-surface').trim() || '#ffffff'
        };
    }

    function overlayMaterial(three, color, opacity = 0.95) {
        return new three.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
    }

    // Unit-sized handles; scaleHandles() sizes them to HANDLE_PX on screen every frame the camera moves.
    function buildGroup(three) {
        const colors = palette();
        const built = new three.Group();
        built.name = 'model-edit-handles';
        built.renderOrder = 10000;
        arrow = new three.Group();
        const fill = overlayMaterial(three, colors.handle);
        const head = new three.ConeGeometry(0.4, 0.45, 20);
        head.rotateX(Math.PI / 2);
        const up = new three.Mesh(head, fill);
        up.position.z = 0.55;
        const down = new three.Mesh(head.clone().rotateX(Math.PI), fill);
        down.position.z = -0.55;
        const stem = new three.Mesh(new three.CylinderGeometry(0.08, 0.08, 0.7, 12).rotateX(Math.PI / 2), fill);
        const hub = new three.Mesh(new three.SphereGeometry(0.24, 16, 12), overlayMaterial(three, colors.outline, 1));
        arrow.add(up, down, stem, hub);
        arrow.userData.handle = 'height';
        guide = new three.Line(new three.BufferGeometry().setFromPoints([new three.Vector3(), new three.Vector3()]),
            new three.LineBasicMaterial({ color: colors.handle, transparent: true, opacity: 0.6, depthTest: false }));
        ring = new three.LineLoop(new three.BufferGeometry(),
            new three.LineBasicMaterial({ color: colors.handle, transparent: true, opacity: 0.8, depthTest: false }));
        knob = new three.Mesh(new three.SphereGeometry(0.5, 20, 14), fill);
        knob.userData.handle = 'rotate';
        built.add(guide, ring, arrow, knob);
        built.traverse(object => { object.renderOrder = 10000; object.frustumCulled = false; });
        return built;
    }

    function ensureLabel() {
        if (label) return label;
        label = doc.createElement('div');
        label.className = 'model-edit-handles__label';
        label.setAttribute('aria-hidden', 'true'); // the slider beside the map carries the same value accessibly
        label.hidden = true;
        doc.body.appendChild(label);
        return label;
    }

    function releaseView() {
        if (drag) finishDrag();
        group?.parent?.remove(group);
        controls?.removeEventListener('change', scaleHandles);
        controls = null;
        view = null;
        if (label) label.hidden = true;
        setCursor(null);
    }

    function attachView() {
        const next = global.isThreeModeActive?.() ? global.getThreeModeInternals?.() : null;
        if (!next || !THREE() || !math()) { releaseView(); return null; }
        view = next;
        if (!group) group = buildGroup(THREE());
        if (group.parent !== view.scene) view.scene.add(group);
        if (controls !== view.controls) {
            controls?.removeEventListener('change', scaleHandles);
            controls = view.controls || null;
            controls?.addEventListener('change', scaleHandles);
        }
        return view;
    }

    function heightOf(part) {
        return math().sliderHeight(Number(part.input.value), part);
    }

    function footprintRadius(footprint, centreXY, lat) {
        const unitsPerMetre = 1 / Math.cos(lat * Math.PI / 180);
        const geometry = footprint?.type === 'Feature' ? footprint.geometry : footprint;
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
        let farthest = 0;
        polygons.forEach(polygon => (polygon[0] || []).forEach(([lng, lat2]) => {
            const [x, y] = view.latLngToXY(lat2, lng);
            farthest = Math.max(farthest, Math.hypot(x - centreXY[0], y - centreXY[1]));
        }));
        return farthest + RING_MARGIN_M * unitsPerMetre;
    }

    // Re-read the editor's handles and put each where its building now stands.
    function refresh() {
        if (!attachView()) return;
        spec = global.OnMapEditor?.modelHandles?.() || null;
        const height = spec?.height?.input && !spec.height.input.disabled && spec.height.at ? spec.height : null;
        const rotate = spec?.rotate?.centre ? spec.rotate : null;
        if (!spec) knobDeg = -90;
        if (!height && label) label.hidden = true;
        arrow.visible = guide.visible = !!height;
        if (height) {
            const [x, y] = view.latLngToXY(height.at.lat, height.at.lng);
            const top = heightOf(height);
            arrow.position.set(x, y, top);
            guide.geometry.setFromPoints([new (THREE().Vector3)(x, y, 0), new (THREE().Vector3)(x, y, top)]);
        }
        ring.visible = knob.visible = !!rotate;
        if (rotate) {
            const centre = view.latLngToXY(rotate.centre.lat, rotate.centre.lng);
            const radius = footprintRadius(rotate.footprint, centre, rotate.centre.lat);
            const points = Array.from({ length: 96 }, (_, i) => {
                const angle = i / 96 * Math.PI * 2;
                return new (THREE().Vector3)(centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle), RING_Z);
            });
            ring.geometry.setFromPoints(points);
            ring.userData = { centre, radius };
            placeKnob(drag?.kind === 'rotate' ? drag.startDeg + drag.total : knobDeg);
        }
        scaleHandles();
    }

    function placeKnob(degrees) {
        const { centre, radius } = ring.userData;
        const angle = degrees * Math.PI / 180;
        knob.position.set(centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle), RING_Z);
    }

    function pixelsToWorld(point) {
        const height = view.renderer.domElement.clientHeight || 1;
        const distance = view.camera.position.distanceTo(point);
        return 2 * distance * Math.tan(view.camera.fov * Math.PI / 360) / height;
    }

    function scaleHandles() {
        if (!view || !group) return;
        if (arrow.visible) arrow.scale.setScalar(pixelsToWorld(arrow.position) * HANDLE_PX / 1.55);
        if (knob.visible) knob.scale.setScalar(pixelsToWorld(knob.position) * HANDLE_PX);
        placeLabel();
        global.invalidateThreeView?.();
    }

    function labelText(part) {
        const metres = heightOf(part);
        const height = global.CbFormat?.formatLength ? global.CbFormat.formatLength(metres) : `${Math.round(metres)} m`;
        return part.metresPerStep >= 2
            ? text('onMapEditor.modelHandles.storeys', 'Storeys: {{storeys}} · {{height}}', { storeys: Number(part.input.value), height })
            : height;
    }

    function toScreen(position) {
        const projected = position.clone().project(view.camera);
        const rect = view.renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (projected.x + 1) * rect.width / 2, y: rect.top + (1 - projected.y) * rect.height / 2 };
    }

    function placeLabel() {
        if (!label || label.hidden || !arrow.visible) return;
        const at = toScreen(arrow.position);
        label.style.setProperty('--model-handle-x', `${at.x}px`);
        label.style.setProperty('--model-handle-y', `${at.y}px`);
    }

    function showLabel(part) {
        ensureLabel();
        label.textContent = part ? labelText(part) : '';
        label.hidden = !part;
        if (part) placeLabel();
    }

    function rayOf(event) {
        const three = THREE();
        const rect = view.renderer.domElement.getBoundingClientRect();
        const raycaster = new three.Raycaster();
        raycaster.setFromCamera(new three.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        ), view.camera);
        return raycaster;
    }

    // What the pointer is over: a handle, the building the editor lets you move, or nothing.
    function target(event) {
        if (!view || !spec || event.target !== view.renderer.domElement) return null;
        const raycaster = rayOf(event);
        const handles = [arrow, knob].filter(object => object.visible);
        const handleHit = raycaster.intersectObjects(handles, true)[0];
        if (handleHit) {
            let object = handleHit.object;
            while (object && !object.userData.handle) object = object.parent;
            return { kind: object.userData.handle, raycaster };
        }
        if (!spec.move) return null;
        const hit = view.pickEditorPreview?.(event);
        if (!hit) return null;
        const { direction } = raycaster.ray;
        const inside = view.xyToLatLng(hit.x + direction.x * NUDGE, hit.y + direction.y * NUDGE);
        return inside && spec.move.hits(inside) ? { kind: 'move', raycaster, hit, at: inside } : null;
    }

    function setCursor(value) {
        const canvas = view?.renderer?.domElement;
        if (!canvas) { cursorSet = false; return; }
        if (value) { canvas.style.cursor = value; cursorSet = true; }
        else if (cursorSet) { canvas.style.cursor = ''; cursorSet = false; }
    }

    const CURSORS = { height: 'ns-resize', rotate: 'grab', move: 'move' };

    function onPointerDown(event) {
        swallowClick = false;
        if (drag || event.button !== 0 || !event.isPrimary) return;
        const found = target(event);
        if (!found) return;
        const ray = found.raycaster.ray;
        if (found.kind === 'height') {
            const part = spec.height;
            const axis = { x: arrow.position.x, y: arrow.position.y };
            const base = toScreen(arrow.position), up = toScreen(arrow.position.clone().setZ(arrow.position.z + 1));
            drag = { kind: 'height', part, axis, startMetres: heightOf(part), pointer: { x: event.clientX, y: event.clientY },
                axisPerMetre: { x: up.x - base.x, y: up.y - base.y },
                minPxPerMetre: MIN_FORESHORTENING / pixelsToWorld(arrow.position) };
            showLabel(part);
        } else if (found.kind === 'rotate') {
            const start = math().rayPointAtHeight(ray, RING_Z);
            if (!start || spec.rotate.begin() === false) return;
            const [cx, cy] = ring.userData.centre;
            drag = { kind: 'rotate', part: spec.rotate, centre: { x: cx, y: cy }, last: start, total: 0, applied: 0, startDeg: knobDeg };
        } else {
            if (spec.move.begin(found.at, event) === false) return;
            drag = { kind: 'move', part: spec.move, z: found.hit.z };
        }
        drag.pointerId = event.pointerId;
        drag.moved = false;
        drag.controlsEnabled = view.controls ? view.controls.enabled : null;
        if (view.controls) view.controls.enabled = false;
        try { view.renderer.domElement.setPointerCapture(event.pointerId); } catch (_) { /* a synthetic pointer cannot be captured */ }
        setCursor(found.kind === 'rotate' ? 'grabbing' : CURSORS[found.kind]);
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function onPointerMove(event) {
        if (!drag) { scheduleHover(event); return; }
        if (event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        drag.moved = true;
        const ray = rayOf(event).ray;
        if (drag.kind === 'height') {
            const rise = math().screenHeightDelta({ x: event.clientX - drag.pointer.x, y: event.clientY - drag.pointer.y },
                drag.axisPerMetre, drag.minPxPerMetre);
            if (rise === null) return;
            const input = drag.part.input;
            const value = math().sliderValueForHeight(drag.startMetres + rise, {
                min: Number(input.min), max: Number(input.max), step: parseFloat(input.step) || 1,
                metresPerStep: drag.part.metresPerStep, baseM: drag.part.baseM || 0
            });
            if (value === null || value === Number(input.value)) return;
            input.value = String(value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const top = heightOf(drag.part);
            arrow.position.z = top;
            guide.geometry.setFromPoints([new (THREE().Vector3)(drag.axis.x, drag.axis.y, 0), new (THREE().Vector3)(drag.axis.x, drag.axis.y, top)]);
            showLabel(drag.part);
            scaleHandles();
        } else if (drag.kind === 'rotate') {
            const point = math().rayPointAtHeight(ray, RING_Z);
            const turn = point && math().turnDegrees(drag.centre, drag.last, point);
            if (turn === null || turn === undefined) return;
            drag.total += turn;
            drag.last = point;
            placeKnob(drag.startDeg + drag.total);
            const snapped = math().snapDegrees(drag.total, event.shiftKey ? 1 : 5);
            if (snapped !== drag.applied) {
                drag.part.to(snapped);
                drag.applied = snapped;
            }
            scaleHandles();
        } else {
            const point = math().rayPointAtHeight(ray, drag.z);
            const at = point && view.xyToLatLng(point.x, point.y);
            if (at) drag.part.to(at, event);
        }
    }

    function finishDrag() {
        const ended = drag;
        drag = null;
        if (view?.controls && ended.controlsEnabled !== null) view.controls.enabled = ended.controlsEnabled;
        try { view?.renderer.domElement.releasePointerCapture(ended.pointerId); } catch (_) { /* already released */ }
        if (ended.kind === 'height') {
            ended.part.input.dispatchEvent(new Event('change', { bubbles: true }));
            showLabel(null);
        } else {
            if (ended.kind === 'rotate') knobDeg = ended.startDeg + ended.applied;
            ended.part.end();
        }
        swallowClick = ended.moved;
        setCursor(null);
        refresh();
    }

    function onPointerUp(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finishDrag();
    }

    // The click a drag ends with is not a click on the scene.
    function onClick(event) {
        if (!swallowClick) return;
        swallowClick = false;
        if (event.target !== view?.renderer?.domElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function scheduleHover(event) {
        if (!view || !spec || event.pointerType === 'touch') return;
        hoverEvent = event;
        if (hoverFrame !== null) return;
        hoverFrame = global.requestAnimationFrame(() => {
            hoverFrame = null;
            if (drag || !hoverEvent) return;
            const found = target(hoverEvent);
            setCursor(found ? CURSORS[found.kind] : null);
            showLabel(found?.kind === 'height' ? spec.height : null);
        });
    }

    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    doc.addEventListener('pointercancel', onPointerUp, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('on-map-editor-preview-change', refresh);
    global.addEventListener('mapmodechange', refresh);
    global.addEventListener('threeModeReady', refresh);
    refresh();
})(window);
