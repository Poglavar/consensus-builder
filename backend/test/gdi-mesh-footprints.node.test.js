// Explicit PostGIS integration test. TEST_DATABASE_URL selects the connection; all fixture
// tables are temporary and the transaction is rolled back, including after a failed assertion.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createZagrebProvider } from '../buildings/zagreb-3d.js';

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const actual = box(15.97644, 45.81362, 15.97652, 45.81367);
const inflated = box(15.9754363, 45.8126114, 15.9775225, 45.8146691);
const square = box(15.97649, 45.813055, 15.97696, 45.813255);
const courtyard = box(15.98, 45.813, 15.9804, 45.8134);
courtyard.coordinates.push(box(15.9801, 45.8131, 15.9803, 45.8133).coordinates[0].slice().reverse());
const wings = { type: 'MultiPolygon', coordinates: [
    box(15.981, 45.813, 15.9811, 45.8131).coordinates,
    box(15.9813, 45.813, 15.9814, 45.8131).coordinates
] };

describe('GDI mesh footprints in PostGIS', { skip: !process.env.TEST_DATABASE_URL }, () => {
    let client, provider;
    before(async () => {
        client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
        await client.connect();
        await client.query('BEGIN');
        await client.query(`
            SET LOCAL search_path = pg_temp, public;
            CREATE TEMP TABLE gdi_building_3d (object_id integer, footprint_geom geometry(MultiPolygon,3765));
            CREATE TEMP TABLE gdi_building_footprint (object_id integer, geom geometry(MultiPolygon,3765));
            CREATE TEMP TABLE gdi_building (
                object_id integer, area_m2 numeric, height_m numeric, eave_height_m numeric, survey_year integer
            );
        `);
        for (const [id, outline, source] of [[108145, actual, inflated], [2, courtyard, courtyard], [3, wings, wings]]) {
            await client.query(`INSERT INTO gdi_building_3d VALUES ($1,
                ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($2),4326),3765)))`, [id, JSON.stringify(outline)]);
            await client.query(`INSERT INTO gdi_building_footprint VALUES ($1,
                ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($2),4326),3765)))`, [id, JSON.stringify(source)]);
            await client.query('INSERT INTO gdi_building VALUES ($1, 30, 35.754, 30, 2008)', [id]);
        }
        provider = createZagrebProvider(client);
    });
    after(async () => {
        if (!client) return;
        try { await client.query('ROLLBACK'); } finally { await client.end(); }
    });

    it('keeps empty square ground out of map stock and demolition despite an inflated source rectangle', async () => {
        assert.equal((await provider.mapFootprints(square)).count, 0);
        const result = await provider.footprintsUnder([{ key: 'square', geometry: square }]);
        assert.deepEqual(result.regions.get('square'), []);
    });

    it('returns the actual building and its measured height when its outline is intersected', async () => {
        const map = await provider.mapFootprints(actual);
        assert.equal(map.count, 1);
        assert.equal(map.footprints[0].id, 108145);
        assert.equal(map.footprints[0].height_m, 35.754);
        assert.deepEqual(map.footprints[0].geometry.coordinates, [actual.coordinates]);
        const result = await provider.footprintsUnder([{ key: 'building', geometry: actual }]);
        assert.equal(result.regions.get('building').length, 1);
        assert.equal(result.regions.get('building')[0].height_m, 35.754);
        assert.deepEqual(result.regions.get('building')[0].geometry, map.footprints[0].geometry);
    });

    it('preserves courtyard holes and disconnected wings instead of filling their open ground', async () => {
        const inCourt = box(15.98015, 45.81315, 15.98025, 45.81325);
        const betweenWings = box(15.98115, 45.81301, 15.98125, 45.81309);
        for (const area of [inCourt, betweenWings]) {
            assert.equal((await provider.mapFootprints(area)).count, 0);
        }
        const result = await provider.footprintsUnder([
            { key: 'court', geometry: inCourt }, { key: 'gap', geometry: betweenWings },
            { key: 'wing', geometry: box(15.981, 45.813, 15.98105, 45.81305) }
        ]);
        assert.deepEqual(result.regions.get('court'), []);
        assert.deepEqual(result.regions.get('gap'), []);
        assert.equal(result.regions.get('wing').length, 1);
        assert.deepEqual(result.regions.get('wing')[0].geometry, wings);
        const outline = (await provider.mapFootprints(courtyard)).footprints[0].geometry;
        assert.equal(outline.coordinates[0].length, 2);
    });
});
