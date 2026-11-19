// The simulation's on-map pieces without a browser: where agent bubbles sit (2D and 3D projections,
// agent-bubble-placement.js) and what the floating simulation bar shows (ui/simulation-bar.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Placement = require('../../frontend/js/agent-bubble-placement.js');
const SimulationBar = require('../../frontend/js/ui/simulation-bar.js');

const W = 1000, H = 800;
const inset = Placement.DEFAULT_INSET;
const R = Placement.BUBBLE_RADIUS;

describe('agent bubble placement', () => {
    it('docks a bubble on the rim ring in the direction of its design', () => {
        const right = Placement.placeBubble({ projected: { x: 2000, y: 400 }, width: W, height: H });
        expect(right).toMatchObject({ left: W - inset.right - R, top: 400 - R, docked: true });
        expect(right.angle).toBeCloseTo(0);
        const up = Placement.placeBubble({ projected: { x: 500, y: -500 }, width: W, height: H });
        expect(up).toMatchObject({ left: 500 - R, top: inset.top - R, docked: true });
        expect(up.angle).toBeCloseTo(-Math.PI / 2);
    });

    it('docks even a design on screen until the camera has gone to it', () => {
        const docked = Placement.placeBubble({ projected: { x: 600, y: 400 }, width: W, height: H });
        expect(docked.docked).toBe(true);
        expect(docked.left).toBe(W - inset.right - R);
    });

    it('sits over its design once landed, and docks again when the design leaves the ring', () => {
        const landed = Placement.placeBubble({ projected: { x: 600, y: 300 }, width: W, height: H, atObject: true });
        expect(landed).toEqual({ left: 600 - R, top: 300 - R, angle: null, docked: false });
        const panned = Placement.placeBubble({ projected: { x: 990, y: 300 }, width: W, height: H, atObject: true });
        expect(panned.docked).toBe(true);
    });

    it('points a design behind the 3D camera to the side it lies on, never over it', () => {
        // Behind the camera and to its left (camera-space x < 0): the bubble docks on the left rim.
        const projected = Placement.fromCameraSpace({ view: { x: -50, y: 0, z: 30 }, ndc: { x: 0.4, y: 0 }, near: 1, width: W, height: H });
        expect(projected).toEqual({ behind: true, direction: { x: -50, y: -0 } });
        const placed = Placement.placeBubble({ projected, width: W, height: H, atObject: true });
        expect(placed).toMatchObject({ left: inset.left - R, docked: true });
    });

    it('turns a camera-space point in front of the camera into container pixels', () => {
        const projected = Placement.fromCameraSpace({ view: { x: 0, y: 0, z: -100 }, ndc: { x: 0.5, y: -0.5 }, near: 1, width: W, height: H });
        expect(projected).toEqual({ behind: false, x: 750, y: 600 });
    });

    it('places nothing without a size or a usable projection', () => {
        expect(Placement.placeBubble({ projected: { x: 1, y: 1 }, width: 0, height: H })).toBeNull();
        expect(Placement.placeBubble({ projected: null, width: W, height: H })).toBeNull();
        expect(Placement.placeBubble({ projected: { x: NaN, y: 1 }, width: W, height: H })).toBeNull();
        expect(Placement.fromCameraSpace({ view: { x: 0, y: 0, z: null }, ndc: { x: 0, y: 0 }, near: 1, width: W, height: H })).toBeNull();
    });
});

describe('simulation bar', () => {
    it('is shown from Play until Stop, and while a game runs', () => {
        expect(SimulationBar.barView({ open: false, gameState: { isRunning: false } }).hidden).toBe(true);
        expect(SimulationBar.barView({ open: true, gameState: { isRunning: false } }).hidden).toBe(false);
        expect(SimulationBar.barView({ open: false, gameState: { isRunning: true } }).hidden).toBe(false);
    });

    it('offers pause while running and play while paused', () => {
        const running = SimulationBar.barView({ open: true, gameState: { isRunning: true, currentTurn: 4, turnIntervalSeconds: 10 } });
        expect(running).toMatchObject({ running: true, playIcon: 'fa-pause', playLabelKey: 'sidebar.game.pause', turn: 4, interval: 10 });
        const paused = SimulationBar.barView({ open: true, gameState: { isRunning: false, currentTurn: 4, turnIntervalSeconds: 10 } });
        expect(paused).toMatchObject({ running: false, playIcon: 'fa-play', playLabelKey: 'sidebar.game.play' });
    });

    it('keeps the interval set in Settings among the speed choices', () => {
        expect(SimulationBar.speedOptions(10)).toEqual([3, 5, 10, 20, 30, 60]);
        expect(SimulationBar.speedOptions(7)).toEqual([3, 5, 7, 10, 20, 30, 60]);
        expect(SimulationBar.speedOptions(NaN)).toEqual([3, 5, 10, 20, 30, 60]);
    });

    it('tracks open and close', () => {
        SimulationBar.open();
        expect(SimulationBar.isOpen()).toBe(true);
        SimulationBar.close();
        expect(SimulationBar.isOpen()).toBe(false);
    });
});
