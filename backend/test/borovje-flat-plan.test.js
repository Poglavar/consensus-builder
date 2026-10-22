// The UPU Borovje buildings fitted to their plots (restatements/upu-borovje/flat-plan.mjs): every traced
// footprint ends up inside the plot the plan gives it, the two slight overhangs of the trace are clipped,
// and a building that would lose more than a tenth of itself or split in two is refused.
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as turf from '@turf/turf';
import { buildBorovjeTopology } from '../../restatements/upu-borovje/plan-topology.mjs';
import { fitBuildingsToPlots, MAX_TRIMMED_SHARE } from '../../restatements/upu-borovje/flat-plan.mjs';

const load = async file => JSON.parse(await readFile(new URL(`../../restatements/upu-borovje/data/${file}`, import.meta.url), 'utf8'));
const outsideM2 = (geometry, plot) => {
    const outside = turf.difference(turf.feature(geometry), turf.feature(plot));
    return outside ? turf.area(outside) : 0;
};

async function borovje() {
    const [parcelation, streets, buildings] = await Promise.all([load('parcelation.geojson'), load('streets.geojson'), load('buildings.geojson')]);
    const plots = buildBorovjeTopology(parcelation, streets, turf).readjustments.flatMap(block => block.plots);
    const plotOf = name => plots.find(plot => plot.properties.name === name)?.geometry || null;
    const traced = buildings.features.filter(item => item.properties.pp !== 'PP-5').map(item => ({ name: item.properties.name, geometry: item.geometry }));
    return { traced, plotOf };
}

// A 100 m × 20 m rectangle near Borovje, in degrees, at an offset in metres.
const rectangle = (eastM, northM, widthM = 100, heightM = 20) => {
    const [w, s] = turf.destination(turf.destination([16.0100, 45.7860], eastM / 1000, 90).geometry.coordinates, northM / 1000, 0).geometry.coordinates;
    const [e] = turf.destination([w, s], widthM / 1000, 90).geometry.coordinates;
    const [, n] = turf.destination([w, s], heightM / 1000, 0).geometry.coordinates;
    return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
};

describe('fitBuildingsToPlots', () => {
    it('fits all eleven traced buildings inside their plots, clipping only the two overhangs, and leaves the trace alone', async () => {
        const { traced, plotOf } = await borovje();
        const before = structuredClone(traced);
        const fitted = fitBuildingsToPlots(traced, plotOf, turf);
        expect(traced).toEqual(before);
        expect(fitted.map(entry => entry.name)).toEqual(traced.map(entry => entry.name));
        expect(fitted).toHaveLength(11);
        fitted.forEach((entry, index) => {
            expect(outsideM2(entry.geometry, plotOf(entry.name)), entry.name).toBeLessThan(0.01);
            expect(entry.geometry.type).toBe('Polygon');
            expect(entry.beforeM2 - entry.afterM2).toBeCloseTo(entry.trimmedM2, 1);
            if (entry.trimmedM2 <= 1e-6) expect(entry.geometry, entry.name).toBe(traced[index].geometry);
        });
        const trimmed = Object.fromEntries(fitted.filter(entry => entry.trimmedM2 > 1).map(entry => [entry.name, entry.trimmedM2]));
        expect(Object.keys(trimmed).sort()).toEqual(['M1-11', 'M1-9']);
        expect(trimmed['M1-9']).toBeGreaterThan(30);
        expect(trimmed['M1-9']).toBeLessThan(40);
        expect(trimmed['M1-11']).toBeGreaterThan(20);
        expect(trimmed['M1-11']).toBeLessThan(30);
        // Fitting again changes nothing.
        const again = fitBuildingsToPlots(fitted.map(entry => ({ name: entry.name, geometry: entry.geometry })), plotOf, turf);
        again.forEach((entry, index) => {
            expect(entry.trimmedM2, entry.name).toBeLessThan(0.01);
            expect(entry.afterM2).toBeCloseTo(fitted[index].afterM2, 1);
        });
    });

    it('refuses a building without a plot, or one displaced off it', async () => {
        const { traced, plotOf } = await borovje();
        expect(() => fitBuildingsToPlots([{ name: 'M1-99', geometry: traced[0].geometry }], plotOf, turf)).toThrow('Missing intended plot for M1-99.');
        const displaced = { name: traced[4].name, geometry: turf.transformTranslate(turf.feature(traced[4].geometry), 100, 90, { units: 'meters' }).geometry };
        expect(() => fitBuildingsToPlots([displaced], plotOf, turf)).toThrow(`${traced[4].name}: clipping would disconnect the building or remove more than 10%.`);
    });

    it('clips an overhang up to a tenth of the footprint, and never splits a building', () => {
        expect(MAX_TRIMMED_SHARE).toBe(0.1);
        const plot = rectangle(0, 0, 100, 40);
        // 5 m of a 100 m building beyond the plot's east edge: 5 % is clipped.
        const [overhang] = fitBuildingsToPlots([{ name: 'over', geometry: rectangle(5, 10) }], () => plot, turf);
        expect(overhang.trimmedM2 / overhang.beforeM2).toBeCloseTo(0.05, 2);
        expect(outsideM2(overhang.geometry, plot)).toBeLessThan(0.01);
        // 15 m beyond it: refused.
        expect(() => fitBuildingsToPlots([{ name: 'far', geometry: rectangle(15, 10) }], () => plot, turf)).toThrow('far: clipping would disconnect the building or remove more than 10%.');
        // A plot notched in the middle would cut the building in two, though it loses only 2 % of itself.
        const notch = rectangle(49, 20, 2, 20);
        const notched = turf.difference(turf.feature(plot), turf.feature(notch)).geometry;
        const across = rectangle(0, 25, 100, 10);
        expect(() => fitBuildingsToPlots([{ name: 'split', geometry: across }], () => notched, turf)).toThrow('split: clipping would disconnect the building');
    });
});
