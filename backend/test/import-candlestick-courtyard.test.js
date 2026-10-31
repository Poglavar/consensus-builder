// The Candlestick courtyard importer's conversion: UTM 10N footprints become WGS84 building features
// with the model's heights; two-part footprints survive as MultiPolygons; artefacts are dropped
// and reported rather than silently kept or lost. The features become one building design per block of
// the concept, published as one plan through lib/restatement-publish.mjs.
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    AUTHOR, AUTHORED_AT, PLAN_KEY, PLAN_TITLE, buildDesigns, buildingHeightM, convertBuildings, courtyardPlan, footprintToWgs84
} from '../scripts/import-candlestick-courtyard.mjs';
import { PARCEL_SOURCE_ID } from '../scripts/lib/candlestick-common.mjs';
import { planObjects } from '../scripts/lib/restatement-publish.mjs';

// A small square near the tower centre of the published model (UTM 10N metres).
const SQUARE = [[554200, 4174300], [554220, 4174300], [554220, 4174320], [554200, 4174320], [554200, 4174300]];
const plates = (...tops) => tops.map((top, index) => ({ properties: { level: index + 1, z_top_m: top } }));

describe('footprintToWgs84', () => {
    it('reprojects a polygon into longitude/latitude at Candlestick Point and closes the ring', () => {
        const out = footprintToWgs84({ type: 'Polygon', coordinates: [SQUARE] });
        expect(out.type).toBe('Polygon');
        const [lon, lat] = out.coordinates[0][0];
        expect(lon).toBeCloseTo(-122.385, 2);
        expect(lat).toBeCloseTo(37.7144, 3);
        expect(out.coordinates[0][0]).toEqual(out.coordinates[0][out.coordinates[0].length - 1]);
    });

    it('keeps every usable part of a two-part footprint and drops artefacts', () => {
        const shifted = SQUARE.map(([x, y]) => [x + 50, y]);
        expect(footprintToWgs84({ type: 'MultiPolygon', coordinates: [[SQUARE], [shifted]] }).type).toBe('MultiPolygon');
        expect(footprintToWgs84({ type: 'MultiPolygon', coordinates: [[SQUARE], [[[1, 1], [1, 1], [1, 1], [1, 1]]]] }).type).toBe('Polygon');
        expect(footprintToWgs84({ type: 'Polygon', coordinates: [[[554200, 4174300]]] })).toBeNull();
        expect(footprintToWgs84({ type: 'Point', coordinates: [554200, 4174300] })).toBeNull();
    });
});

describe('buildingHeightM', () => {
    it('takes the top of the highest floorplate, else levels times a floor height', () => {
        expect(buildingHeightM({ occupied_floorplates: plates(3.6576, 6.7056, 9.7536) })).toBe(9.75);
        expect(buildingHeightM({ source_control_properties: { levels: 5 } })).toBe(16);
        expect(buildingHeightM({})).toBeNull();
    });
});

describe('convertBuildings', () => {
    it('produces building features with the properties the map reads and counts what it dropped', () => {
        const model = { buildings: [
            { id: 'A', block_id: 'F001', footprint_area_m2: 400, footprint_utm_m: { type: 'Polygon', coordinates: [SQUARE] }, source_control_properties: { levels: 3, program: 'Mixed' }, occupied_floorplates: plates(3.6576, 6.7, 9.75) },
            { id: 'B', block_id: 'F001', footprint_area_m2: 400, footprint_utm_m: { type: 'MultiPolygon', coordinates: [[SQUARE], [SQUARE.map(([x, y]) => [x + 60, y])]] }, source_control_properties: { levels: 6 }, occupied_floorplates: plates(21.95) },
            { id: 'C', footprint_utm_m: { type: 'Polygon', coordinates: [[[1, 1]]] }, source_control_properties: { levels: 5 } },
            { id: 'D', footprint_utm_m: { type: 'Polygon', coordinates: [SQUARE] } }
        ] };
        const out = convertBuildings(model);
        expect(out.features.map(f => f.properties.id)).toEqual(['A', 'B']);
        expect(out.features[0].properties).toMatchObject({ type: 'proposedBuildingSingle', block: 'F001', name: 'Mixed', levels: 3, height: 9.75 });
        expect(out.features[1].geometry.type).toBe('MultiPolygon');
        expect(out.dropped).toEqual(['C', 'D']);
        expect(out.levelsHistogram).toEqual({ 3: 1, 6: 1 });
        expect(out.footprintM2).toBe(800);
    });
});

// A model of three buildings: two on block F001 (one of them in two parts) and one on no block.
const MODEL = { schema_version: '3.0.1', release: 'test-release', created_utc: '2026-10-05T00:00:00Z', scope: { block_count: 2 }, buildings: [
    { id: 'house/A', block_id: 'F001', footprint_area_m2: 400, footprint_utm_m: { type: 'Polygon', coordinates: [SQUARE] }, source_control_properties: { levels: 3, program: 'Mixed' }, occupied_floorplates: plates(9.75) },
    { id: 'house/B', block_id: 'F001', footprint_area_m2: 400, footprint_utm_m: { type: 'MultiPolygon', coordinates: [[SQUARE.map(([x, y]) => [x + 50, y])], [SQUARE.map(([x, y]) => [x + 100, y])]] }, source_control_properties: { levels: 5 }, occupied_floorplates: plates(16) },
    { id: 'kiosk', footprint_area_m2: 100, footprint_utm_m: { type: 'Polygon', coordinates: [SQUARE.map(([x, y]) => [x, y + 80])] }, source_control_properties: { levels: 1 } }
] };
const sha8 = text => createHash('sha256').update(text).digest('hex').slice(0, 8);

describe('buildDesigns', () => {
    it('makes one building design per block of the concept, in the model\'s order, dated by the concept', () => {
        const stats = convertBuildings(MODEL);
        const designs = buildDesigns({ model: MODEL, stats, sourceSha256: 'abc123' });
        expect(designs.map(design => design.key)).toEqual([`f001-${sha8('F001')}`, `unassigned-${sha8('unassigned')}`]);
        const [block, loose] = designs.map(design => design.record);
        expect(block).toMatchObject({ goal: 'buildings', author: AUTHOR, city: 'san_francisco', createdAt: AUTHORED_AT, title: `${PLAN_TITLE} — block F001 (3 buildings)` });
        // Each footprint is its own polygon: the two-part one is split, never reduced to its largest part.
        expect(block.geometry.buildings.map(building => building.properties.id)).toEqual(['house/A', 'house/B-part-1', 'house/B-part-2']);
        expect(block.geometry.buildings.every(building => building.geometry.type === 'Polygon')).toBe(true);
        expect(block.geometry.buildings[2].properties).toMatchObject({ height: 16, sourceFeatureId: 'house/B', sourceBlockId: 'F001' });
        expect(block.buildingProposal).toMatchObject({
            typologyType: 'single', createdFrom: 'blockify', blockName: 'Candlestick Point F001',
            parameters: { typology: 'single', rotation: 0, footprintMode: 'polygon', source: { schema: '3.0.1', release: 'test-release', sha256: 'abc123', crs: 'EPSG:26910', blockId: 'F001' } }
        });
        expect(loose.title).toBe(`${PLAN_TITLE} — block unassigned (1 building)`);
        expect(loose.buildingProposal.parameters.source.blockId).toBeNull();
        // A design names no parcels: the index derives what it takes.
        designs.forEach(design => expect(design.record).not.toHaveProperty('cadastreParcelIds'));
    });

    it('refuses a building without a stable source identity', () => {
        const stats = convertBuildings(MODEL);
        stats.features[0].properties.id = '';
        expect(() => buildDesigns({ model: MODEL, stats, sourceSha256: 'abc123' })).toThrow('stable source identity');
    });
});

describe('courtyardPlan and the command line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candlestick-courtyard-'));
    const source = path.join(dir, 'model.json');
    fs.writeFileSync(source, JSON.stringify(MODEL));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const childEnv = { ...process.env };
    // The parent test runner sets both colour controls; only script diagnostics belong on stderr.
    delete childEnv.NO_COLOR;

    it('builds the plan from the model file it names, with that file\'s hash in every design', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const plan = courtyardPlan(source);
        vi.restoreAllMocks();
        const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        expect(plan).toMatchObject({ key: PLAN_KEY, title: PLAN_TITLE, author: AUTHOR, city: 'san_francisco', parcelSourceId: PARCEL_SOURCE_ID });
        expect(plan.groundFile).toBe(fileURLToPath(new URL(`../scripts/data/candlestick/ground/${PLAN_KEY}.json`, import.meta.url)));
        expect(plan.designs.map(design => design.record.buildingProposal.parameters.source.sha256)).toEqual([sha256, sha256]);
        const objects = planObjects(plan);
        expect(objects.map(object => object.content.goal)).toEqual(['buildings', 'buildings']);
        expect(new Set(objects.map(object => object.cid)).size).toBe(2);
        expect(() => courtyardPlan(undefined)).toThrow('--source <Candlestick_FG3D_Editable_Design.json> is required');
    });

    const run = args => spawnSync(process.execPath, ['scripts/import-candlestick-courtyard.mjs', ...args], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 120_000, env: { ...childEnv, HOME: dir }
    });

    it('--dry-run prints the block designs without the network, and refuses to run without --source', () => {
        const dry = run(['--source', source, '--dry-run']);
        expect(dry.stderr).toBe('');
        expect(dry.status).toBe(0);
        expect(dry.stdout).toContain('converted 3 buildings into 2 block designs, dropped 0');
        expect(dry.stdout).toContain(`plan 1/1 ${PLAN_KEY} "${PLAN_TITLE}": 2 designs\n`);
        expect(dry.stdout).toMatch(/candlestick-courtyard 2\/2 buildings bafkrei\S+ ".* — block unassigned \(1 building\)"/);
        const missing = run(['--dry-run']);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain('--source <Candlestick_FG3D_Editable_Design.json> is required');
        expect(missing.stdout).not.toContain('bafkrei');
    }, 120_000);
});
