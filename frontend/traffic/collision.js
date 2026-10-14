// Physical vehicle footprints and a small spatial index; independent of rendering scale.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficCollision = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const LENGTH = 4.4, WIDTH = 1.8, MARGIN = .12;
    const headings = new WeakMap();
    function heading(pose) {
        let value = headings.get(pose);
        if (!value || value.angle !== pose.angle) {
            value = { angle: pose.angle, cos: Math.cos(pose.angle), sin: Math.sin(pose.angle) };
            headings.set(pose, value);
        }
        return value;
    }
    function overlaps(a, b, margin = MARGIN) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const halfLength = LENGTH / 2 + margin, halfWidth = WIDTH / 2 + margin;
        const radius2 = halfLength ** 2 + halfWidth ** 2;
        if (dx * dx + dy * dy > 4 * radius2) return false;
        const aa = heading(a), bb = heading(b);
        const aligned = Math.abs(aa.cos * bb.cos + aa.sin * bb.sin);
        const crossed = Math.abs(aa.cos * bb.sin - aa.sin * bb.cos);
        const lengthRadius = halfLength * (1 + aligned) + halfWidth * crossed - 1e-7;
        const widthRadius = halfWidth * (1 + aligned) + halfLength * crossed - 1e-7;
        return Math.abs(dx * aa.cos + dy * aa.sin) < lengthRadius
            && Math.abs(-dx * aa.sin + dy * aa.cos) < widthRadius
            && Math.abs(dx * bb.cos + dy * bb.sin) < lengthRadius
            && Math.abs(-dx * bb.sin + dy * bb.cos) < widthRadius;
    }
    function overlapsRectangle(vehiclePose, rectanglePose, length, width, margin = MARGIN) {
        const dx = rectanglePose.x - vehiclePose.x, dy = rectanglePose.y - vehiclePose.y;
        const aa = heading(vehiclePose), bb = heading(rectanglePose);
        const aligned = Math.abs(aa.cos * bb.cos + aa.sin * bb.sin);
        const crossed = Math.abs(aa.cos * bb.sin - aa.sin * bb.cos);
        const vehicleHalfLength = LENGTH / 2 + margin, vehicleHalfWidth = WIDTH / 2 + margin;
        const rectangleHalfLength = length / 2 + margin, rectangleHalfWidth = width / 2 + margin;
        const epsilon = 1e-7;
        return Math.abs(dx * aa.cos + dy * aa.sin)
                < vehicleHalfLength + rectangleHalfLength * aligned + rectangleHalfWidth * crossed - epsilon
            && Math.abs(-dx * aa.sin + dy * aa.cos)
                < vehicleHalfWidth + rectangleHalfLength * crossed + rectangleHalfWidth * aligned - epsilon
            && Math.abs(dx * bb.cos + dy * bb.sin)
                < rectangleHalfLength + vehicleHalfLength * aligned + vehicleHalfWidth * crossed - epsilon
            && Math.abs(-dx * bb.sin + dy * bb.cos)
                < rectangleHalfWidth + vehicleHalfLength * crossed + vehicleHalfWidth * aligned - epsilon;
    }
    class Index {
        constructor() { this.cells = new Map(); this.positions = new Map(); }
        key(p) { return `${Math.floor(p.x / 8)}:${Math.floor(p.y / 8)}`; }
        set(id, pose) {
            const old = this.positions.get(id);
            if (old) this.cells.get(this.key(old))?.delete(id);
            const key = this.key(pose);
            if (!this.cells.has(key)) this.cells.set(key, new Set());
            this.cells.get(key).add(id); this.positions.set(id, pose);
        }
        nearby(pose) {
            const result = new Set(), x = Math.floor(pose.x / 8), y = Math.floor(pose.y / 8);
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                for (const id of this.cells.get(`${x + dx}:${y + dy}`) || []) result.add(id);
            }
            return result;
        }
        blocker(id, pose, before = pose) {
            const distance = Math.hypot(pose.x - before.x, pose.y - before.y);
            const angle = Math.atan2(Math.sin(pose.angle - before.angle), Math.cos(pose.angle - before.angle));
            const steps = Math.max(1, Math.ceil(distance / .5), Math.ceil(Math.abs(angle) / .15));
            for (let i = 1; i <= steps; i++) {
                const f = i / steps, p = { x: before.x + (pose.x - before.x) * f,
                    y: before.y + (pose.y - before.y) * f, angle: before.angle + angle * f };
                for (const other of this.nearby(p)) {
                    if (other !== id && overlaps(p, this.positions.get(other))) return other;
                }
            }
            return null;
        }
        blocked(id, pose, before = pose) { return this.blocker(id, pose, before) != null; }
    }
    return { LENGTH, WIDTH, overlaps, overlapsRectangle, Index };
});
