// MCP parity for CityGML and CityJSON: ugt_import_design reads their buildings as the building editors'
// footprint import does (same footprints, same draft bytes), and ugt_import_model turns one building
// into the same GLB as the site's upload, standing where its file puts it.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import proj4 from 'proj4';
import { createMcpAssetTools } from '../agents/mcp-assets.js';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { canonicalBytes } from '../cid.js';
import { appTurf as turf } from '../agents/mcp-geometry.js';
import { parseCityGml } from '../buildings/citygml.js';

const require = createRequire(import.meta.url);
const Reader = require('../../frontend/js/city-model-reader.js');
const viennaGml = readFileSync(new URL('./fixtures/wien-lod2-096076.gml', import.meta.url), 'utf8');

function setup() {
    const uploads = [];
    const read = { siteOfDesign: content => content.site, request: vi.fn(async (path, _query, body) => {
        if (path === '/designs/binding') return { parcelSourceId: 'ground', binding: { coverage: 'complete', unknownM2: 0, parcels: [] } };
        if (path === '/models') { uploads.push(body); return { modelUrl: '/uploads/models/imported.glb' }; }
        throw new Error(`Unexpected request ${path}`);
    }) };
    const drafts = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
    return { uploads, drafts, tools: createMcpAssetTools({ read, drafts, appOrigin: 'https://app.example', apiBase: 'https://api.example' }) };
}

// One 12 m building in EPSG:3765 (Zagreb), as the browser test uploads it.
const ring = [[459733.799, 5073490.275], [459761.005, 5073490.099], [459761.149, 5073512.326], [459733.943, 5073512.502]];
const posList = z => [...ring, ring[0]].map(([x, y]) => `${x} ${y} ${z}`).join(' ');
const surface = (kind, z) => `<bldg:boundedBy><bldg:${kind}><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
  <gml:posList srsDimension="3">${posList(z)}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:${kind}></bldg:boundedBy>`;
const oneBuilding = (srs = 'EPSG:3765') => `<?xml version="1.0"?><core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:gml="http://www.opengis.net/gml">
<gml:boundedBy><gml:Envelope srsName="${srs}" srsDimension="3"><gml:lowerCorner>0 0 0</gml:lowerCorner><gml:upperCorner>1 1 1</gml:upperCorner></gml:Envelope></gml:boundedBy>
<core:cityObjectMember><bldg:Building gml:id="b1"><bldg:measuredHeight uom="m">12</bldg:measuredHeight>${surface('GroundSurface', 120)}${surface('RoofSurface', 132)}</bldg:Building></core:cityObjectMember></core:CityModel>`;
const dataUrl = (text, type = 'application/gml+xml') => `data:${type};base64,${Buffer.from(text).toString('base64')}`;

describe('ugt_import_design with CityGML and CityJSON', () => {
    it('drafts one building per CityGML building, byte-identical to drafting the reader’s footprint', async () => {
        const { tools, drafts } = setup();
        const args = { format: 'citygml', city: 'vienna', parcelSourceId: 'ground', authoredAt: '2026-01-01T00:00:00.000Z' };
        const imported = await tools.importDesign({ ...args, data: viennaGml });
        expect(imported.designs).toHaveLength(2);
        const model = Reader.readCityModel(viennaGml, { parseGml: parseCityGml });
        const transform = proj4(model.crs.definition, 'EPSG:4326');
        const [first] = Reader.footprintFeatures(model, { toLngLat: (x, y) => transform.forward([x, y]), turf }).features;
        const direct = await drafts.draftBuilding({ ...args, title: first.properties.name, outline: first.geometry, footprint: first.geometry, height: first.properties.height });
        expect(canonicalBytes(imported.designs[0].design)).toEqual(canonicalBytes(direct.design));
        expect(imported.import).toMatchObject({ format: 'citygml', count: 2 });
    });

    it('refuses CityJSON data under the citygml format, and names an unknown coordinate system', async () => {
        const { tools } = setup();
        const args = { city: 'vienna', parcelSourceId: 'ground' };
        await expect(tools.importDesign({ ...args, format: 'cityjson', data: viennaGml })).rejects.toMatchObject({ code: 'import-city-model-invalid' });
        await expect(tools.importDesign({ ...args, format: 'citygml', data: viennaGml.replace(/EPSG::31256/g, 'EPSG::5514') }))
            .rejects.toMatchObject({ code: 'import-crs-unsupported', message: expect.stringContaining('EPSG:5514') });
    });
});

describe('ugt_import_model with a CityGML building', () => {
    it('uploads a GLB and places the building where its file puts it, without a center', async () => {
        const { tools, uploads } = setup();
        const result = await tools.importModel({ city: 'zagreb', parcelSourceId: 'ground', confirmAssetUpload: true, fileName: 'building.gml', modelData: dataUrl(oneBuilding()) });
        expect(uploads).toHaveLength(1);
        expect(Buffer.from(uploads[0].modelData.split(',')[1], 'base64').subarray(0, 4).toString()).toBe('glTF');
        expect(result.asset).toMatchObject({ convertedFrom: 'citygml' });
        expect(result.asset.center[0]).toBeCloseTo(15.98218, 4);
        expect(result.asset.center[1]).toBeCloseTo(45.8002, 4);
        const building = result.design.geometry.buildings[0];
        expect(building.properties).toMatchObject({ modelUrl: 'https://api.example/uploads/models/imported.glb', source: 'upload' });
        const lngs = building.geometry.coordinates[0].map(p => p[0]), lats = building.geometry.coordinates[0].map(p => p[1]);
        expect(Math.min(...lngs)).toBeCloseTo(15.9820, 4); expect(Math.max(...lngs)).toBeCloseTo(15.98235, 4);
        expect(Math.min(...lats)).toBeCloseTo(45.8001, 4); expect(Math.max(...lats)).toBeCloseTo(45.8003, 4);
    });

    it('still needs a center for a glTF model', async () => {
        const { tools } = setup();
        const [building] = parseCityGml(oneBuilding());
        const glb = Reader.buildingGlb(building, { toLngLat: (x, y) => [x / 1e5, y / 1e5], triangulate: () => [[0, 1, 2], [0, 2, 3]] }).glb;
        await expect(tools.importModel({ city: 'zagreb', confirmAssetUpload: true, modelData: `data:model/gltf-binary;base64,${Buffer.from(glb).toString('base64')}` }))
            .rejects.toMatchObject({ code: 'model-center-required' });
    });

    it('refuses a file with several buildings, pointing to the footprint import', async () => {
        const { tools, uploads } = setup();
        await expect(tools.importModel({ city: 'vienna', confirmAssetUpload: true, modelData: dataUrl(viennaGml) }))
            .rejects.toMatchObject({ code: 'model-buildings-count', message: expect.stringContaining('ugt_import_design') });
        expect(uploads).toHaveLength(0);
    });
});
