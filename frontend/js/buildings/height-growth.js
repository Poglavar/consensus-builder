// Buildings of the 3D model view growing to (or shrinking back from) the heights a height survey
// measured, as the answers arrive: a ripple outwards from the view's centre, each building easing
// from the height it shows to its new one. Pure timing and height choice, no three.js; three-mode.js
// applies the heights as each mesh's vertical scale.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HeightGrowth = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    // A building's height in the chosen mode: the survey's ('survey', where it measured one) or its
    // source's ('source').
    function targetHeight({ sourceM, measuredM, mode }) {
        return mode === 'survey' && finite(measuredM) && measuredM > 0 ? measuredM : sourceM;
    }
    const easeOut = t => 1 - Math.pow(1 - t, 3);

    // Running growths, one per building key: `grow(key, fromM, toM, distanceM, nowMs)` starts one
    // `distanceM / speedMps` seconds from now (the ripple), lasting `durationMs`; `step(nowMs)` gives a
    // Map key → height for every building still moving or just arrived, and drops the arrived ones.
    // A new growth of a moving building starts from where it is.
    function create({ durationMs = 900, speedMps = 500 } = {}) {
        const growing = new Map();
        function heightAt(entry, nowMs) {
            const t = Math.min(1, Math.max(0, (nowMs - entry.startMs) / durationMs));
            return { heightM: entry.fromM + (entry.toM - entry.fromM) * easeOut(t), done: t >= 1 };
        }
        function grow(key, fromM, toM, distanceM, nowMs) {
            if (!finite(fromM) || !finite(toM)) return;
            const moving = growing.get(key);
            const startFrom = moving ? heightAt(moving, nowMs).heightM : fromM;
            if (Math.abs(startFrom - toM) < 0.01) { growing.delete(key); return; }
            growing.set(key, { fromM: startFrom, toM, startMs: nowMs + (finite(distanceM) ? Math.max(0, distanceM) : 0) / speedMps * 1000 });
        }
        function step(nowMs) {
            const heights = new Map();
            for (const [key, entry] of growing) {
                const { heightM, done } = heightAt(entry, nowMs);
                heights.set(key, heightM);
                if (done) growing.delete(key);
            }
            return heights;
        }
        return { grow, step, get active() { return growing.size > 0; }, heightOf: (key, nowMs) => growing.has(key) ? heightAt(growing.get(key), nowMs).heightM : null };
    }
    return { targetHeight, create };
});
