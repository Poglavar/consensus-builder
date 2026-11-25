// IFC building import (frontend/js/ifc-model-reader.js) with the backend's web-ifc: the GLB it makes,
// which elements it keeps, and where the file says the building stands.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import proj4 from 'proj4';

const require = createRequire(import.meta.url);
const webIfc = require('web-ifc');
const reader = require('../../frontend/js/ifc-model-reader.js');
const modelGeometry = require('../../frontend/js/building-model-geometry.js');
const fixture = new Uint8Array(readFileSync(new URL('../../test-assets/test-building.ifc', import.meta.url)));

async function sceneOf(glb) {
    const parsed = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
    return parsed.scene;
}

describe('IFC building import', () => {
    it('makes a GLB of the building in metres, without the tree standing outside it', async () => {
        const out = await reader.ifcBuildingGlb(fixture, { webIfc, proj4 });
        const scene = await sceneOf(out.glb);
        const box = new THREE.Box3().setFromObject(scene);
        // Millimetre walls, slabs and a door: 12 m by 8 m from −0.3 m to the roof top at 6.3 m. The tree
        // 20 m east would make it 20.5 m wide.
        expect(modelGeometry.dimensionsFromBounds(box)).toEqual({ width: 12, length: 8, height: 6.6 });
        expect(out.heightM).toBe(6.6);
        expect(out.triangles).toBe(7 * 12);
        expect(out.leftOut).toEqual([]);
        // Centred on its plan, standing on y = 0, as the upload dialog expects.
        expect(box.min.y).toBeCloseTo(0, 6);
        expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
        const footprint = modelGeometry.projectedFootprint(modelGeometry.modelTriangles(scene, box.getCenter(new THREE.Vector3()), THREE));
        expect(footprint.geometry.coordinates).toHaveLength(1);
        const ring = footprint.geometry.coordinates[0];
        const area = Math.abs(ring.slice(1).reduce((sum, point, index) => sum + ring[index][0] * point[1] - point[0] * ring[index][1], 0)) / 2;
        expect(area).toBeCloseTo(96, 3);
    });

    it('places the building by its map conversion, not the template site location', async () => {
        const { placement } = await reader.ifcBuildingGlb(fixture, { webIfc, proj4 });
        // The plan centre (6 m, 4 m) turned 30° and moved to the conversion's UTM 43N origin.
        const a = Math.cos(Math.PI / 6), b = Math.sin(Math.PI / 6);
        const utm = proj4('+proj=utm +zone=43 +datum=WGS84 +units=m +no_defs', 'EPSG:4326');
        const [lng, lat] = utm.forward([663182.321 + a * 6 - b * 4, 4830777.861 + b * 6 + a * 4]);
        expect(placement.source).toBe('map-conversion');
        expect(placement.center.lng).toBeCloseTo(lng, 7);
        expect(placement.center.lat).toBeCloseTo(lat, 7);
        // 30° from grid east, less the grid's convergence at Alatau (about 1.5°), measured in a local
        // transverse Mercator at the building.
        const local = proj4('EPSG:4326', `+proj=tmerc +lat_0=${lat} +lon_0=${lng} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`);
        const [east, north] = local.forward(utm.forward([663182.321 + a * 6 - b * 4 + 100 * a, 4830777.861 + b * 6 + a * 4 + 100 * b]));
        expect(placement.rotationDeg).toBeCloseTo(Math.atan2(north, east) * 180 / Math.PI, 2);
        expect(placement.rotationDeg).toBeGreaterThan(28);
        expect(placement.rotationDeg).toBeLessThan(30);
    });

    it('reads a site reference with true north when the file has no map conversion', () => {
        const site = { lat: 49.1, lng: 8.43, origin: [10, 0], trueNorth: [1, 0] };
        // True north along model +x: the model's x axis points north, and 5 m along it is 5 m north.
        const at = reader.siteReferencePlacement(site, [15, 0], { proj4 });
        expect(at.source).toBe('site-reference');
        expect(at.rotationDeg).toBeCloseTo(90, 3);
        expect((at.center.lat - 49.1) * 111200).toBeCloseTo(5, 1);
        expect(at.center.lng).toBeCloseTo(8.43, 7);
        expect(reader.siteReferencePlacement({ ...site, trueNorth: null }, [10, 0], { proj4 }).rotationDeg).toBeCloseTo(0, 3);
        expect(reader.compoundAngle([41, 52, 27, 840000])).toBeCloseTo(41 + 52 / 60 + 27.84 / 3600, 9);
        expect(reader.compoundAngle([-87, -38, -21, -839999])).toBeCloseTo(-(87 + 38 / 60 + 21.839999 / 3600), 9);
    });

    it('keeps the envelope and leaves out whole kinds of detail, heaviest first, to fit the limits', () => {
        const element = (category, triangles, min = [0, 0, 0], max = [10, 10, 10]) =>
            ({ category, triangles, vertices: triangles, min, max, colours: new Map() });
        const walls = element('IFCWALL', 100), doors = element('IFCDOOR', 50), railings = element('IFCRAILING', 300);
        const car = element('IFCBUILDINGELEMENTPROXY', 5, [30, 0, 30], [34, 2, 32]);
        const picked = reader.selectElements([walls, doors, railings, car], { maxTriangles: 200, maxBytes: Infinity });
        expect(picked.selected).toEqual([walls, doors]);
        expect(picked.leftOut).toEqual([{ category: 'IFCRAILING', triangles: 300 }]);
        expect(picked.triangles).toBe(150);
        expect(() => reader.selectElements([walls], { maxTriangles: 99, maxBytes: Infinity }))
            .toThrow(expect.objectContaining({ code: 'complex' }));
        // A model of generic objects only is all envelope.
        expect(reader.selectElements([car], { maxTriangles: 200, maxBytes: Infinity }).selected).toEqual([car]);
    });

    it('recognises IFC files and refuses ones without building geometry', async () => {
        expect(reader.looksLikeIfc(new TextDecoder().decode(fixture.subarray(0, 4000)))).toBe(true);
        expect(reader.looksLikeIfc('ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\'AP214\'));')).toBe(false);
        expect(reader.looksLikeIfc('glTF')).toBe(false);
        const noBuilding = new TextEncoder().encode(new TextDecoder().decode(fixture)
            .replace(/^#(1[0-7]\d)=IFC(WALL|SLAB|DOOR|BUILDINGELEMENTPROXY)\(.*$/gm, ''));
        await expect(reader.ifcBuildingGlb(noBuilding, { webIfc, proj4 })).rejects.toMatchObject({ code: 'empty' });
        await expect(reader.ifcBuildingGlb(new TextEncoder().encode('not an ifc file'), { webIfc, proj4 }))
            .rejects.toMatchObject({ code: 'ifc-unreadable' });
        await expect(reader.ifcBuildingGlb(new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL(;\n"), { webIfc, proj4 }))
            .rejects.toMatchObject({ code: expect.stringMatching(/^(ifc-unreadable|empty)$/) });
        // The converter still works after a file it could not read.
        expect((await reader.ifcBuildingGlb(fixture, { webIfc, proj4 })).triangles).toBe(84);
    });

    it('pins the same web-ifc version in the browser and the backend', () => {
        const backend = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        expect(backend.dependencies['web-ifc']).toBe(reader.WEB_IFC_VERSION);
        const installed = new URL('package.json', `file://${require.resolve('web-ifc')}`);
        expect(JSON.parse(readFileSync(installed, 'utf8')).version).toBe(reader.WEB_IFC_VERSION);
    });
});
