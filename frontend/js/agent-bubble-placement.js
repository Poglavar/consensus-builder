// Where an agent bubble sits on screen: docked on an inset ring at the map's rim pointing towards its
// design, or over the design itself once the camera has gone there. Pure screen geometry, shared by
// the 2D map and both 3D views (agent-bubbles.js projects the design to a screen point first).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgentBubblePlacement = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // The floating shell sits on the map's rim (search box and top-right buttons, the mode strip on
    // the left, the bottom button row), so docked bubbles ride a ring inside it.
    const DEFAULT_INSET = Object.freeze({ top: 90, right: 35, bottom: 95, left: 90 });
    const BUBBLE_RADIUS = 25;

    const finite = value => typeof value === 'number' && Number.isFinite(value);

    // Where a projected point lies relative to the screen centre. A point behind the camera has no
    // screen position; its camera-space sideways and vertical offsets still tell which way to turn,
    // so `direction` is used as is (screen x right, y down) and the point counts as off screen.
    function screenTarget(projected, center) {
        if (!projected || !center || !finite(center.x) || !finite(center.y)) return null;
        if (projected.behind) {
            const d = projected.direction;
            if (!d || !finite(d.x) || !finite(d.y)) return null;
            return { dx: d.x, dy: d.y, onScreenPoint: null };
        }
        if (!finite(projected.x) || !finite(projected.y)) return null;
        return { dx: projected.x - center.x, dy: projected.y - center.y, onScreenPoint: { x: projected.x, y: projected.y } };
    }

    // The bubble's top-left corner and the angle its tip points at. `atObject` puts it over the
    // design while the design is inside the ring; outside it (the user has panned away, or the design
    // is behind the 3D camera) it docks on the ring like any other bubble.
    function placeBubble({ projected, width, height, atObject = false, inset = DEFAULT_INSET }) {
        if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
        const center = { x: width / 2, y: height / 2 };
        const target = screenTarget(projected, center);
        if (!target) return null;
        const p = target.onScreenPoint;
        if (atObject && p && p.x >= inset.left && p.x <= width - inset.right && p.y >= inset.top && p.y <= height - inset.bottom) {
            return { left: p.x - BUBBLE_RADIUS, top: p.y - BUBBLE_RADIUS, angle: null, docked: false };
        }
        const distance = Math.hypot(target.dx, target.dy);
        if (distance === 0) {
            // At the centre: top of the ring, pointing down.
            return { left: center.x - BUBBLE_RADIUS, top: inset.top - BUBBLE_RADIUS, angle: Math.PI / 2, docked: true };
        }
        const dirX = target.dx / distance;
        const dirY = target.dy / distance;
        let t = Infinity;
        if (dirX < 0) t = Math.min(t, (inset.left - center.x) / dirX);
        else if (dirX > 0) t = Math.min(t, (width - inset.right - center.x) / dirX);
        if (dirY < 0) t = Math.min(t, (inset.top - center.y) / dirY);
        else if (dirY > 0) t = Math.min(t, (height - inset.bottom - center.y) / dirY);
        const x = Math.max(inset.left, Math.min(width - inset.right, center.x + dirX * t));
        const y = Math.max(inset.top, Math.min(height - inset.bottom, center.y + dirY * t));
        return { left: x - BUBBLE_RADIUS, top: y - BUBBLE_RADIUS, angle: Math.atan2(dirY, dirX), docked: true };
    }

    // A camera-space point (x right, y up, looking down -z) and its normalised device coordinates as a
    // container point. Anything in front of the near plane is behind for screen purposes.
    function fromCameraSpace({ view, ndc, near, width, height }) {
        if (!view || !finite(view.x) || !finite(view.y) || !finite(view.z)) return null;
        if (view.z > -(finite(near) ? near : 0)) {
            return { behind: true, direction: { x: view.x, y: -view.y } };
        }
        if (!ndc || !finite(ndc.x) || !finite(ndc.y)) return null;
        return { behind: false, x: (ndc.x + 1) / 2 * width, y: (1 - ndc.y) / 2 * height };
    }

    return { DEFAULT_INSET, BUBBLE_RADIUS, placeBubble, fromCameraSpace };
});
