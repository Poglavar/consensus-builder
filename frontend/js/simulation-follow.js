// "Follow" for the in-browser simulation: after each turn the camera goes to the newest design an
// agent made, in 2D and in 3D. Moving the map by hand hands the camera back to the user (follow turns
// off, as in a navigation app); an open editor or dialog makes follow wait without moving anything.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SimulationFollow = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Pure: what follow does after a turn. 'move' the camera, 'wait' (the user is editing or a dialog
    // is up; the next turn asks again), or 'off'.
    function followAction({ enabled, editing, modalOpen }) {
        if (!enabled) return 'off';
        if (editing || modalOpen) return 'wait';
        return 'move';
    }

    // Controls on the map that are not the map: using them is not moving the camera by hand.
    const NOT_THE_MAP = '.agent-bubble, .leaflet-control, .leaflet-popup, button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]';
    const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', '=', 'PageUp', 'PageDown', 'Home', 'End']);

    // Pure: does this input event on the map take the camera over? A press (mouse, pen or finger),
    // a wheel turn, or a navigation key on the map itself; never one aimed at a control on it.
    function takesOverCamera(event) {
        if (!event) return false;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest(NOT_THE_MAP)) return false;
        if (event.type === 'pointerdown' || event.type === 'wheel') return true;
        if (event.type === 'keydown') return NAVIGATION_KEYS.has(event.key);
        return false;
    }

    function createController(win) {
        let enabled = true;
        let running = () => false;
        const listeners = new Set();
        const set = (on, reason) => {
            on = !!on;
            if (on === enabled) return;
            enabled = on;
            listeners.forEach(fn => { try { fn(enabled, reason); } catch (error) { console.error('[follow] listener failed', error); } });
        };
        const onInput = event => {
            if (enabled && running() && takesOverCamera(event)) set(false, 'user-moved');
        };
        let attached = false;
        return {
            isEnabled: () => enabled,
            setEnabled: on => set(on, 'toggle'),
            onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            // What follow does right now, from the page: the shell's edit lock and the modal router.
            action() {
                const editing = !!win?.MapShell?.isEditing?.();
                const modalOpen = !!win?.ModalEscape?.topmost?.();
                return followAction({ enabled, editing, modalOpen });
            },
            // Listens on the 2D map and the 3D view; `isRunning` limits the hand-over to a running game.
            attach({ isRunning } = {}) {
                if (typeof isRunning === 'function') running = isRunning;
                if (attached || !win?.document) return;
                attached = true;
                for (const id of ['map', 'three-container']) {
                    const el = win.document.getElementById(id);
                    if (!el) continue;
                    for (const type of ['pointerdown', 'wheel', 'keydown']) el.addEventListener(type, onInput, { capture: true, passive: true });
                }
            }
        };
    }

    const controller = typeof window !== 'undefined' ? createController(window) : null;
    return { followAction, takesOverCamera, createController, controller };
});
