// Tests for restatements/vlab: the author's model as placed on the map against the author's own numbers
// (the tower's three volumes), and the designs vlab-designs.mjs builds from the committed data (each
// takes its own ground, a park or square is one connected area, the passage keeps the museum standing).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as turf from '@turf/turf';
import { AUTHOR, PLAN_DATE, vlabModel, vlabModelPlan, vlabPlan } from '../../restatements/vlab/vlab-designs.mjs';
import { planObjects } from '../scripts/lib/restatement-publish.mjs';

const georeference = JSON.parse(fs.readFileSync(new URL('../../restatements/vlab/data/georeference.json', import.meta.url), 'utf8'));
const plan = vlabPlan();
const byKey = Object.fromEntries(plan.designs.map(design => [design.key, design.record]));
const groundOf = record => record.geometry?.landTake || record.site;

describe('the vLAB model on the map', () => {
    it('is placed metrically by its landmarks', () => {
        expect(Math.abs(georeference.scale - 1)).toBeLessThan(0.01);
        expect(georeference.rmsM).toBeLessThan(10);
    });

    it('gives the tower the author\'s three volumes: 1535 / 697 / 377 m² at 18 / 30 / 66 m', () => {
        const tower = vlabModel().tower;
        const rings = tower.map(item => turf.area(item.geometry));
        // The parts are rings that never stack: each volume's footprint is its own part plus the ones above.
        const footprints = [rings[0] + rings[1] + rings[2], rings[1] + rings[2], rings[2]];
        [1535, 697, 377].forEach((stated, index) => expect(Math.abs(footprints[index] - stated) / stated).toBeLessThan(0.03));
        tower.forEach((item, index) => expect(Math.abs(item.properties.heightM - [18, 30, 66][index])).toBeLessThanOrEqual(1));
    });
});

describe('vlabPlan', () => {
    it('restates the building, the tower, the passage, the Cibona link, the park, the plaza and the square', () => {
        expect(plan.designs.map(design => design.key)).toEqual(['zgrada-vlab', 'toranj', 'prolaz', 'veza-cibona', 'park-1', 'park-2', 'plaza-muzeja', 'trg-1', 'trg-2']);
        plan.designs.forEach(({ record }) => {
            expect(record.author).toBe(AUTHOR);
            expect(record.createdAt).toBe(PLAN_DATE);
        });
    });

    it('steps the vLAB building up to 32 m and gives the tower office below and housing above', () => {
        const heights = byKey['zgrada-vlab'].geometry.buildings.map(building => building.properties.height);
        expect(Math.max(...heights)).toBe(32);
        expect(byKey.toranj.geometry.buildings.map(building => building.properties.use)).toEqual(['office', 'residential', 'residential']);
        expect(byKey.toranj.geometry.buildings.map(building => building.properties.floors)).toEqual([4, 7, 17]);
    });

    it('glazes both buildings, each with its own curtain wall', () => {
        expect(new Set(byKey['zgrada-vlab'].geometry.buildings.map(building => building.properties.facade))).toEqual(new Set(['glass-large']));
        expect(new Set(byKey.toranj.geometry.buildings.map(building => building.properties.facade))).toEqual(new Set(['glass-medium']));
    });

    it('lets no two designs take the same ground', () => {
        const grounds = plan.designs.map(design => turf.feature(groundOf(design.record)));
        for (let i = 0; i < grounds.length; i += 1) {
            for (let j = i + 1; j < grounds.length; j += 1) {
                const shared = turf.intersect(grounds[i], grounds[j]);
                expect(shared ? turf.area(shared) : 0, `${plan.designs[i].key} × ${plan.designs[j].key}`).toBeLessThan(0.01);
            }
        }
    });

    it('makes every park and square one connected area, clear of the buildings the plan keeps', () => {
        const kept = vlabModel().kept;
        plan.designs.filter(({ record }) => ['park', 'square'].includes(record.goal)).forEach(({ key, record }) => {
            expect(record.site.type, key).toBe('Polygon');
            kept.forEach(building => {
                const shared = turf.intersect(turf.feature(record.site), building);
                expect(shared ? turf.area(shared) : 0, `${key} × ${building.properties.objectId}`).toBeLessThan(0.01);
            });
        });
    });

    it('passes under the museum as a building tunnel and lifts the Cibona link onto its bridge', () => {
        const passage = byKey.prolaz.roadProposal.definition;
        expect(passage.tunnels).toHaveLength(1);
        expect(passage.tunnels[0].kind).toBe('building');
        const link = byKey['veza-cibona'].roadProposal.definition.points[0];
        expect(link[0].level ?? 0).toBe(0);
        expect(link.slice(1).every(point => point.level === 1)).toBe(true);
    });

    it("stands the author's model georeferenced on the vLAB footprint in the local variant, leaving the other designs as they are", () => {
        const authorModel = { modelUrl: '/uploads/models/vlab-building.glb', modelOrigin: [15.96588918, 45.804626982], rotation: 100.3163 };
        const variant = vlabModelPlan(authorModel);
        const building = variant.designs.find(design => design.key === 'zgrada-vlab-model').record.geometry.buildings;
        expect(building).toHaveLength(1);
        expect(building[0].properties).toMatchObject({ source: 'upload', modelUrl: authorModel.modelUrl, modelOrigin: authorModel.modelOrigin, rotation: authorModel.rotation, height: 32, floors: 7 });
        const footprint = turf.area(building[0].geometry), parts = byKey['zgrada-vlab'].geometry.buildings.reduce((sum, part) => sum + turf.area(part.geometry), 0);
        expect(Math.abs(footprint - parts)).toBeLessThan(1);
        expect(variant.designs.map(design => design.key)).toEqual(plan.designs.map(design => (design.key === 'zgrada-vlab' ? 'zgrada-vlab-model' : design.key)));
        expect(planObjects(variant)).toHaveLength(plan.designs.length);
    });

    it('builds valid design/v1 objects under the publication limit', () => {
        const objects = planObjects(plan);
        expect(objects).toHaveLength(plan.designs.length);
        expect(new Set(objects.map(object => object.cid)).size).toBe(objects.length);
    });
});
