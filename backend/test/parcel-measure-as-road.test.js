// Measure-as-road needs calculateRoadMetrics from road-analysis.js, which loads only on first use
// (optional-tools-loader.js). The button must load that tool before measuring, not assume it is there.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODULE = '../../frontend/js/parcels/ui/road.js';
const GLOBALS = ['currentParcel', 'LiveParcelFabric', 'document', 'CbFormat', 'updateStatus', 'ensureOptionalTool', 'calculateRoadMetrics', 'measureAsRoad'];

function element() {
    return { innerHTML: '', disabled: false, style: {} };
}

afterEach(() => {
    for (const name of GLOBALS) delete globalThis[name];
    delete require.cache[require.resolve(MODULE)];
});

describe('measure as road', () => {
    it('loads the road-analysis tool before measuring the selected parcel', async () => {
        const button = element();
        const measurements = element();
        const coordinates = [[[15.9819, 45.8], [15.9825, 45.8], [15.9825, 45.8005], [15.9819, 45.8]]];
        const metrics = { length: 42, widths: { average: 6, maximum: 7, minimum: 5, tolerancePercentage: 90 } };
        const calculate = vi.fn(() => metrics);
        Object.assign(globalThis, {
            currentParcel: { id: 'HR-1', layer: {} },
            LiveParcelFabric: { get: id => (id === 'HR-1' ? { geometry: { coordinates } } : null) },
            document: { getElementById: id => ({ measureAsRoadButton: button, roadMeasurements: measurements })[id] || null },
            CbFormat: { formatLength: value => `${value} m`, formatNumber: value => String(value) },
            updateStatus: vi.fn(),
            // Before the tool loads there is no calculateRoadMetrics at all, as on a cold page.
            ensureOptionalTool: vi.fn(async group => { if (group === 'roadAnalysis') globalThis.calculateRoadMetrics = calculate; })
        });
        const { measureAsRoad } = require(MODULE);

        await measureAsRoad();

        expect(globalThis.ensureOptionalTool).toHaveBeenCalledWith('roadAnalysis');
        expect(calculate).toHaveBeenCalledWith(coordinates);
        expect(measurements.innerHTML).toContain('42 m');
        expect(measurements.innerHTML).not.toMatch(/N\/A|NaN|undefined/);
        expect(measurements.style.display).toBe('block');
        expect(button.disabled).toBe(true);
    });
});
