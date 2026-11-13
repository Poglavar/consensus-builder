// The zoom badge beside the Layers heading (frontend/js/ui/view-zoom.js): its number format, and
// that it shows LoadView's zoom, follows 2D zooms, 3D camera moves and mode switches while the
// sheet is open, and relabels on a language change.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatZoom, install } = require('../../frontend/js/ui/view-zoom.js');

function fakePage({ language = 'en' } = {}) {
    const win = new EventTarget();
    const doc = new EventTarget();
    const sheet = { id: 'layers-sheet', hidden: true };
    const badge = { hidden: true, textContent: '', title: 'Map zoom level.' };
    doc.getElementById = id => ({ 'layers-sheet': sheet, 'layers-sheet-zoom': badge })[id] || null;
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
        win, doc, sheet, badge, mapHandlers,
        setView: next => { view = next; },
        setLanguage: next => { language = next; languageListeners.forEach(fn => fn(next)); },
        open: () => { sheet.hidden = false; doc.dispatchEvent(new CustomEvent('mapshell:sheetopened', { detail: { id: 'layers-sheet' } })); },
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

    it('shows the zoom when Layers opens and follows 2D zooms, 3D camera moves and mode switches', () => {
        const page = fakePage();
        install(page.win);
        // Nothing is read while the sheet is closed.
        expect(page.badge.hidden).toBe(true);
        expect(page.badge.title).toBe('Map zoom level, translated.');
        page.open();
        expect(page.badge).toMatchObject({ hidden: false, textContent: 'Zoom 17' });

        page.setView({ mode: '2d', zoom: 18 });
        page.mapHandlers.zoomend();
        expect(page.badge.textContent).toBe('Zoom 18');

        page.setView({ mode: '3d', zoom: 16.437 });
        page.win.dispatchEvent(new Event('loadviewchange'));
        expect(page.badge.textContent).toBe('Zoom 16.4');
        page.setView({ mode: '3d', zoom: 15.02 });
        page.win.dispatchEvent(new Event('threecamerachange'));
        expect(page.badge.textContent).toBe('Zoom 15');

        // A view without a zoom hides the badge rather than showing a made-up number.
        page.setView(null);
        page.win.dispatchEvent(new Event('loadviewchange'));
        expect(page.badge.hidden).toBe(true);
    });

    it('stays put while Layers is closed and catches up when it opens', () => {
        const page = fakePage();
        install(page.win);
        page.open();
        page.sheet.hidden = true;
        page.setView({ mode: '2d', zoom: 12 });
        page.mapHandlers.zoomend();
        expect(page.badge.textContent).toBe('Zoom 17');
        page.open();
        expect(page.badge.textContent).toBe('Zoom 12');
    });

    it('relabels the number and its description on a language change', () => {
        const page = fakePage();
        install(page.win);
        page.setView({ mode: '3d', zoom: 16.437 });
        page.open();
        page.setLanguage('hr');
        expect(page.badge).toMatchObject({ textContent: 'Zum 16,4', title: 'Razina zumiranja karte.' });
    });
});
