// Owns asynchronous map-mode intent; only the most recent request may attach a view.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__mapModeTransition = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    function createController(deps) {
        let epoch = 0;
        let current = null;
        let state = { desired: '2d', pending: false };
        const publish = (desired, pending) => {
            state = { desired, pending };
            deps.onChange(state);
        };
        function request(mode, options = {}) {
            if (!['2d', 'model', 'photo'].includes(mode)) throw new Error('Unknown map mode: ' + mode);
            if (current && state.desired === mode && !options.focusProposalIds && !options.restoreView) return current.promise;
            if (current) current.abort.abort();
            const abort = new AbortController();
            const id = ++epoch;
            const live = () => id === epoch && !abort.signal.aborted;
            const ticket = { signal: abort.signal, isCurrent: live };
            const entry = { abort, promise: null };
            current = entry;
            // A completed 2D transition is published after the model view has restored Leaflet.
            // Editors may frame their geometry in that notification.
            if (mode === '2d') {
                deps.leavePhoto({ destination: mode });
                deps.leaveModel();
                publish(mode, false);
                entry.promise = Promise.resolve(true);
                return entry.promise;
            }
            publish(mode, true);
            if (mode !== 'photo') deps.leavePhoto({ destination: mode });
            entry.promise = (async () => {
                try {
                    if (!await deps.loadModel() || !live()) return false;
                    if (!await deps.enterModel(options) || !live()) return false;
                    if (mode === 'photo') {
                        if (!await deps.loadPhoto() || !live()) return false;
                        if (!await deps.enterPhoto(Object.assign({}, options, { modeRequest: ticket })) || !live()) return false;
                    }
                    publish(mode, false);
                    return true;
                } catch (error) {
                    if (live()) deps.onError(error);
                    return false;
                } finally {
                    if (live() && state.pending) {
                        deps.leavePhoto({ destination: '2d' });
                        deps.leaveModel();
                        publish('2d', false);
                        current = null;
                    }
                }
            })();
            return entry.promise;
        }
        return { request, getState: () => state };
    }
    return { createController };
});
