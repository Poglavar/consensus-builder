// The zoom bubble on the Layers button (frontend/js/ui/view-zoom.js): its number format, and that it
// shows LoadView's zoom, follows 2D zooms, 3D camera moves and mode switches, describes the button
// as "Zoom 17" for assistive technology, and relabels on a language change.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatZoom, install } = require('../../frontend/js/ui/view-zoom.js');

function fakePage({ language = 'en' } = {}) {
    const win = new EventTarget();
    const doc = new EventTarget();
    const bubble = { hidden: true, textContent: '', title: 'Map zoom level.' };
    const description = { hidden: true, textContent: '' };
    doc.getElementById = id => ({ 'layers-button-zoom': bubble, 'layers-button-zoom-text': description })[id] || null;
    const mapHandlers = {};
    let view = { mode: '2d', zoom: 17 };
    const languageListeners = [];
    const strings = {
        en: { 'mapShell.zoomLevel': 'Zoom {zoom}', 'mapShell.zoomLevelTitle': 'Map zoom level, translated.' },
        hr: { 'mapShell.zoomLevel': 'Zum {zoom}', 'mapShell.zoomLevelTitle': 'Razina zumiranja karte.' },
    };
    Object.assign(win, {
        document: doc,
        map: { on: (name, fn) => { mapHandlers[name] = fn; } },
        LoadView: { current: () => view },
        i18n: {
            t: (key, params = {}) => (strings[language][key] || key).replace(/\{(\w+)\}/g, (m, k) => params[k] ?? m),
            getLocale: () => (language === 'hr' ? 'hr-HR' : 'en-GB'),
            onChange: fn => languageListeners.push(fn),
        },
    });
    return {
        win, bubble, description, mapHandlers,
        setView: next => { view = next; },
        setLanguage: next => { language = next; languageListeners.forEach(fn => fn(next)); },
    };
}

describe('view zoom badge', () => {
    it('formats whole 2D zooms plainly and 3D zooms to one decimal in the locale', () => {
        expect(formatZoom(17, 'en-GB')).toBe('17');
        expect(formatZoom(16.437, 'en-GB')).toBe('16.4');
        expect(formatZoom(16.437, 'hr-HR')).toBe('16,4');
        expect(formatZoom(16.96, 'en-GB')).toBe('17');
        expect(formatZoom(null)).toBeNull();
        expect(formatZoom(Number.NaN)).toBeNull();
    });

    it('shows the zoom at once and follows 2D zooms, 3D camera moves and mode switches', () => {
        const page = fakePage();
        install(page.win);
        expect(page.bubble).toMatchObject({ hidden: false, textContent: '17', title: 'Map zoom level, translated.' });
        expect(page.description.textContent).toBe('Zoom 17');

        page.setView({ mode: '2d', zoom: 18 });
        page.mapHandlers.zoomend();
        expect(page.bubble.textContent).toBe('18');

        page.setView({ mode: '3d', zoom: 16.437 });
        page.win.dispatchEvent(new Event('loadviewchange'));
        expect(page.bubble.textContent).toBe('16.4');
        expect(page.description.textContent).toBe('Zoom 16.4');
        page.setView({ mode: '3d', zoom: 15.02 });
        page.win.dispatchEvent(new Event('threecamerachange'));
        expect(page.bubble.textContent).toBe('15');

        // A view without a zoom hides the bubble rather than showing a made-up number.
        page.setView(null);
        page.win.dispatchEvent(new Event('loadviewchange'));
        expect(page.bubble.hidden).toBe(true);
        expect(page.description.textContent).toBe('');
    });

    it('relabels the number and its description on a language change', () => {
        const page = fakePage();
        page.setView({ mode: '3d', zoom: 16.437 });
        install(page.win);
        page.setLanguage('hr');
        expect(page.bubble).toMatchObject({ textContent: '16,4', title: 'Razina zumiranja karte.' });
        expect(page.description.textContent).toBe('Zum 16,4');
    });
});
