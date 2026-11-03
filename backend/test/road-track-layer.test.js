import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = await readFile(new URL('../../frontend/js/road-track-layer.js', import.meta.url), 'utf8');

function harness({ zoom = 16, roads, saved = '0' } = {}) {
    const events = {};
    const checkbox = { checked: false, addEventListener: (name, fn) => { events[`checkbox:${name}`] = fn; } };
    const status = { textContent: '' };
    const pane = { classList: { add: vi.fn() } };
    const paths = [];
    const group = { clearLayers: vi.fn(), addTo: vi.fn(() => group), layers: [], };
    const map = {
        createPane: vi.fn(() => pane), on: (name, fn) => { events[name] = fn; },
        getZoom: () => zoom, getBounds: () => ({ getSouthWest: () => ({ lng: 0, lat: 0 }), getNorthEast: () => ({ lng: .01, lat: .01 }) }),
        hasLayer: () => false, removeLayer: vi.fn()
    };
    const win = {
        document: { getElementById: id => ({ 'road-track-layer-checkbox': checkbox, 'road-track-layer-status': status }[id] || null) },
        map, L: { layerGroup: () => group, geoJSON: (data, options) => { paths.push({ data, options }); return { addTo: target => target.layers.push(data) }; } },
        ParcelBlockDetection: { fetchBoundaries: vi.fn(async () => roads) },
        UrbanBlocksModel: { isRoadTrackBoundary: props => props.highway === 'residential' || props.track },
        AbortController, localStorage: { getItem: () => saved, setItem: vi.fn() },
        addEventListener: (name, fn) => { events[`window:${name}`] = fn; },
        i18n: { t: key => key }
    };
    vm.runInNewContext(source, { window: win });
    return { win, events, checkbox, status, paths, group };
}

describe('RoadTrackLayer', () => {
    it('loads only shared-model eligible features into a noninteractive layer', async () => {
        const h = harness({ roads: { complete: true, features: [
            { type: 'Feature', properties: { highway: 'residential' } },
            { type: 'Feature', properties: { amenity: 'workshop' } },
            { type: 'Feature', properties: { track: true } }
        ] } });
        h.win.RoadTrackLayer.initialize();
        await h.win.RoadTrackLayer.setEnabled(true);
        expect(h.paths[0].data.features).toHaveLength(2);
        expect(h.paths[0].options.interactive).toBe(false);
        expect(h.checkbox.checked).toBe(true);
        expect(h.status.textContent).toBe('Showing eligible roads and tracks.');
    });

    it('aborts and ignores a late response when disabled', async () => {
        let finish;
        const h = harness({ roads: null });
        h.win.ParcelBlockDetection.fetchBoundaries = vi.fn((_win, _bbox, signal) => new Promise(resolve => {
            finish = () => resolve({ complete: true, features: [{ properties: { track: true } }] });
            signal.addEventListener('abort', () => {});
        }));
        h.win.RoadTrackLayer.initialize();
        const pending = h.win.RoadTrackLayer.setEnabled(true);
        await h.win.RoadTrackLayer.setEnabled(false);
        finish(); await pending;
        expect(h.paths).toHaveLength(0);
        expect(h.win.RoadTrackLayer.isEnabled()).toBe(false);
    });

    it('restores enabled state and reports zoom limits', async () => {
        const h = harness({ zoom: 14, saved: '1', roads: { features: [] } });
        h.win.RoadTrackLayer.initialize();
        expect(h.win.RoadTrackLayer.isEnabled()).toBe(true);
        expect(h.checkbox.checked).toBe(true);
        expect(h.status.textContent).toBe('Zoom in to neighbourhood scale to show roads and tracks.');
        expect(h.win.ParcelBlockDetection.fetchBoundaries).not.toHaveBeenCalled();
    });

    it('reports incomplete data and permits a retry without claiming success', async () => {
        const h = harness({ roads: { complete: false, features: [] } });
        h.win.RoadTrackLayer.initialize();
        expect(await h.win.RoadTrackLayer.setEnabled(true)).toBe(false);
        expect(h.paths).toHaveLength(0);
        expect(h.status.textContent).toContain('Could not load');
        h.win.ParcelBlockDetection.fetchBoundaries.mockResolvedValue({ complete: true, features: [] });
        expect(await h.win.RoadTrackLayer.setEnabled(true)).toBe(true);
    });
});
