// Verify parser/model import provenance, upload consent and ready private image responses.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createCanvas } from 'canvas';
import * as THREE from 'three';
import { createTestPreviewLinks } from './helpers/mcp-preview-store.js';
import { createMcpAssetTools } from '../agents/mcp-assets.js';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { cidOfObject, canonicalBytes } from '../cid.js';
import { designObject } from '../agents/agreement-objects.js';
import { appTurf as turf, corridorRuntime } from '../agents/mcp-geometry.js';
import { registerMcpCompanion } from '../agents/mcp-companion.mjs';
import { resultSchemaFor } from '../agents/mcp-contracts.js';
import { markUntrusted } from '../agents/mcp-results.js';
const require = createRequire(import.meta.url);
const imports = require('../../frontend/js/corridor-import.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const modelGeometry = require('../../frontend/js/building-model-geometry.js');
const FurnitureModels = require('../../frontend/js/furniture-models.js');
const outline = { type: 'Polygon', coordinates: [[[1, 48], [1.0002, 48], [1.0002, 48.0002], [1, 48.0002], [1, 48]]] };
const osm = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 48, lon: 1 }, { type: 'node', id: 2, lat: 48, lon: 1.001 },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', lanes: '2', name: 'Imported street' } }] });
function setup(extra = {}) {
    const calls = [];
    const read = { siteOfDesign: content => content.site, request: vi.fn(async (path, _query, body) => {
        calls.push({ path, body });
        if (path === '/designs/binding') return { parcelSourceId: 'ground', binding: { coverage: 'complete', unknownM2: 0, parcels: [] } };
        if (path === '/models') return { modelUrl: '/uploads/models/imported.glb' };
        throw new Error('Unexpected request');
    }) };
    const drafts = createMcpDraftTools({ read, appOrigin: 'https://app.example', resolveDraftReference: extra.resolveDraftReference });
    return { calls, read, drafts, tools: createMcpAssetTools({ read, drafts, appOrigin: 'https://app.example', apiBase: 'https://api.example', ...extra }) };
}
// A real glTF model with one concave connected L and nonzero Y bounds, without any external IO.
function modelData(external = false) {
    const positions = new Float32Array([0,0,0, 4,0,0, 4,0,-2, 0,0,0, 4,0,-2, 0,0,-2,
        0,3,-2, 2,3,-2, 2,3,-4, 0,3,-2, 2,3,-4, 0,3,-4]);
    const binary = Buffer.from(positions.buffer);
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ byteLength: binary.length, uri: external ? 'https://private.invalid/buffer.bin' : `data:application/octet-stream;base64,${binary.toString('base64')}` }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [0,0,-4], max: [4,3,0] }] };
    return `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(json)).toString('base64')}`;
}

function glbData() {
    const json = JSON.parse(Buffer.from(modelData().split(',')[1], 'base64').toString());
    const binary = Buffer.from(json.buffers[0].uri.split(',')[1], 'base64'); delete json.buffers[0].uri;
    const text = JSON.stringify(json), jsonBytes = Buffer.from(text + ' '.repeat((4 - Buffer.byteLength(text) % 4) % 4));
    const bytes = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + binary.length);
    bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(jsonBytes.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(bytes, 20);
    bytes.writeUInt32LE(binary.length, 20 + jsonBytes.length); bytes.writeUInt32LE(0x004e4942, 24 + jsonBytes.length); binary.copy(bytes, 28 + jsonBytes.length);
    return `data:model/gltf-binary;base64,${bytes.toString('base64')}`;
}

// A GLB furniture piece: `triangles` small triangles and, optionally, one image embedded in the binary
// chunk through a buffer view (a PNG or JPEG header is all the size check reads).
function furnitureGlb({ triangles = 12, image = null } = {}) {
    const positions = new Float32Array(triangles * 9);
    for (let t = 0; t < triangles; t++) positions.set([t * 0.01, 0, 0, t * 0.01 + 0.01, 0, 0, t * 0.01, 0.5, 0.01], t * 9);
    const mesh = Buffer.from(positions.buffer), pad = buffer => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4)]);
    const binary = pad(Buffer.concat([mesh, ...(image ? [image] : [])]));
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: mesh.length }, ...(image ? [{ buffer: 0, byteOffset: mesh.length, byteLength: image.length }] : [])],
        accessors: [{ bufferView: 0, componentType: 5126, count: triangles * 3, type: 'VEC3', min: [0, 0, 0], max: [triangles * 0.01 + 0.01, 0.5, 0.01] }],
        ...(image ? { images: [{ bufferView: 1, mimeType: 'image/png' }] } : {}) };
    const jsonBytes = pad(Buffer.from(JSON.stringify(json)));
    for (let i = jsonBytes.length - 1; i >= 0 && jsonBytes[i] === 0; i--) jsonBytes[i] = 0x20;
    const bytes = Buffer.concat([Buffer.alloc(20), jsonBytes, Buffer.alloc(8), binary]);
    bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(jsonBytes.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
    bytes.writeUInt32LE(binary.length, 20 + jsonBytes.length); bytes.writeUInt32LE(0x004e4942, 24 + jsonBytes.length);
    return `data:model/gltf-binary;base64,${bytes.toString('base64')}`;
}
function pngHeader(width, height) {
    const bytes = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
    bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    return bytes;
}
function jpegHeader(width, height) {
    // SOI, an APP0 segment to skip, then SOF2 (progressive) with height before width.
    const bytes = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc2001108000000000301220002110103110100', 'hex');
    bytes.writeUInt16BE(height, 25); bytes.writeUInt16BE(width, 27);
    return bytes;
}

describe('MCP imports and ephemeral visual previews', () => {
    it('imports GeoJSON through the same building and road builders with exact canonical bytes', async () => {
        const { tools, drafts, calls } = setup();
        const args = { format: 'geojson', city: 'place', parcelSourceId: 'ground', authoredAt: '2026-01-01T00:00:00.000Z', height: 12 };
        const imported = await tools.importDesign({ ...args, data: { type: 'FeatureCollection', features: [
            { type: 'Feature', geometry: outline, properties: { name: 'Building' } },
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 48], [1.001, 48]] }, properties: { name: 'Street' } }
        ] } });
        expect(imported.designs).toHaveLength(2);
        const direct = await drafts.draftBuilding({ ...args, title: 'Building', outline, footprint: outline });
        expect(canonicalBytes(imported.designs[0].design)).toEqual(canonicalBytes(direct.design));
        expect(imported.designs.every(row => row.cid === cidOfObject(row.design) && row.previewStatus === 'private-artifact')).toBe(true);
        expect(calls.every(call => call.path === '/designs/binding')).toBe(true);
    });
    it('uses the exact OSM parser, importer and footprint generator', async () => {
        const { tools } = setup();
        const args = { format: 'osm', data: osm, city: 'place', author: 'import', parcelSourceId: 'ground', authoredAt: '2026-01-01T00:00:00.000Z' };
        const answer = await tools.importDesign(args);
        const parsed = imports.FORMATS.find(format => format.id === 'osm').parse(osm);
        const [record] = imports.recordsFromImport(parsed, { author: args.author, createdAt: args.authoredAt, source: 'osm', fallbackTitle: 'Imported road' });
        record.site = corridorRuntime.footprint.materialize(record.roadProposal.definition).polygon;
        record.city = args.city; record.roadProposal.definition = corridorRuntime.osm.toRecord(record.roadProposal.definition);
        expect(canonicalBytes(answer.designs[0].design)).toEqual(canonicalBytes(designObject(record).content));
        expect(answer.import).toMatchObject({ parser: 'app-corridor-import', count: 1 });
    });
    it('imports the existing georeferenced OpenDRIVE fixture without a second parser', async () => {
        const { tools } = setup();
        const data = readFileSync(new URL('./fixtures/opendrive/t-junction.xodr', import.meta.url), 'utf8');
        const answer = await tools.importDesign({ format: 'opendrive', data, city: 'place', parcelSourceId: 'ground' });
        expect(answer.designs).toHaveLength(3);
        expect(answer.import.placement).toBe('georeference');
        expect(answer.designs.every(row => row.design.roadProposal.definition.osm?.elements.length)).toBe(true);
    });
    it('requires exactly one import payload before fetching, binding or uploading', async () => {
        const publicFetch = vi.fn(), { tools, calls } = setup({ publicFetch });
        for (const args of [{}, { data: osm, url: 'https://source.example/network.osm' }]) {
            await expect(tools.importDesign({ format: 'osm', ...args })).rejects.toMatchObject({ code: 'import-input-required' });
        }
        for (const args of [{}, { modelData: modelData(), url: 'https://source.example/model.glb' },
            { modelData: modelData(), data: Buffer.from('bytes') }, { data: Buffer.from('bytes'), url: 'https://source.example/model.glb' }]) {
            await expect(tools.importModel({ confirmAssetUpload: true, center: [1, 48], ...args })).rejects.toMatchObject({ code: 'import-input-required' });
        }
        expect(publicFetch).not.toHaveBeenCalled(); expect(calls).toEqual([]);
    });
    it('guards remote sources and never fetches model resources embedded as external URLs', async () => {
        const publicFetch = vi.fn(async () => new Response(osm));
        const { tools, calls } = setup({ publicFetch });
        await expect(tools.importDesign({ format: 'osm', url: 'https://127.0.0.1/source' })).rejects.toMatchObject({ code: 'invalid-source-url' });
        expect(publicFetch).not.toHaveBeenCalled();
        const imported = await tools.importDesign({ format: 'osm', url: 'https://source.example/network.osm', parcelSourceId: 'ground' });
        expect(imported.designs).toHaveLength(1);
        expect(publicFetch).toHaveBeenCalledWith('https://source.example/network.osm', { redirect: 'error' });
        await expect(tools.importModel({ modelData: modelData(true), center: [1, 48], confirmAssetUpload: true })).rejects.toMatchObject({ code: 'model-external-resource' });
        expect(calls.some(call => call.path === '/models')).toBe(false);
        await expect(tools.importModel({ data: 'null', center: [1, 48], confirmAssetUpload: true })).rejects.toMatchObject({ code: 'model-data-invalid' });
    });
    it.each([['gltf', modelData], ['glb', glbData]])('requires public asset consent and uses the real concave %s mesh footprint', async (_kind, data) => {
        const { tools, calls } = setup();
        await expect(tools.importModel({ modelData: data(), center: [1, 48] })).rejects.toMatchObject({ code: 'model-upload-confirmation-required' });
        expect(calls).toEqual([]);
        const result = await tools.importModel({ modelData: data(), center: [1, 48], parcelSourceId: 'ground', fileName: 'building.gltf', confirmAssetUpload: true });
        expect(result.asset).toEqual({ modelUrl: 'https://api.example/uploads/models/imported.glb', public: true, durable: true, footprint: 'projected-model-triangles', kind: 'building' });
        expect(result.design.geometry.buildings[0].geometry.coordinates[0].length).toBeGreaterThan(5);
        expect(turf.area(turf.feature(result.design.geometry.buildings[0].geometry))).toBeCloseTo(12, 1);
        expect(result.design.geometry.buildings[0].properties).toMatchObject({ source: 'upload', height: 3, modelUrl: result.asset.modelUrl });
        expect(result.cid).toBe(cidOfObject(result.draftArtifact.design));
        expect(calls.map(call => call.path)).toEqual(['/designs/binding', '/models']);
    });
    it('attaches an uploaded model to a park whose structure polygon is the placed model footprint, editable through JSON Patch', async () => {
        const { tools, drafts, calls } = setup();
        const args = { modelData: modelData(), center: [1, 48], rotation: 30, parcelSourceId: 'ground', fileName: `${'p'.repeat(130)}.glb`, confirmAssetUpload: true, authoredAt: '2026-01-01T00:00:00.000Z' };
        const park = await tools.importModel({ ...args, kind: 'park' });
        const building = await tools.importModel(args);
        expect(park.design).toMatchObject({ goal: 'park', structureProposal: { kind: 'park', source: 'upload', modelUrl: park.asset.modelUrl, rotation: 30 } });
        expect(park.design.structureProposal.modelName).toBe('p'.repeat(120));
        expect(park.design.structureProposal.geometry).toEqual(building.design.geometry.buildings[0].geometry);
        expect(park.design.site).toEqual(park.design.structureProposal.geometry);
        expect(park.design.geometry).toBeNull();
        expect(park.asset).toMatchObject({ kind: 'park', footprint: 'projected-model-triangles' });
        expect(park.cid).toBe(cidOfObject(park.design));
        expect(calls.filter(call => call.path === '/models')).toHaveLength(2);
        await expect(tools.importModel({ ...args, kind: 'tower' })).rejects.toMatchObject({ code: 'model-kind-invalid' });
        const inspected = await drafts.inspectDesign({ design: park.design, paths: ['/structureProposal/modelUrl', '/structureProposal/modelName', '/structureProposal/rotation', '/structureProposal/source'] });
        expect(inspected.values.map(value => value.untrustedValue)).toEqual([park.asset.modelUrl, 'p'.repeat(120), 30, 'upload']);
        const edited = await drafts.editDesign({ design: park.design, expectedCid: park.cid, edits: [
            { op: 'replace', path: '/structureProposal/rotation', value: 45 }, { op: 'replace', path: '/structureProposal/modelName', value: 'Fountain' }] });
        expect(edited.design.structureProposal).toMatchObject({ rotation: 45, modelName: 'Fountain', modelUrl: park.asset.modelUrl, source: 'upload' });
    });
    it('imports GeoJSON polygons as a chosen space kind and corridor properties as OSM tags', async () => {
        const { tools, drafts } = setup();
        const args = { format: 'geojson', city: 'place', parcelSourceId: 'ground', authoredAt: '2026-01-01T00:00:00.000Z' };
        const square = await tools.importDesign({ ...args, kind: 'space', spaceKind: 'square', toleranceM: 0.5, data: { type: 'Feature', geometry: outline, properties: { name: 'Market' } } });
        const direct = await drafts.draftSpace({ ...args, spaceKind: 'square', toleranceM: 0.5, title: 'Market', outline });
        expect(canonicalBytes(square.designs[0].design)).toEqual(canonicalBytes(direct.design));
        expect(square.designs[0].design).toMatchObject({ goal: 'square', toleranceM: 0.5 });
        await expect(tools.importDesign({ ...args, kind: 'space', data: { type: 'Feature', geometry: outline, properties: {} } })).rejects.toMatchObject({ code: 'space-kind-required' });
        const line = (coordinates, properties) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties });
        const lines = [line([[1, 48], [1.001, 48]], { name: 'Main', highway: 'primary', lanes: 4, width: 20 }),
            { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[1, 48.002], [1.001, 48.002]], [[1, 48.003], [1.001, 48.003]]] }, properties: { railway: 'tram', name: 'Tram' } },
            line([[1, 48.004], [1.001, 48.004]], {})];
        const imported = await tools.importDesign({ ...args, author: 'import', data: { type: 'FeatureCollection', features: [
            ...lines, { type: 'Feature', geometry: outline, properties: { name: 'Building' } }] }, height: 12 });
        // Polygons first, then every centreline exactly as the site's GeoJSON road import records it.
        expect(imported.designs).toHaveLength(5);
        expect(imported.designs[0].design.buildingProposal).toBeTruthy();
        const parsed = imports.parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: lines }));
        const records = imports.recordsFromImport(parsed, { author: 'import', createdAt: args.authoredAt, source: 'geojson', fallbackTitle: 'Imported road' });
        expect(records).toHaveLength(4);
        records.forEach((record, index) => {
            record.site = corridorRuntime.footprint.materialize(record.roadProposal.definition).polygon;
            record.city = args.city; record.roadProposal.definition = corridorRuntime.osm.toRecord(record.roadProposal.definition);
            expect(canonicalBytes(imported.designs[index + 1].design)).toEqual(canonicalBytes(designObject(record).content));
        });
        const tags = row => row.design.roadProposal.definition.osm.elements.find(element => element.type === 'way').tags;
        expect(imported.designs[1].design.title).toBe('Main');
        expect(tags(imported.designs[1])).toMatchObject({ width: '20', lanes: '4', 'lanes:forward': '2', 'lanes:backward': '2' });
        expect(imported.designs.slice(2, 4).map(row => tags(row).railway)).toEqual(['rail', 'rail']);
        expect(imported.import).toMatchObject({ format: 'geojson', count: 5 });
    });
    it('uploads a furniture asset within the shared limits and returns only the asset, which a park then references', async () => {
        const { tools, drafts, calls } = setup();
        const result = await tools.importModel({ kind: 'furniture', modelData: furnitureGlb({ image: pngHeader(512, 256) }), fileName: 'bench.glb', confirmAssetUpload: true });
        expect(result.asset).toEqual({ modelUrl: 'https://api.example/uploads/models/imported.glb', name: 'bench.glb', public: true, durable: true, kind: 'furniture', limits: FurnitureModels.LIMITS });
        expect(result).not.toHaveProperty('design'); expect(result).not.toHaveProperty('cid');
        expect(result.next.tool).toBe('ugt_edit_design');
        expect(calls.map(call => call.path)).toEqual(['/models']);
        const contract = resultSchemaFor('ugt_import_model');
        expect(contract.safeParse(markUntrusted(result)).success).toBe(true);
        expect(contract.safeParse(markUntrusted({ ...result, asset: { ...result.asset, kind: 'park' } })).success).toBe(false);
        expect(contract.safeParse(markUntrusted({ ...result, asset: { ...result.asset, limits: undefined } })).success).toBe(false);
        const park = await drafts.draftSpace({ spaceKind: 'park', outline, parcelSourceId: 'ground', authoredAt: '2026-01-01T00:00:00.000Z' });
        const edited = await drafts.editDesign({ design: park.design, expectedCid: park.cid, edits: [
            { op: 'add', path: '/structureProposal/decorationDesign/models', value: { bench: { url: result.asset.modelUrl, name: ` ${result.asset.name} ` } } },
            { op: 'add', path: '/structureProposal/decorationDesign/lamps', value: [{ coordinate: [1.0001, 48.0001], bearing: -90 }] }] });
        expect(edited.design.structureProposal.decorationDesign).toMatchObject({ models: { bench: { url: result.asset.modelUrl, name: 'bench.glb' } },
            lamps: [{ coordinate: [1.0001, 48.0001], bearing: 270 }] });
        await expect(drafts.editDesign({ design: park.design, expectedCid: park.cid, edits: [
            { op: 'add', path: '/structureProposal/decorationDesign/models', value: { statue: { url: result.asset.modelUrl } } }] })).rejects.toMatchObject({ code: 'furniture-kind-not-allowed' });
    });
    it.each([
        ['triangles', { triangles: FurnitureModels.LIMITS.maxTriangles + 1 }, 'furniture-triangles'],
        ['PNG texture', { image: pngHeader(2048, 16) }, 'furniture-texture'],
        ['JPEG texture', { image: jpegHeader(16, 1025) }, 'furniture-texture'],
        ['unreadable texture', { image: Buffer.alloc(40) }, 'furniture-texture'],
        ['empty mesh', { triangles: 0 }, 'furniture-empty']
    ])('refuses furniture over the shared limits (%s) before any upload', async (_case, model, code) => {
        const { tools, calls } = setup();
        await expect(tools.importModel({ kind: 'furniture', modelData: furnitureGlb(model), confirmAssetUpload: true })).rejects.toMatchObject({ code });
        expect(calls).toEqual([]);
    });
    it('refuses furniture over the byte limit with the shared code', async () => {
        const parseModel = vi.fn(async () => ({ triangles: 10, textures: [], bytes: FurnitureModels.LIMITS.maxBytes + 1 }));
        const { tools, calls } = setup({ parseModel });
        await expect(tools.importModel({ kind: 'furniture', modelData: furnitureGlb(), confirmAssetUpload: true })).rejects.toMatchObject({ code: 'furniture-bytes', constraints: { max: FurnitureModels.LIMITS.maxBytes } });
        expect(parseModel.mock.lastCall[1].kind).toBe('furniture');
        expect(calls).toEqual([]);
    });
    it('declares the import kinds and authored fields in the strict tool schemas', () => {
        const schemas = new Map();
        const server = { registerTool: (name, config) => schemas.set(name, config.inputSchema), registerResource() {}, registerPrompt() {} };
        registerMcpCompanion(server, { actions: {}, handler: fn => fn, readOnly: {}, discovery: {} });
        const model = { city: 'place', modelData: modelData(), center: [1, 48], confirmAssetUpload: true };
        expect(schemas.get('ugt_import_model').parse(model).kind).toBe('building');
        expect(schemas.get('ugt_import_model').parse({ ...model, kind: 'lake' }).kind).toBe('lake');
        expect(schemas.get('ugt_import_model').safeParse({ ...model, kind: 'tower' }).success).toBe(false);
        // Furniture is placed later per decoration: no city or center; every other kind still needs both.
        expect(schemas.get('ugt_import_model').safeParse({ modelData: model.modelData, kind: 'furniture', confirmAssetUpload: true }).success).toBe(true);
        expect(schemas.get('ugt_import_model').safeParse({ modelData: model.modelData, confirmAssetUpload: true }).error.issues.map(issue => issue.path.join('.'))).toEqual(['city', 'center']);
        const design = { city: 'place', format: 'geojson', data: {} };
        expect(schemas.get('ugt_import_design').safeParse({ ...design, kind: 'space', spaceKind: 'park', description: 'Imported', author: 'agent',
            authoredAt: '2026-01-01T00:00:00.000Z', toleranceM: 0.5 }).success).toBe(true);
        for (const extra of [{ kind: 'park' }, { spaceKind: 'forest' }, { toleranceM: 5 }, { authoredAt: 'yesterday' }]) {
            expect(schemas.get('ugt_import_design').safeParse({ ...design, ...extra }).success).toBe(false);
        }
    });
    it('uses shared visible-triangle extraction with instance transforms', () => {
        const scene = new THREE.Scene(), mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial(), 1);
        mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(10, 0, 20)); scene.add(mesh);
        const box = new THREE.Box3().setFromObject(scene), triangles = modelGeometry.modelTriangles(scene, box.getCenter(new THREE.Vector3()), THREE);
        const footprint = modelGeometry.projectedFootprint(triangles, turf.union);
        const area = Math.abs(footprint.geometry.coordinates[0].slice(1).reduce((sum, point, index) => { const previous = footprint.geometry.coordinates[0][index]; return sum + previous[0] * point[1] - point[0] * previous[1]; }, 0)) / 2;
        expect(area).toBeCloseTo(8, 6);
    });
    it('renders a real PNG with the existing 2D renderer without persistent image or tile cache writes', async () => {
        const tile = createCanvas(512, 512).toBuffer('image/png'), fetchImpl = vi.fn(async () => new Response(tile));
        const { tools, drafts } = setup({ fetchImpl, tileUrl: 'https://tiles.example/{z}/{x}/{y}.png' });
        const drafted = await drafts.draftBuilding({ outline, footprint: outline, height: 12, parcelSourceId: 'ground' });
        const result = await tools.renderPreview({ design: drafted.design });
        const png = Buffer.from(result.image.data, 'base64');
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(result).toMatchObject({ ready: true, publication: 'private', provenance: { persisted: false, renderer: 'app-map-preview-2d', designCids: [drafted.cid] }, metrics: { width: 1200, height: 630, designCount: 1 } });
        expect(result.metrics.tiles.loaded).toBe(result.metrics.tiles.total);
        expect(fetchImpl).toHaveBeenCalled();
    });
    it('resolves private and published design and named-plan references before rendering exact members', async () => {
        const store = createTestPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example' });
        const render2d = vi.fn(async () => ({ buffer: createCanvas(1200, 630).toBuffer('image/png'), width: 1200, height: 630 }));
        const { tools, drafts, read } = setup({ resolveDraftReference: store.resolve, render2d });
        const content = (await drafts.draftBuilding({ outline, footprint: outline, height: 12, parcelSourceId: 'ground' })).design;
        const cid = cidOfObject(content), plan = PlanRecord.create('Private selection', [cid], { at: '48,1,17', mode: '2d', city: null });
        const planCid = cidOfObject(plan), designRef = store.create({ design: content, parcelSourceId: 'ground' });
        const planRef = store.create({ plan, designs: [content], designSources: { [cid]: 'ground' } });
        read.getDesign = vi.fn(async () => ({ cid, untrusted: { design: content }, parcelSourceId: 'ground' }));
        const request = read.request.getMockImplementation();
        read.request.mockImplementation(async (path, ...rest) => path === `/plans/${planCid}`
            ? { cid: planCid, content: plan, designs: [{ cid, content, parcelSourceId: 'ground' }] } : request(path, ...rest));
        for (const subject of [{ design: designRef.draftRef }, { design: cid }, { plan: planRef.draftRef }, { plan: planCid }]) {
            expect((await tools.renderPreview(subject)).provenance.designCids).toEqual([cid]);
            expect(render2d.mock.lastCall[0].map(row => canonicalBytes(row.content))).toEqual([canonicalBytes(content)]);
        }
        expect(read.getDesign).toHaveBeenCalledWith({ designCid: cid });
    });
    it('does not claim a ready image for partial tiles or unavailable 3D', async () => {
        const { tools, drafts } = setup({ render2d: async () => ({ buffer: Buffer.from('png'), tiles: { loaded: 1, total: 2 } }) });
        const drafted = await drafts.draftBuilding({ outline, footprint: outline, height: 12, parcelSourceId: 'ground' });
        await expect(tools.renderPreview({ design: drafted.design })).rejects.toMatchObject({ code: 'preview-not-ready' });
        await expect(tools.renderPreview({ design: drafted.design, view: '3d' })).rejects.toMatchObject({ code: 'preview-3d-unavailable' });
    });
});
