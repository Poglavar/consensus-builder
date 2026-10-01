// The running dot on the Activity button (frontend/js/ui/simulation-indicator.js): it follows
// gameState.isRunning, so a running in-UI simulation is visible with the Activity sheet closed,
// and shows nothing when the simulation is stopped.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SimulationIndicator = require('../../frontend/js/ui/simulation-indicator.js');
const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');

// The two elements sync() touches, with just the DOM surface it uses.
function fakeDoc() {
    const classes = new Set();
    const dot = { hidden: true };
    const button = { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), has: name => classes.has(name) } };
    const byId = { [SimulationIndicator.DOT_ID]: dot, [SimulationIndicator.BUTTON_ID]: button };
    return { doc: { getElementById: id => byId[id] || null }, dot, button };
}

describe('simulation running indicator', () => {
    it('is visible only while the game is running', () => {
        expect(SimulationIndicator.indicatorFor({ isRunning: true })).toEqual({ visible: true });
        expect(SimulationIndicator.indicatorFor({ isRunning: false })).toEqual({ visible: false });
        expect(SimulationIndicator.indicatorFor(null)).toEqual({ visible: false });
        expect(SimulationIndicator.indicatorFor({ isRunning: 'yes' })).toEqual({ visible: false });
    });

    it('shows the dot on play and hides it again on pause', () => {
        const { doc, dot, button } = fakeDoc();
        const gameState = { isRunning: true };
        SimulationIndicator.sync(doc, gameState);
        expect(dot.hidden).toBe(false);
        expect(button.classList.has('is-simulating')).toBe(true);
        gameState.isRunning = false;
        SimulationIndicator.sync(doc, gameState);
        expect(dot.hidden).toBe(true);
        expect(button.classList.has('is-simulating')).toBe(false);
    });

    it('tolerates a page without the dot', () => {
        expect(SimulationIndicator.sync({ getElementById: () => null }, { isRunning: true })).toEqual({ visible: true });
    });

    it('is wired: the dot sits in the Activity button, hidden and labelled, and game.js syncs it', () => {
        const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
        const button = html.slice(html.indexOf('id="activity-button"'), html.indexOf('</button>', html.indexOf('id="activity-button"')));
        expect(button).toMatch(/id="activity-running-dot"[^>]*aria-label="Simulation running"[^>]*hidden/);
        expect(html).toContain("'js/ui/simulation-indicator.js'");
        const gameJs = fs.readFileSync(path.join(FRONTEND, 'js/game.js'), 'utf8');
        const updateUi = gameJs.slice(gameJs.indexOf('gameState.updateGameUI = function'), gameJs.indexOf('function toggleGamePlayPause'));
        expect(updateUi).toContain('SimulationIndicator.sync(document, this)');
        const css = fs.readFileSync(path.join(FRONTEND, 'css/map-shell.css'), 'utf8');
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.map-shell-running-dot\s*\{\s*animation: none;/);
    });
});
