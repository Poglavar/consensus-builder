// The CityJSON export of a plan file (frontend/js/city-json-export.js): buildings come back through
// the site's own CityJSON reader with their footprint and height, faces point outward, every design is
// a group with its CID, a park is plant cover, surroundings keep their treatment, and the plan file
// rides along unchanged and reads back.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import proj4 from 'proj4';

const require = createRequire(import.meta.url);
const PlanFile = require('../../frontend/js/plan-file.js');
const Export = require('../../frontend/js/city-json-export.js');
const Reader = require('../../frontend/js/city-model-reader.js');

const box = (x = 15, y = 45, d = 0.001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const courtyard = { type: 'Polygon', coordinates: [box(15.002, 45, 0.0004).coordinates[0],
    [[15.00215, 45.00015], [15.00215, 45.00025], [15.00225, 45.00025], [15.00225, 45.00015], [15.00215, 45.00015]]] };
const view = { at: '45,15,17', mode: 'model', city: 'zagreb', language: 'hr', camera: { targetLat: 45, targetLng: 15, headingDeg: 20, pitchRad: -.5, range: 300 } };
const building = { proposalId: 'b', goal: 'single', title: 'Courtyard house', site: box(15.002, 45, 0.0004), city: 'zagreb', author: 'A', createdAt: '2026-10-25T10:00:00.000Z',
    buildingProposal: { floors: 4 }, geometry: { buildings: [{ type: 'Feature', geometry: courtyard, properties: { floors: 4, height: 12, use: 'residential' } }],
        surroundings: { treatment: 'green', polygon: box(15.0024, 45, 0.0002) } } };
const park = { proposalId: 'p', goal: 'park', title: 'Šuma', site: box(), city: 'zagreb', author: 'A', createdAt: '2026-10-25T10:00:00.000Z',
    structureProposal: { kind: 'park', geometry: box(), decorationDesign: { trees: [] } } };
const newell = (ring, vertices, transform) => {
    const p = ring.map(i => vertices[i].map((v, k) => v * transform.scale[k]));
    const n = [0, 0, 0];
    p.forEach((a, i) => { const b = p[(i + 1) % p.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); });
    return n;
};

describe('CityJSON export of a plan file', async () => {
    const file = await PlanFile.create([building, park], { title: 'River plan', view });
    const doc = Export.fromPlanFile(file, { proj4 });

    it('is CityJSON 2.0 in the plan’s UTM zone with integer vertices', () => {
        expect(doc).toMatchObject({ type: 'CityJSON', version: '2.0', metadata: { referenceSystem: 'https://www.opengis.net/def/crs/EPSG/0/32633', title: 'River plan' } });
        expect(doc.vertices.every(v => v.every(Number.isInteger))).toBe(true);
    });

    it('reads back through the site’s reader as the same footprint, courtyard and height', () => {
        const model = Reader.readCityModel(JSON.stringify(doc));
        expect(model.format).toBe('cityjson');
        expect(model.buildings).toHaveLength(1);
        const transform = proj4(model.crs.definition, 'EPSG:4326');
        const [feature] = Reader.footprintFeatures(model, { toLngLat: (x, y) => transform.forward([x, y]), turf }).features;
        expect(feature.properties.height).toBe(12);
        expect(feature.geometry.coordinates).toHaveLength(2);
        expect(turf.area(feature) / turf.area(courtyard)).toBeCloseTo(1, 3);
        expect(model.buildings[0]).toMatchObject({ storeysAboveGround: 4, function: 'residential' });
    });

    it('points roofs up, grounds down and walls out', () => {
        const [id] = Object.entries(doc.CityObjects).find(([, o]) => o.type === 'Building');
        const geometry = doc.CityObjects[id].geometry[0];
        const kinds = geometry.semantics.surfaces.map(s => s.type);
        const centre = [0, 1].map(k => geometry.boundaries.flat(2).reduce((sum, i) => sum + doc.vertices[i][k], 0) / geometry.boundaries.flat(2).length * doc.transform.scale[k]);
        geometry.boundaries.forEach((surface, s) => {
            const n = newell(surface[0], doc.vertices, doc.transform), kind = kinds[geometry.semantics.values[s]];
            if (kind === 'RoofSurface') expect(n[2]).toBeGreaterThan(0);
            if (kind === 'GroundSurface') expect(n[2]).toBeLessThan(0);
            if (kind === 'WallSurface') {
                const at = [0, 1].map(k => surface[0].reduce((sum, i) => sum + doc.vertices[i][k], 0) / surface[0].length * doc.transform.scale[k]);
                const outward = (at[0] - centre[0]) * n[0] + (at[1] - centre[1]) * n[1];
                // Courtyard walls face the courtyard (towards the centre); outer walls face away from it.
                const inCourtyard = Math.hypot(at[0] - centre[0], at[1] - centre[1]) < 6;
                expect(inCourtyard ? outward < 0 : outward > 0).toBe(true);
            }
        });
    });

    it('groups each design with its CID, makes the park plant cover, keeps green surroundings, and carries the plan file', () => {
        const groups = Object.entries(doc.CityObjects).filter(([, o]) => o.type === 'CityObjectGroup');
        expect(groups.map(([id]) => id).sort()).toEqual([...file.designs.map(row => row.cid), Export.PLAN_GROUP].sort());
        const parkCid = file.designs.find(row => row.content.goal === 'park').cid;
        expect(doc.CityObjects[parkCid].children.map(id => doc.CityObjects[id].type)).toEqual(['PlantCover']);
        const around = Object.values(doc.CityObjects).find(o => o.attributes?.ugtDesignGoal === 'single' && o.type === 'PlantCover');
        expect(around.attributes.function).toBe('green');
        expect(doc.CityObjects[Export.PLAN_GROUP].attributes.ugtPlanFile).toEqual(file);
        expect(PlanFile.parse(JSON.stringify(doc.CityObjects[Export.PLAN_GROUP].attributes.ugtPlanFile))).toEqual(file);
    });

    it('reads back as its plan file, says when its city objects were edited, and is null for other files', () => {
        expect(Export.readBack(JSON.stringify(doc) + '\n', { proj4 })).toEqual({ file, edited: false });
        const moved = structuredClone(doc); moved.vertices[0][0] += 500;
        expect(Export.readBack(JSON.stringify(moved), { proj4 })).toEqual({ file, edited: true });
        const tampered = structuredClone(doc); tampered.CityObjects[Export.PLAN_GROUP].attributes.ugtPlanFile.designs[0].content.title = 'Tampered';
        expect(() => Export.readBack(JSON.stringify(tampered), { proj4 })).toThrow(/CID/);
        const foreign = structuredClone(doc); delete foreign.CityObjects[Export.PLAN_GROUP];
        expect(Export.readBack(JSON.stringify(foreign), { proj4 })).toBeNull();
        expect(Export.readBack(PlanFile.stringify(file), { proj4 })).toBeNull();
        expect(Export.readBack('<CityModel/>', { proj4 })).toBeNull();
    });
});
