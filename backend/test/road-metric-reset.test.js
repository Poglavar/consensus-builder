// The road panel's metrics reset (frontend/js/road-drawing.js, resetRoadMetricPlaceholders): ending
// a drawing must clear length and area too, or the next drawing opens on the last road's figures.
// Drives the real tool in the fake browser world (helpers/road-drawing-env.js).
import { describe, expect, it, afterEach } from 'vitest';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

describe('resetRoadMetricPlaceholders', () => {
    it('clears length and area along with the parcel figures', () => {
        env = loadRoadDrawing();
        const text = id => env.element(id).textContent;
        const { formatLength, formatArea } = globalThis.CbFormat;
        env.element('road-length').textContent = formatLength(412);
        env.element('road-area').textContent = formatArea(6180);
        ['road-individual-owners', 'road-market-price', 'road-acquire-difficulty']
            .forEach(id => { env.element(id).textContent = 'stale'; });
        env.session.roadOpenGroundCrossed.locked.set('a', 100);
        env.session.roadOpenGroundCrossed.preview.set('b', 100);
        env.api.resetRoadMetricPlaceholders();
        expect(text('road-length')).toBe(formatLength(0));
        expect(text('road-area')).toBe(formatArea(0));
        expect(text('road-individual-owners')).toBe('—');
        expect(env.session.roadOpenGroundCrossed.locked.size + env.session.roadOpenGroundCrossed.preview.size).toBe(0);
    });

    it('a discarded drawing leaves no length or area for the next one to open on', async () => {
        env = loadRoadDrawing();
        const { formatLength, formatArea } = globalThis.CbFormat;
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(0, 0));
        await env.click(at(100, 0));
        expect(env.element('road-length').textContent).toBe(formatLength(100));
        expect(env.element('road-area').textContent).not.toBe(formatArea(0));

        globalThis.showStyledChoice = async () => 'discard';
        expect(await env.api.cancelRoadDrawing()).toBe(true);
        expect(env.session.roadDrawingMode).toBe(false);
        expect(env.element('road-length').textContent).toBe(formatLength(0));
        expect(env.element('road-area').textContent).toBe(formatArea(0));
    });
});
