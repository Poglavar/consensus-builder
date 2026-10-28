// Photo-view flights stream map tiles for wherever the camera looks, so before playing, the camera
// visits evenly spaced moments of the flight and waits at each until the tiles there have loaded.
// DOM-free: the caller supplies seek, the tile progress reader and the next-frame promise.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CameraFlightPreload = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const finite = x => typeof x === 'number' && Number.isFinite(x);

    // Moments to visit: the start, every `stepSeconds`, and the end; at most `max` of them.
    function sampleTimes(duration, { stepSeconds = 2, max = 60 } = {}) {
        if (!finite(duration) || duration < 0) throw new TypeError('Invalid flight duration.');
        const count = Math.min(max - 1, Math.max(1, Math.ceil(duration / stepSeconds)));
        return Array.from({ length: count + 1 }, (_, i) => duration * i / count);
    }

    // Resolves once progress has read 1 for `stableFrames` frames in a row (progress dips again as a
    // newly visible tile queues its children), or after timeoutMs, reporting which.
    async function settle({ progress, nextFrame, now, stableFrames = 6, timeoutMs = 20000, signal }) {
        const started = now();
        let stable = 0;
        while (stable < stableFrames) {
            if (signal?.aborted) return 'aborted';
            if (now() - started >= timeoutMs) return 'timeout';
            await nextFrame();
            const value = progress();
            stable = finite(value) && value >= 1 ? stable + 1 : 0;
        }
        return 'loaded';
    }

    // Visits every moment, then returns to the first, so playback starts on loaded tiles. A slow
    // stream never holds the flight longer than budgetMs: the remaining moments load as it flies.
    async function preload({ times, seek, progress, nextFrame, now, onProgress, signal, budgetMs = 60000, ...options }) {
        const outcomes = [], started = now();
        for (let i = 0; i < times.length; i++) {
            if (signal?.aborted) return { aborted: true, outcomes };
            if (now() - started >= budgetMs) { outcomes.push(...times.slice(i).map(() => 'skipped')); onProgress?.(times.length, times.length); break; }
            await seek(times[i]);
            outcomes.push(await settle({ progress, nextFrame, now, signal, ...options }));
            onProgress?.(i + 1, times.length);
        }
        if (signal?.aborted) return { aborted: true, outcomes };
        await seek(times[0]);
        await settle({ progress, nextFrame, now, signal, ...options });
        return { aborted: false, outcomes, timeouts: outcomes.filter(o => o === 'timeout').length, skipped: outcomes.filter(o => o === 'skipped').length };
    }

    return Object.freeze({ sampleTimes, settle, preload });
});
