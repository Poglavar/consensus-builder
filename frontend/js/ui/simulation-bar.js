// ui/simulation-bar.js — the small floating simulation bar on the map (#simulation-bar in index.html):
// every simulation control — play/pause, next turn, turn speed, the Agent city, New game and Stop.
// Run simulation in Settings folds Settings away and opens the bar; Pause keeps it; Stop pauses and
// closes it. game.js owns the game and calls sync().
// UMD with a pure barView(), so backend/test/frontend-simulation-bar.test.js loads it without a DOM.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SimulationBar = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const SPEED_PRESETS = Object.freeze([3, 5, 10, 20, 30, 60]);

    // Pure: the interval choices the bar offers, the current one always among them.
    function speedOptions(current) {
        const set = new Set(SPEED_PRESETS);
        if (Number.isInteger(current) && current > 0) set.add(current);
        return Array.from(set).sort((a, b) => a - b);
    }

    // Pure: what the bar shows for a game state.
    function barView({ open, gameState }) {
        const running = !!(gameState && gameState.isRunning === true);
        const interval = Number.parseInt(gameState && gameState.turnIntervalSeconds, 10);
        return {
            hidden: !(open || running),
            running,
            playLabelKey: running ? 'sidebar.game.pause' : 'sidebar.game.play',
            playLabel: running ? 'Pause' : 'Play',
            playIcon: running ? 'fa-pause' : 'fa-play',
            turn: Number.isInteger(gameState && gameState.currentTurn) ? gameState.currentTurn : 0,
            interval: Number.isInteger(interval) && interval > 0 ? interval : null,
            speeds: speedOptions(interval)
        };
    }

    let open = false;
    let lastView = null;
    const t = (win, key, fallback, params) => {
        const value = win?.i18n?.t?.(key, params);
        if (value && value !== key) return value;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (params && k in params ? params[k] : m));
    };

    function sync(doc, gameState, { dateText = '' } = {}) {
        const view = barView({ open, gameState });
        lastView = view;
        const bar = doc?.getElementById?.('simulation-bar');
        if (!bar) return view;
        const win = doc.defaultView;
        bar.hidden = view.hidden;
        const play = doc.getElementById('simulation-bar-play');
        if (play) {
            const label = view.running ? t(win, 'sidebar.game.pause', 'Pause') : t(win, 'sidebar.game.play', 'Play');
            play.setAttribute('aria-pressed', String(view.running));
            play.setAttribute('aria-label', label);
            play.setAttribute('title', label);
            const icon = play.querySelector('i');
            if (icon) { icon.classList.remove('fa-play', 'fa-pause'); icon.classList.add(view.playIcon); }
        }
        const turn = doc.getElementById('simulation-bar-turn');
        if (turn) turn.textContent = String(view.turn);
        const date = doc.getElementById('simulation-bar-date');
        if (date) date.textContent = dateText;
        const speed = doc.getElementById('simulation-bar-speed');
        if (speed) {
            const wanted = view.speeds.join(',');
            if (speed.dataset.options !== wanted || speed.dataset.lang !== (win?.i18n?.getLanguage?.() || '')) {
                speed.replaceChildren(...view.speeds.map(seconds => {
                    const option = doc.createElement('option');
                    option.value = String(seconds);
                    option.textContent = t(win, 'mapShell.simulation.secondsShort', '{{seconds}} s', { seconds });
                    return option;
                }));
                speed.dataset.options = wanted;
                speed.dataset.lang = win?.i18n?.getLanguage?.() || '';
            }
            if (view.interval !== null) speed.value = String(view.interval);
        }
        return view;
    }

    // Share of the wait to the next turn, 0..1, as a CSS custom property on the bar's progress line.
    function setProgress(doc, fraction) {
        const bar = doc?.getElementById?.('simulation-bar');
        if (!bar) return;
        const share = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
        bar.style.setProperty('--simulation-progress', String(share));
    }

    // Wires the bar's controls to the game. `actions`: togglePlay, step, setInterval(seconds), newGame, stop.
    function bind(doc, actions) {
        const bar = doc?.getElementById?.('simulation-bar');
        if (!bar || bar.dataset.bound === 'true') return false;
        bar.dataset.bound = 'true';
        const on = (id, type, fn) => doc.getElementById(id)?.addEventListener(type, fn);
        on('simulation-bar-play', 'click', () => actions.togglePlay());
        on('simulation-bar-step', 'click', () => actions.step());
        on('simulation-bar-speed', 'change', event => actions.setInterval(Number.parseInt(event.target.value, 10)));
        on('simulation-bar-new', 'click', () => actions.newGame());
        on('simulation-bar-stop', 'click', () => actions.stop());
        return true;
    }

    return {
        SPEED_PRESETS,
        speedOptions,
        barView,
        sync,
        setProgress,
        bind,
        open() { open = true; },
        close() { open = false; },
        isOpen: () => open,
        lastView: () => lastView
    };
});
