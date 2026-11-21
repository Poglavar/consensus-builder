// The view's coordinates in the Layers sheet (frontend/js/ui/view-coordinates.js): they show the
// position MapShare reads (the 2D centre, or the 3D camera's target), follow map and camera moves,
// name the button for assistive technology with the visible text, and copy what the view is at.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { install } = require('../../frontend/js/ui/view-coordinates.js');
const SearchModel = require('../../frontend/js/ui/search-model.js');

function fakePage() {
    const win = new EventTarget();
    const doc = new EventTarget();
    const attributes = {};
    const button = { hidden: true, title: '', listeners: {}, setAttribute: (name, value) => { attributes[name] = value; },
        addEventListener(name, fn) { this.listeners[name] = fn; } };
    const text = { textContent: '' };
    doc.getElementById = id => ({ 'view-coordinates-copy': button, 'view-coordinates-text': text })[id] || null;
    const mapHandlers = {};
    let position = { mode: '2d', camera: null, lat: 45.8150123, lng: 15.9819456, zoom: 17 };
    Object.assign(win, {
        document: doc, SearchModel,
        map: { on: (name, fn) => { mapHandlers[name] = fn; } },
        MapShare: { position: () => position },
        copyTextWithFeedback: vi.fn(async () => true),
        i18n: { t: (key, params = {}) => (key === 'mapShell.viewCoordinates' ? `Copy the coordinates: ${params.coordinates}` : key) }
    });
    return { win, button, text, attributes, mapHandlers, move: next => { position = { ...position, ...next }; } };
}

describe('view coordinates', () => {
    it('shows the view position and names the button with it', () => {
        const page = fakePage();
        install(page.win);
        expect(page.button.hidden).toBe(false);
        expect(page.text.textContent).toBe('45.81501, 15.98195');
        expect(page.attributes['aria-label']).toBe('Copy the coordinates: 45.81501, 15.98195');
        expect(page.button.title).toBe('Copy the coordinates: 45.81501, 15.98195');
    });

    it('follows 2D moves and the 3D camera', () => {
        const page = fakePage();
        install(page.win);
        page.move({ lat: 43.5, lng: 16.44 });
        page.mapHandlers.moveend();
        expect(page.text.textContent).toBe('43.50000, 16.44000');
        page.move({ mode: '3d', lat: 43.79754, lng: 77.0896 });
        page.win.dispatchEvent(new Event('threecamerachange'));
        expect(page.text.textContent).toBe('43.79754, 77.08960');
    });

    it('copies where the view is when clicked, also mid-move', () => {
        const page = fakePage();
        install(page.win);
        page.move({ lat: 1.5, lng: -2.25 });
        page.button.listeners.click();
        expect(page.win.copyTextWithFeedback).toHaveBeenCalledWith('1.50000, -2.25000');
    });
});
