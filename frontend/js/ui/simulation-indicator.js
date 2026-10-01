// ui/simulation-indicator.js — the small pulsing dot on the Activity button while the in-UI
// simulation runs, so a running game is never invisible with the Activity sheet closed. game.js
// calls sync() whenever the game UI updates; the dot itself (#activity-running-dot) is in index.html.
// UMD with no DOM access at load, so backend/test/frontend-simulation-indicator.test.js loads it.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SimulationIndicator = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const DOT_ID = 'activity-running-dot';
    const BUTTON_ID = 'activity-button';

    // Pure: what the indicator shows for a game state. Only a running game shows the dot; a
    // stopped, paused or missing game shows nothing.
    function indicatorFor(gameState) {
        return { visible: !!(gameState && gameState.isRunning === true) };
    }

    // Apply indicatorFor() to the page: the dot's `hidden`, and a class on the Activity button.
    function sync(doc, gameState) {
        if (!doc || typeof doc.getElementById !== 'function') return indicatorFor(gameState);
        const state = indicatorFor(gameState);
        const dot = doc.getElementById(DOT_ID);
        if (dot) dot.hidden = !state.visible;
        const button = doc.getElementById(BUTTON_ID);
        if (button && button.classList) button.classList.toggle('is-simulating', state.visible);
        return state;
    }

    return { indicatorFor, sync, DOT_ID, BUTTON_ID };
});
