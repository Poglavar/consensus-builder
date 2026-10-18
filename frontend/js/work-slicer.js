// Runs long main-thread work in short, clock-checked slices that yield at background priority, so
// timers, input and network replies get the thread first. DOM-free: the boot replay and its steps
// use it in the browser, and the unit tests drive it with a fake clock and a fake yield.
(function attachWorkSlicer(root, factory) {
    const api = factory(root || globalThis);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__workSlicer = api;
})(typeof window !== 'undefined' ? window : globalThis, function workSlicerFactory(root) {
    'use strict';

    // ~half a 60 Hz frame. A slice ends at the first unit that finishes past it, so a slice is the
    // budget plus at most one unit.
    const DEFAULT_BUDGET_MS = 8;

    function defaultNow() {
        return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
    }

    // A promise that settles in a NEW task that runs after everything more urgent. The await
    // continuation then runs inside that task, so the next slice is background work too.
    //   1. scheduler.postTask background priority (Chromium, Firefox): timers, input, network replies
    //      and rendering all run first. scheduler.yield() is deliberately NOT used: its continuation
    //      outranks ordinary tasks, which is what starved timers and fetch replies during the replay.
    //   2. MessageChannel: an ordinary task, queued behind those already waiting (Safari).
    //   3. setTimeout(0): last resort for a runtime with neither (it is clamped to 4 ms when nested).
    function backgroundYield(runtime = root) {
        const scheduler = runtime && runtime.scheduler;
        if (scheduler && typeof scheduler.postTask === 'function') {
            return () => scheduler.postTask(() => undefined, { priority: 'background' });
        }
        const Channel = runtime && runtime.MessageChannel;
        if (typeof Channel === 'function') {
            const channel = new Channel();
            const waiting = [];
            channel.port1.onmessage = () => { const resolve = waiting.shift(); if (resolve) resolve(); };
            // Node keeps a port with a listener alive; the browser has no such notion.
            if (typeof channel.port1.unref === 'function') channel.port1.unref();
            return () => new Promise(resolve => {
                waiting.push(resolve);
                channel.port2.postMessage(0);
            });
        }
        return () => new Promise(resolve => setTimeout(resolve, 0));
    }

    function cancelledError(reason) {
        const error = new Error(`Work was cancelled${reason ? `: ${reason}` : ''}.`);
        error.name = 'AbortError';
        error.code = 'work-cancelled';
        error.reason = reason || null;
        return error;
    }

    function isCancelled(error) {
        return !!error && error.code === 'work-cancelled';
    }

    // A slicer measures one slice at a time. `due()` is the clock check, made after every unit of
    // work; `pause()` ends the slice: it reports progress, yields, and throws if the work was
    // cancelled before or while it waited.
    function createSlicer(options = {}) {
        const budgetMs = typeof options.budgetMs === 'number' && options.budgetMs > 0 ? options.budgetMs : DEFAULT_BUDGET_MS;
        const now = typeof options.now === 'function' ? options.now : defaultNow;
        const yieldNow = typeof options.yieldNow === 'function' ? options.yieldNow : backgroundYield(options.runtime || root);
        const onPause = typeof options.onPause === 'function' ? options.onPause : null;
        let cancelReason = null;
        let cancelled = false;
        let sliceStarted = now();
        let pauses = 0;
        let longestSliceMs = 0;

        const signal = options.signal || null;
        const abortReason = () => {
            const reason = signal && signal.reason;
            return reason && typeof reason === 'object' ? (reason.message || String(reason)) : (reason || 'aborted');
        };

        function throwIfCancelled() {
            if (cancelled) throw cancelledError(cancelReason);
            if (signal && signal.aborted) throw cancelledError(abortReason());
        }

        function due() {
            return now() - sliceStarted >= budgetMs;
        }

        async function pause() {
            throwIfCancelled();
            const sliceMs = now() - sliceStarted;
            if (sliceMs > longestSliceMs) longestSliceMs = sliceMs;
            pauses += 1;
            if (onPause) onPause({ pauses, sliceMs });
            await yieldNow();
            sliceStarted = now();
            throwIfCancelled();
        }

        // For async loops: one call after each unit of work.
        async function checkpoint() {
            if (due()) await pause();
            else throwIfCancelled();
        }

        return Object.freeze({
            budgetMs,
            due,
            pause,
            checkpoint,
            throwIfCancelled,
            cancel(reason) { cancelled = true; cancelReason = reason || cancelReason || 'cancelled'; },
            get cancelled() { return cancelled || !!(signal && signal.aborted); },
            get pauses() { return pauses; },
            get longestSliceMs() { return longestSliceMs; }
        });
    }

    // One implementation, two drivers. A step function is a generator that yields after each small
    // unit of work: `runToCompletion` drives it synchronously (the one-shot callers), `runSliced`
    // checks the clock after every unit and pauses when the slice is used up.
    function runToCompletion(iterator) {
        let step = iterator.next();
        while (!step.done) step = iterator.next();
        return step.value;
    }

    async function runSliced(iterator, slicer) {
        if (!slicer) return runToCompletion(iterator);
        slicer.throwIfCancelled();
        let step = iterator.next();
        while (!step.done) {
            if (slicer.due()) {
                try { await slicer.pause(); } catch (error) {
                    // Let the step function's own `finally` blocks run before the cancellation propagates.
                    try { iterator.return(); } catch (_) { /* the cancellation is the failure */ }
                    throw error;
                }
            }
            step = iterator.next();
        }
        return step.value;
    }

    return Object.freeze({
        DEFAULT_BUDGET_MS,
        backgroundYield,
        cancelledError,
        isCancelled,
        createSlicer,
        runToCompletion,
        runSliced
    });
});
