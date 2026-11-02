import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create } = require('../../frontend/js/parcels/block-detection-preview.js');

function harness({ visible = true, throwOnOpen = false } = {}) {
    let resolveClosed, rejectClosed, options;
    const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    const dialog = {
        closed,
        close: vi.fn(result => { options?.onClose?.(result); resolveClosed(result); }),
        reject: error => rejectClosed(error)
    };
    const previewLayer = {
        addTo: vi.fn(() => previewLayer),
        getBounds: () => ({ isValid: () => true, id: 'feature-bounds' }),
        remove: vi.fn()
    };
    const svgRenderer = { type: 'svg-renderer' };
    const selection = { selectedParcels: new Set(['parcel-1', 'parcel-2']), clearSelection: vi.fn(), selectParcel: vi.fn() };
    const map = {
        getBounds: () => ({ contains: vi.fn(() => visible) }),
        getCenter: () => ({ lat: 45.8, lng: 15.98 }),
        getZoom: () => 16,
        fitBounds: vi.fn(),
        setView: vi.fn(),
        removeLayer: vi.fn()
    };
    const win = {
        map,
        L: { svg: vi.fn(() => svgRenderer), geoJSON: vi.fn(() => previewLayer) },
        MapHighlight: { style: vi.fn(options => ({ color: '#ffdd00', ...options })) },
        CityConfigManager: { getCurrentCityId: () => 'zg' },
        isThreeModeActive: () => false,
        multiParcelSelection: selection,
        document: { createElement: tagName => ({ tagName, textContent: '' }) },
        i18n: { t: key => ({ 'common.ok': 'OK', 'common.close': 'Close' })[key] || key },
        CbDialog: { open: vi.fn(value => {
            options = value;
            if (throwOnOpen) throw new Error('dialog unavailable');
            return dialog;
        }) }
    };
    return { api: create(win), dialog, map, previewLayer, selection, win, get options() { return options; }, rejectClosed: error => dialog.reject(error) };
}

describe('block detection preview', () => {
    it('shows at most 100 features in a separate noninteractive highlight and cleans up on close', async () => {
        const h = harness({ visible: true });
        const features = Array.from({ length: 103 }, (_, index) => ({ type: 'Feature', id: `f-${index}`, properties: {}, geometry: null }));
        const before = [...h.selection.selectedParcels];
        const closed = h.api.show(features, { title: 'Detected block', message: 'A boundary is incomplete.' });

        expect(h.win.L.geoJSON).toHaveBeenCalledOnce();
        expect(h.win.L.geoJSON.mock.calls[0][0]).toHaveLength(100);
        expect(h.win.L.geoJSON.mock.calls[0][0][0]).toBe(features[0]);
        expect(h.win.L.geoJSON.mock.calls[0][1]).toMatchObject({ renderer: { type: 'svg-renderer' }, interactive: false,
            style: { color: '#ffdd00', className: 'block-detection-preview' } });
        expect(h.win.L.svg).toHaveBeenCalledOnce();
        expect(h.win.MapHighlight.style).toHaveBeenCalledWith({ className: 'block-detection-preview' });
        expect(h.map.fitBounds).not.toHaveBeenCalled();
        expect(h.options.title).toBe('Detected block');
        expect(h.options.role).toBe('alertdialog');
        expect(h.options.overlayClassName).toBe('block-detection-preview-overlay');
        expect(h.options.body.textContent).toBe('A boundary is incomplete.');
        expect(h.options.actions[0]).toMatchObject({ id: 'ok', label: 'OK', role: 'primary', autofocus: true });
        expect([...h.selection.selectedParcels]).toEqual(before);
        expect(h.selection.clearSelection).not.toHaveBeenCalled();
        expect(h.selection.selectParcel).not.toHaveBeenCalled();

        h.dialog.close('ok');
        await expect(closed).resolves.toBe('ok');
        expect(h.map.removeLayer).toHaveBeenCalledExactlyOnceWith(h.previewLayer);
        expect(h.selection.selectedParcels).toEqual(new Set(before));
    });

    it('frames only offscreen bounds and restores the prior map view when the dialog closes', async () => {
        const h = harness({ visible: false });
        const closed = h.api.show([{ type: 'Feature', properties: {}, geometry: null }], { message: 'Outside the current view.' });
        expect(h.map.fitBounds).toHaveBeenCalledExactlyOnceWith({ isValid: expect.any(Function), id: 'feature-bounds' }, {
            padding: [32, 32], maxZoom: 16, animate: false
        });
        h.dialog.close(null); // CbDialog uses the same close path for its close button and Escape.
        await expect(closed).resolves.toBeNull();
        expect(h.map.setView).toHaveBeenCalledExactlyOnceWith({ lat: 45.8, lng: 15.98 }, 16, { animate: false });
        expect(h.map.removeLayer).toHaveBeenCalledExactlyOnceWith(h.previewLayer);
    });

    it('removes the overlay and restores the camera if dialog creation throws', async () => {
        const h = harness({ visible: false, throwOnOpen: true });
        await expect(h.api.show([{ type: 'Feature', properties: {}, geometry: null }], { message: 'Could not continue.' }))
            .rejects.toThrow('dialog unavailable');
        expect(h.map.removeLayer).toHaveBeenCalledExactlyOnceWith(h.previewLayer);
        expect(h.map.setView).toHaveBeenCalledExactlyOnceWith({ lat: 45.8, lng: 15.98 }, 16, { animate: false });
    });

    it('does not restore a temporary camera after the city or map mode changes', async () => {
        const h = harness({ visible: false });
        const closed = h.api.show([{ type: 'Feature', properties: {}, geometry: null }], { message: 'Temporary frame.' });
        h.win.CityConfigManager.getCurrentCityId = () => 'ljubljana';
        h.dialog.close(null);
        await closed;
        expect(h.map.setView).not.toHaveBeenCalled();
    });

    it('cleans the preview layer when the dialog closed promise rejects', async () => {
        const h = harness();
        const closed = h.api.show([{ type: 'Feature', properties: {}, geometry: null }], { message: 'Close failed.' });
        h.rejectClosed(new Error('close failed'));
        await expect(closed).rejects.toThrow('close failed');
        expect(h.map.removeLayer).toHaveBeenCalledExactlyOnceWith(h.previewLayer);
    });
});
