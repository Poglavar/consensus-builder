// Marks a control busy until the work its click started has landed: the control's leading icon
// turns into a spinner (css/primitives.css, .cb-busy), or a text-only control gets a ring before
// its label, and it carries aria-busy. Overlapping work on one control keeps it busy until the last
// piece settles. Actions that must not run twice (a transaction) check isBusy(control) first; the
// control's own disabled state is left to its owner.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BusyControl = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const pending = new WeakMap();

    function mark(control, delta) {
        const count = Math.max(0, (pending.get(control) || 0) + delta);
        if (count) pending.set(control, count); else pending.delete(control);
        control.classList.toggle('cb-busy', count > 0);
        if (count) control.setAttribute('aria-busy', 'true'); else control.removeAttribute('aria-busy');
    }

    // track(control, work) -> a promise of work's result. work is a promise, a value, or a function
    // returning either; a synchronous throw rejects the returned promise like an async one.
    function track(control, work) {
        if (control && control.classList) mark(control, 1);
        let result;
        try { result = Promise.resolve(typeof work === 'function' ? work() : work); }
        catch (error) { result = Promise.reject(error); }
        if (!control || !control.classList) return result;
        const done = () => mark(control, -1);
        // Chained, not a side branch: a failure still reaches the caller, or surfaces as an
        // unhandled rejection when nobody handles it.
        return result.then(value => { done(); return value; }, error => { done(); throw error; });
    }

    function isBusy(control) {
        return Boolean(control && pending.get(control));
    }

    return { track, isBusy };
});
