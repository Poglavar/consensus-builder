// Physical vehicle footprints and a small spatial index; independent of rendering scale.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficCollision = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const LENGTH = 4.4, WIDTH = 1.8, MARGIN = .12;
    const headings = new WeakMap();
    const dimension = (pose, key, fallback) => Number.isFinite(pose?.[key]) && pose[key] > 0
        ? pose[key] : fallback;
    const halfLength = (pose, margin = 0) => dimension(pose, 'length', LENGTH) / 2 + margin;
    const halfWidth = (pose, margin = 0) => dimension(pose, 'width', WIDTH) / 2 + margin;
    const radius = (pose, margin = 0) => Math.hypot(halfLength(pose, margin), halfWidth(pose, margin));
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
        const aHalfLength = halfLength(a, margin), aHalfWidth = halfWidth(a, margin);
        const bHalfLength = halfLength(b, margin), bHalfWidth = halfWidth(b, margin);
        const broadRadius = radius(a, margin) + radius(b, margin);
        if (dx * dx + dy * dy > broadRadius ** 2) return false;
        const aa = heading(a), bb = heading(b);
        const aligned = Math.abs(aa.cos * bb.cos + aa.sin * bb.sin);
        const crossed = Math.abs(aa.cos * bb.sin - aa.sin * bb.cos);
        const epsilon = 1e-7;
        return Math.abs(dx * aa.cos + dy * aa.sin)
                < aHalfLength + bHalfLength * aligned + bHalfWidth * crossed - epsilon
            && Math.abs(-dx * aa.sin + dy * aa.cos)
                < aHalfWidth + bHalfLength * crossed + bHalfWidth * aligned - epsilon
            && Math.abs(dx * bb.cos + dy * bb.sin)
                < bHalfLength + aHalfLength * aligned + aHalfWidth * crossed - epsilon
            && Math.abs(-dx * bb.sin + dy * bb.cos)
                < bHalfWidth + aHalfLength * crossed + aHalfWidth * aligned - epsilon;
    }
    function overlapsRectangle(vehiclePose, rectanglePose, length, width, margin = MARGIN) {
        const dx = rectanglePose.x - vehiclePose.x, dy = rectanglePose.y - vehiclePose.y;
        const aa = heading(vehiclePose), bb = heading(rectanglePose);
        const aligned = Math.abs(aa.cos * bb.cos + aa.sin * bb.sin);
        const crossed = Math.abs(aa.cos * bb.sin - aa.sin * bb.cos);
        const vehicleHalfLength = halfLength(vehiclePose, margin), vehicleHalfWidth = halfWidth(vehiclePose, margin);
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
        constructor() { this.cells = new Map(); this.positions = new Map(); this.maxRadius = radius({}); }
        key(p) { return `${Math.floor(p.x / 8)}:${Math.floor(p.y / 8)}`; }
        set(id, pose) {
            const old = this.positions.get(id);
            if (old) this.cells.get(this.key(old))?.delete(id);
            const key = this.key(pose);
            if (!this.cells.has(key)) this.cells.set(key, new Set());
            this.cells.get(key).add(id); this.positions.set(id, pose);
            this.maxRadius = Math.max(this.maxRadius, radius(pose, MARGIN));
        }
        nearby(pose) {
            const result = new Set(), x = Math.floor(pose.x / 8), y = Math.floor(pose.y / 8);
            const reach = Math.ceil((radius(pose, MARGIN) + this.maxRadius) / 8);
            for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
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
                    y: before.y + (pose.y - before.y) * f, angle: before.angle + angle * f,
                    length: dimension(pose, 'length', LENGTH), width: dimension(pose, 'width', WIDTH) };
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
