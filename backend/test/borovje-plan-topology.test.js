import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

import {
    buildBorovjeTopology,
    explodePolygons,
    MIN_PLOT_AREA_M2,
    roadDefinitionFor
} from '../../rekonstrukcije/upu-borovje/plan-topology.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '..', 'rekonstrukcije', 'upu-borovje', 'data');
const load = async name => JSON.parse(await readFile(path.join(dataDir, name), 'utf8'));

describe('UPU Borovje clean ground topology', () => {
    it('uses the actual plan extent and emits only connected roads, plots and readjustments', async () => {
        const [parcelation, streets] = await Promise.all([
            load('parcelation.geojson'),
            load('streets.geojson')
        ]);
        const topology = buildBorovjeTopology(parcelation, streets, turf);

        expect(topology.stats.poolM2).toBeGreaterThan(73_000);
        expect(topology.stats.poolM2).toBeLessThan(74_000);
        expect(topology.stats.readjustmentCount).toBe(3);
        expect(topology.stats.plotCount).toBe(17);
        expect(topology.stats.minPlotM2).toBeGreaterThanOrEqual(MIN_PLOT_AREA_M2);
        expect(topology.stats.gapM2).toBeLessThan(0.5);
        expect(topology.stats.outsideM2).toBeLessThan(0.5);
        expect(topology.stats.overlapM2).toBeLessThan(0.5);

        expect(explodePolygons(topology.roads.main.geometry)).toHaveLength(1);
        expect(explodePolygons(topology.roads.west.geometry)).toHaveLength(1);
        const mainRoad = roadDefinitionFor(topology.roads.main.streets, topology.roads.main.geometry);
        const westRoad = roadDefinitionFor(topology.roads.west.streets, topology.roads.west.geometry);
        expect(mainRoad.segmentIds).toHaveLength(5);
        expect(mainRoad.points[0]).toHaveLength(5);
        expect(mainRoad.width).toBe(19);
        expect(westRoad.segmentIds).toEqual(['upu-kolno-pjesacka-zapad']);
        expect(westRoad.width).toBe(18);
        topology.plots.forEach(plot => expect(explodePolygons(plot.geometry)).toHaveLength(1));
        topology.readjustments.forEach(component => {
            expect(explodePolygons(component.geometry)).toHaveLength(1);
            expect(component.plots.length).toBeGreaterThan(0);
        });
    });

    it('keeps only intentional collector vertices and the three real junctions', async () => {
        const streets = await load('streets.geojson');
        const collector = streets.features.find(item => item.properties?.name === 'sabirna-ulica');

        expect(collector.geometry.coordinates).toEqual([
            [16.0091642, 45.7857289],
            [16.0117491, 45.7860024],
            [16.0138234, 45.7865089],
            [16.0151698, 45.7873453],
            [16.0150382, 45.7873486]
        ]);
    });
});
