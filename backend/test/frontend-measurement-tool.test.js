import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { inverse } from './helpers/ellipsoid.js';

const require = createRequire(import.meta.url);
const metricFrame = require('../../frontend/js/metric-frame.js');

it('completing a measurement removes both preview resources and retains only the finished endpoints', () => {
    const layers = new Set();
    const layer = (kind, options) => ({
        kind, options,
        addTo() { layers.add(this); return this; }
    });
    const context = vm.createContext({
        // the real frame module and no city at all: a distance never depends on one
        window: { __metricFrame: metricFrame },
        document: { getElementById: () => ({ style: {} }) },
        map: { removeLayer: item => layers.delete(item) },
        L: {
            circleMarker: (_, options) => layer('marker', options),
            polyline: (_, options) => layer('line', options),
            marker: (_, options) => layer('label', options),
            divIcon: options => options,
            latLng: (lat, lng) => ({ lat, lng })
        },
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
    const labels = [...layers].filter(item => item.kind === 'label');
    expect(labels).toHaveLength(1);
    // the measured distance is the ellipsoidal one (≈ 31.1 m for 0.0004° of longitude at 45.8°N)
    expect(labels[0].options.icon.html).toBe(`${inverse([15.982, 45.8], [15.9824, 45.8]).toFixed(1)} m`);
    context.clearAllMeasurements();
    expect(layers.size).toBe(0);
});
