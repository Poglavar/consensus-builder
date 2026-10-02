import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

it('completing a measurement removes both preview resources and retains only the finished endpoints', () => {
    const layers = new Set();
    const layer = (kind, options) => ({
        kind, options,
        addTo() { layers.add(this); return this; }
    });
    const context = vm.createContext({
        window: {},
        document: { getElementById: () => ({ style: {} }) },
        map: { removeLayer: item => layers.delete(item) },
        L: {
            circleMarker: (_, options) => layer('marker', options),
            polyline: (_, options) => layer('line', options),
            marker: (_, options) => layer('label', options),
            divIcon: options => options,
            latLng: (lat, lng) => ({ lat, lng })
        },
        wgs84ToHTRS96: (lat, lng) => [lng * 1000, lat * 1000],
        updateStatus() {}
    });
    vm.runInContext(readFileSync(new URL('../../frontend/js/measurement-tool.js', import.meta.url), 'utf8'), context);
    context.handleMeasureClick({ latlng: { lat: 45.8, lng: 15.982 } });
    context.handleMeasureMouseMove({ latlng: { lat: 45.8, lng: 15.9823 } });
    const preview = [...layers].filter(item => item.options.opacity === 0.7);
    expect(preview).toHaveLength(2);
    context.handleMeasureClick({ latlng: { lat: 45.8, lng: 15.9824 } });
    expect(preview.every(item => !layers.has(item))).toBe(true);
    expect([...layers].filter(item => item.kind === 'marker')).toHaveLength(2);
    expect([...layers].filter(item => item.kind === 'line')).toHaveLength(1);
    expect([...layers].filter(item => item.kind === 'label')).toHaveLength(1);
    context.clearAllMeasurements();
    expect(layers.size).toBe(0);
});
