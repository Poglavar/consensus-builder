// Regression: old coordinated metadata discards the ground needed by later Borovje proposals.
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { buildBorovjeTopology } from '../../rekonstrukcije/upu-borovje/plan-topology.mjs';
import { BOROVJE_IDS, repairBorovjeRecords } from '../../rekonstrukcije/upu-borovje/flat-plan.mjs';
const require = createRequire(import.meta.url);
const { shouldFormOwnBuildingParcel } = require('../../frontend/js/proposals/apply/buildings.js');
const load = async file => JSON.parse(await readFile(new URL(`../../rekonstrukcije/upu-borovje/data/${file}`, import.meta.url), 'utf8'));

async function fixture() {
    const [parcelation, streets, buildings] = await Promise.all([
        load('parcelation.geojson'), load('streets.geojson'), load('buildings.geojson')
    ]);
    const topology = buildBorovjeTopology(parcelation, streets, turf);
    const records = BOROVJE_IDS.map(proposalId => ({ proposalId, coordinatedPlanId: 'upu-borovje', cadastreParcelIds: ['HR-335550-1791/69'] }));
    topology.readjustments.forEach((block, index) => {
        records[index].goal = 'reparcellization';
        records[index].reparcellization = { algorithm: 'upu-plan', poolGeometry: block.geometry,
            polygons: block.plots.map(p => ({ sourceName: p.properties.name, geometry: p.geometry })) };
    });
    records[3].roadProposal = { definition: { polygon: topology.roads.main.geometry } };
    records[4].roadProposal = { definition: { polygon: topology.roads.west.geometry } };
    for (const record of records.slice(5,16)) {
        const name = record.proposalId.replace('upu-borovje-', '').toUpperCase();
        const building = buildings.features.find(f => f.properties.name === name);
        record.goal = 'single';
        record.buildingProposal = { parameters: { typology: 'single', height: 21 } };
        record.geometry = { buildings: [building] };
    }
    return records;
}

describe('Borovje ordinary plan repair', () => {
    it('preserves all members and plot boundaries, fits buildings to their plots, and is idempotent', async () => {
        const input = await fixture();
        const before = structuredClone(input);
        const { records, adjustments } = repairBorovjeRecords(input, turf);
        expect(input).toEqual(before);
        expect(records.map(r => r.proposalId)).toEqual(BOROVJE_IDS);
        records.forEach(r => expect(r.coordinatedPlanId).toBeUndefined());
        const plots = records.flatMap(r => r.reparcellization?.polygons || []);
        expect(plots).toEqual(before.flatMap(r => r.reparcellization?.polygons || []));
        expect(records.slice(3,5).map(r => r.roadProposal)).toEqual(before.slice(3,5).map(r => r.roadProposal));
        for (const r of records.filter(r => r.buildingProposal)) {
            expect(shouldFormOwnBuildingParcel(r, r.goal, 1)).toBe(false);
            const plot = plots.find(p => p.sourceName.toLowerCase() === r.proposalId.replace('upu-borovje-',''));
            const outside = turf.difference(r.geometry.buildings[0], turf.feature(plot.geometry));
            expect(outside ? turf.area(outside) : 0).toBeLessThan(1e-6);
            expect(r.typologyType).toBe('single');
            expect(r.buildingProposal.parameters.height).toBe(21);
        }
        expect(adjustments.find(a => a.name === 'M1-11').trimmedM2).toBeGreaterThan(20);
        expect(repairBorovjeRecords(records,turf).records).toEqual(records);
    });

    it('refuses an incomplete plan or a building displaced outside its intended plot', async () => {
        const records = await fixture();
        expect(() => repairBorovjeRecords(records.slice(1),turf)).toThrow('22 distinct');
        records[5].geometry.buildings[0] = turf.transformTranslate(records[5].geometry.buildings[0],100,90,{units:'meters'});
        expect(() => repairBorovjeRecords(records,turf)).toThrow('more than 10%');
    });
});
