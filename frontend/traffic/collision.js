// Physical vehicle footprints and a small spatial index; independent of rendering scale.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.TrafficCollision = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const LENGTH = 4.4, WIDTH = 1.8, MARGIN = .12;
    function overlaps(a, b, margin = MARGIN) {
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx * dx + dy * dy > 30) return false;
        const axes = [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2];
        for (const angle of axes) {
            const radius = p => Math.abs(Math.cos(p.angle - angle)) * (LENGTH / 2 + margin)
                + Math.abs(Math.sin(p.angle - angle)) * (WIDTH / 2 + margin);
            if (Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) >= radius(a) + radius(b) - 1e-7) return false;
        }
        return true;
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
    return { LENGTH, WIDTH, overlaps, Index };
});
