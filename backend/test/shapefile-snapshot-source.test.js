// Headless contract tests for bounded archives, native identities and full source geometry.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import proj4 from 'proj4';
import { createShapefileSnapshotParcelSource } from '../parcels/shapefile-snapshot-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { SHAPEFILE_CRS, readShapefileZipMembers, indexShapefileSnapshot } from '../parcels/shapefile-zip-reader.js';

const wkt = crs => crs === 'EPSG:6677'
    ? 'PROJCS["JGD_2011_Japan_Zone_9",GEOGCS["GCS_JGD_2011",DATUM["D_JGD_2011",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",139.8333333333333],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",36],UNIT["Meter",1]]'
    : 'PROJCS["RGF_1993_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",700000],PARAMETER["False_Northing",6600000],PARAMETER["Central_Meridian",3],PARAMETER["Standard_Parallel_1",44],PARAMETER["Standard_Parallel_2",49],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1]]';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const square = (x, y, size = 10) => [[x, y], [x, y + size], [x + size, y + size], [x + size, y], [x, y]];
function fixture({ values = ['340172   BV0156', '340172   BV0151'], type = 'C', crs = 'EPSG:2154', rings, mutate } = {}) {
    const start = crs === 'EPSG:2154' ? [770000, 6280000] : [-70000, 40000];
    const records = values.map((_, i) => rings || [square(start[0] + i * 30, start[1])]);
    const shapes = records.map(parts => {
        const points = parts.flat(), buffer = Buffer.alloc(44 + 4 * parts.length + 16 * points.length);
        buffer.writeUInt32LE(5); buffer.writeUInt32LE(parts.length, 36); buffer.writeUInt32LE(points.length, 40);
        const bounds = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
        bounds.forEach((n, j) => buffer.writeDoubleLE(n, 4 + j * 8)); let index = 0;
        parts.forEach((ring, j) => { buffer.writeUInt32LE(index, 44 + j * 4); index += ring.length; });
        points.forEach((p, j) => { buffer.writeDoubleLE(p[0], 44 + parts.length * 4 + j * 16); buffer.writeDoubleLE(p[1], 52 + parts.length * 4 + j * 16); });
        return buffer;
    });
    function header(size) { const b = Buffer.alloc(size); b.writeUInt32BE(9994); b.writeUInt32BE(size / 2, 24); b.writeUInt32LE(1000, 28); b.writeUInt32LE(5, 32); return b; }
    const shp = header(100 + shapes.reduce((sum, b) => sum + b.length + 8, 0)), shx = header(100 + values.length * 8); let pos = 100;
    shapes.forEach((buffer, i) => { shx.writeUInt32BE(pos / 2, 100 + i * 8); shx.writeUInt32BE(buffer.length / 2, 104 + i * 8); shp.writeUInt32BE(i + 1, pos); shp.writeUInt32BE(buffer.length / 2, pos + 4); buffer.copy(shp, pos + 8); pos += 8 + buffer.length; });
    // Deliberately invalid UTF8 bytes in an owner column prove those cells are never decoded.
    const width = type === 'I' ? 4 : 24, dbf = Buffer.alloc(97 + values.length * (1 + width + 4) + 1, 32);
    dbf.fill(0, 0, 97); dbf[0] = 3; dbf.writeUInt32LE(values.length, 4); dbf.writeUInt16LE(97, 8); dbf.writeUInt16LE(1 + width + 4, 10);
    dbf.write('Codeident', 32); dbf[43] = type.charCodeAt(0); dbf[48] = width;
    dbf.write('OWNER', 64); dbf[75] = 67; dbf[80] = 4; dbf[96] = 13;
    values.forEach((value, i) => { const offset = 97 + i * (1 + width + 4);
        if (type === 'I') dbf.writeInt32LE(Number(value), offset + 1); else dbf.write(value, offset + 1);
        dbf.fill(255, offset + 1 + width, offset + 1 + width + 4); }); dbf[dbf.length - 1] = 26;
    const files = { shp, shx, dbf, prj: strToU8(wkt(crs)), cpg: strToU8('UTF-8') }; mutate?.(files);
    const entries = Object.fromEntries(Object.entries(files).map(([ext, bytes]) => [`parcel.${ext}`, bytes]));
    const bytes = zipSync(entries);
    const descriptor = { id: 'test-parcels', adapter: 'shapefile-snapshot', endpoint: 'https://publisher.example/parcels.zip',
        idPrefix: 'TEST-', idField: 'Codeident', idFields: ['Codeident'], outFields: ['Codeident'], sourceCrs: crs,
        expectedSnapshotSha256: hash(bytes), expectedSnapshotFeatures: values.length,
        shapefileMembers: Object.fromEntries(Object.keys(files).map(ext => [ext, `parcel.${ext}`])),
        maxSnapshotBytes: 100000, maxDecompressedBytes: 100000, maxSnapshotFeatures: 10, maxFeatures: 10, zipEncoding: 'utf-8', dbfEncoding: 'utf-8' };
    return { bytes, descriptor, files, start };
}
function source(f, overrides = {}, options = {}) {
    let calls = 0;
    const adapter = createShapefileSnapshotParcelSource({ ...f.descriptor, ...overrides }, {
        fetchImpl: async () => { calls++; return new Response(f.bytes, { headers: { 'content-length': String(f.bytes.length) } }); }, ...options
    });
    return { adapter, calls: () => calls };
}
const gateway = error => error.status === 502 && error.code === 'parcel-source-unavailable';

test('exact identities preserve interior spaces, leading zero strings, absence, privacy and isolation', async () => {
    const f = fixture({ values: ['340172   BV0156', '0001'] }), s = source(f);
    const r = await s.adapter.queryIds(['TEST-340172%20%20%20BV0156', 'TEST-0001', 'TEST-missing', 'TEST-0001']);
    assert.equal(r.complete, true); assert.equal(r.returnsWGS84, true); assert.deepEqual(r.absentIds, ['TEST-missing']); assert.equal(r.features.length, 2);
    assert.deepEqual(r.features[0].properties.sourceProperties, { Codeident: '340172   BV0156' });
    r.features[0].geometry.coordinates[0][0][0] = 0;
    assert.notEqual((await s.adapter.queryIds(['TEST-340172%20%20%20BV0156'])).features[0].geometry.coordinates[0][0][0], 0);
    assert.equal(s.calls(), 1);
});
for (const crs of ['EPSG:6677', 'EPSG:2154']) test(`${crs} reprojection, bbox and geometry return unchanged full rings`, async () => {
    const f = fixture({ crs }), s = source(f), expected = proj4(SHAPEFILE_CRS[crs], 'EPSG:4326', f.start);
    const id = 'TEST-340172%20%20%20BV0156', r = await s.adapter.queryIds([id]), point = r.features[0].geometry.coordinates[0][0];
    assert.ok(Math.abs(point[0] - expected[0]) < 1e-10 && Math.abs(point[1] - expected[1]) < 1e-10);
    // Independent PROJ/EPSG database controls, with longitude-first axis order.
    const control = crs === 'EPSG:6677' ? [139.05335688700848, 36.35797288317134] : [3.866920790051422, 43.615592332192406];
    assert.ok(point.every((n, i) => Math.abs(n - control[i]) < 1e-8));
    const bounds = [point[0] - 0.00001, point[1] - 0.00001, point[0] + 0.00001, point[1] + 0.00001];
    assert.deepEqual((await s.adapter.queryBounds(bounds)).features[0].geometry, r.features[0].geometry);
    assert.equal((await s.adapter.queryGeometry(r.features[0].geometry)).features[0].id, id);
    assert.equal((await s.adapter.queryBounds([0, 0, 0.001, 0.001])).features.length, 0);
});
test('disconnected shells and holes are grouped without reversal, repair or dropping vertices', async () => {
    const shell = square(770000, 6280000, 20), hole = square(770005, 6280005, 5).reverse(), island = square(770030, 6280000);
    const s = source(fixture({ values: ['one'], rings: [hole, island, shell] }));
    const geometry = (await s.adapter.queryIds(['TEST-one'])).features[0].geometry;
    assert.equal(geometry.type, 'MultiPolygon'); assert.deepEqual(geometry.coordinates.map(p => p.length), [1, 2]);
    assert.equal(geometry.coordinates.flat().reduce((n, ring) => n + ring.length, 0), 15);
});
test('integer numeric DBF identities encode exactly and reject unsafe values', async () => {
    const s = source(fixture({ values: ['299414'], type: 'N', crs: 'EPSG:6677' }), { idType: 'integer' });
    assert.equal((await s.adapter.queryIds(['TEST-299414'])).features[0].properties.sourceProperties.Codeident, 299414);
    for (const value of ['9007199254740992', '1.5', '-1', '01']) await assert.rejects(source(fixture({ values: [value], type: 'N' })).adapter.queryIds(['TEST-1']), gateway);
});
test('all request IDs and spatial input are validated before any download', async () => {
    const s = source(fixture(), { idType: 'integer' });
    for (const ids of [[], Array(81).fill('TEST-1'), ['OTHER-1'], ['TEST-1', 'TEST-%31'], ['TEST-01'], ['TEST-9007199254740992']]) await assert.rejects(s.adapter.queryIds(ids), e => e.status === 400);
    assert.throws(() => s.adapter.queryBounds([0, 0, 1, 1]), e => e.status === 400);
    assert.throws(() => s.adapter.queryGeometry({ type: 'Point', coordinates: [0, 0] }), e => e.status === 400); assert.equal(s.calls(), 0);
});
test('complete snapshot is independent of pageSize and has no invented network pagination', async () => {
    const s = source(fixture(), { pageSize: 1, idBatchSize: 1 });
    const results = await Promise.all([s.adapter.queryIds(['TEST-340172%20%20%20BV0156']), s.adapter.queryIds(['TEST-340172%20%20%20BV0151'])]);
    assert.ok(results.every(r => r.complete)); assert.equal(s.calls(), 1);
});
test('query limit fails instead of returning a truncated collection', async () => {
    const s = source(fixture(), { maxFeatures: 1 });
    await assert.rejects(s.adapter.queryIds(['TEST-340172%20%20%20BV0156', 'TEST-340172%20%20%20BV0151']), gateway);
    await assert.rejects(s.adapter.queryBounds([3.86, 43.61, 3.88, 43.63]), gateway);
});
test('descriptor requires revision, complete member family and safe identity-only fields', () => {
    const f = fixture();
    for (const d of [{ expectedSnapshotSha256: undefined }, { expectedSnapshotFeatures: undefined }, { shapefileMembers: { shp: 'parcel.shp' } },
        { shapefileMembers: { ...f.descriptor.shapefileMembers, dbf: '../parcel.dbf' } }, { outFields: ['Codeident', 'OWNER'] },
        { sourceCrs: 'EPSG:4326' }, { snapshotScope: 'city' }, { maxSnapshotBytes: 1e10 }, { maxSnapshotFeatures: 1 }]) assert.throws(() => source(f, d), /descriptor/);
});
for (const [name, mutate] of [
    ['mismatched SHX offsets', f => f.shx.writeUInt32BE(51, 100)],
    ['trailing SHP bytes', f => { f.shp = Buffer.concat([f.shp, Buffer.alloc(4)]); f.shp.writeUInt32BE(f.shp.length / 2, 24); }],
    ['null geometry', f => f.shp.writeUInt32LE(0, 108)],
    ['point geometry layer', f => f.shp.writeUInt32LE(1, 32)],
    ['nonfinite coordinate', f => f.shp.writeDoubleLE(NaN, 156)],
    ['unclosed source ring', f => f.shp.writeDoubleLE(1, 156)],
    ['DBF count mismatch', f => f.dbf.writeUInt32LE(3, 4)],
    ['deleted DBF row', f => { f.dbf[97] = 42; }],
    ['blank Utsunomiya native identity', f => f.dbf.fill(32, 98, 122)],
    ['mismatched CRS', f => { f.prj = strToU8(wkt('EPSG:6677')); }],
    ['mismatched CPG', f => { f.cpg = strToU8('1252'); }],
    ['fractional ID schema', f => { f.dbf[49] = 1; }]
]) test(`rejects ${name} without claiming absence`, async () => {
    await assert.rejects(source(fixture({ mutate })).adapter.queryIds(['TEST-missing']), gateway);
});
test('duplicate source identities are never merged or silently discarded', async () => {
    await assert.rejects(source(fixture({ values: ['same', 'same'] })).adapter.queryIds(['TEST-missing']), gateway);
});
test('bounded byte, decompressed size, feature and coordinate budgets', async () => {
    const f = fixture();
    for (const overrides of [{ maxSnapshotBytes: 10 }, { maxDecompressedBytes: 10 }, { maxRecordPoints: 4 }, { maxSnapshotPoints: 9 }]) await assert.rejects(source(f, overrides).adapter.queryIds(['TEST-missing']), gateway);
    await assert.rejects(source(f, { maxSnapshotBytes: 10 }, { fetchImpl: async () => new Response(f.bytes) }).adapter.queryIds(['TEST-missing']), gateway);
});
test('CRC, member selection and incomplete ZIPs fail explicitly', () => {
    const f = fixture(), d = { ...f.descriptor, maxDecompressedBytes: 100000, zipEncoding: 'utf-8' };
    const corrupted = Buffer.from(f.bytes), directory = corrupted.readUInt32LE(corrupted.length - 6);
    corrupted.writeUInt32LE(0, directory + 16); assert.throws(() => readShapefileZipMembers(corrupted, d), gateway);
    assert.throws(() => readShapefileZipMembers(f.bytes.subarray(0, f.bytes.length - 2), d), gateway);
    assert.throws(() => readShapefileZipMembers(f.bytes, { ...d, shapefileMembers: { ...d.shapefileMembers, shp: 'wrong.shp' } }), gateway);
    const unsafe = zipSync({ '../parcel.shp': f.files.shp }); assert.throws(() => readShapefileZipMembers(unsafe, d), gateway);
    const oversized = Buffer.from(f.bytes);
    oversized.writeUInt32LE(1, directory + 24); oversized.writeUInt32LE(1, 22);
    assert.throws(() => readShapefileZipMembers(oversized, d), gateway);
});
test('provider denials, throttles and failed loads remain errors and retryable', async () => {
    const f = fixture();
    for (const status of [403, 429, 500]) {
        const s = source(f, {}, { fetchImpl: async () => new Response('', { status, headers: { 'retry-after': '7' } }) });
        await assert.rejects(s.adapter.queryIds(['TEST-missing']), e => e.upstreamStatus === status && (status !== 429 || e.retryAfterSeconds === 7));
    }
    let calls = 0; const s = source(f, {}, { fetchImpl: async () => ++calls === 1 ? new Response('bad') : new Response(f.bytes) });
    await assert.rejects(s.adapter.queryIds(['TEST-missing']), gateway);
    assert.deepEqual((await s.adapter.queryIds(['TEST-missing'])).absentIds, ['TEST-missing']); assert.equal(calls, 2);
});
test('revision, response lengths and cache expiry are independently checked', async () => {
    const f = fixture();
    await assert.rejects(source(f, { expectedSnapshotSha256: '0'.repeat(64) }).adapter.queryIds(['TEST-missing']), gateway);
    await assert.rejects(source(f, {}, { fetchImpl: async () => new Response(f.bytes, { headers: { 'content-length': String(f.bytes.length + 1) } }) }).adapter.queryIds(['TEST-missing']), gateway);
    let time = 0; const s = source(f, {}, { now: () => time });
    await s.adapter.queryIds(['TEST-missing']); time = 300001; await s.adapter.queryIds(['TEST-missing']); assert.equal(s.calls(), 2);
});
test('production factory supports both Shapefile names and full snapshot format dispatch', async () => {
    const f = fixture();
    for (const adapter of ['shapefile-snapshot', 'shapefile-zip', 'geojson-snapshot']) {
        const source = createParcelSource({ ...f.descriptor, adapter, snapshotFormat: 'shapefile-zip' }, { fetchImpl: async () => new Response(f.bytes) });
        assert.equal((await source.queryIds(['TEST-340172%20%20%20BV0156'])).features.length, 1);
    }
});

test('signed binary integer DBF IDs remain exact and negative IDs fail', async () => {
    const s = source(fixture({ values: ['2147483647'], type: 'I' }), { idType: 'integer' });
    assert.equal((await s.adapter.queryIds(['TEST-2147483647'])).features[0].properties.sourceProperties.Codeident, 2147483647);
    await assert.rejects(source(fixture({ values: ['-1'], type: 'I' })).adapter.queryIds(['TEST-missing']), gateway);
});

for (const [name, mutate] of [
    ['non-Greenwich prime meridian', f => { f.prj = strToU8(wkt('EPSG:2154').replace('"Greenwich",0', '"Paris",2.33722917')); }],
    ['non-metric projection scaling', f => { f.prj = strToU8(wkt('EPSG:2154').replace('UNIT["Meter",1]', 'UNIT["Meter",0.3048]')); }],
    ['nonzero datum transformation', f => { f.prj = strToU8(wkt('EPSG:2154').replace('298.257222101]]', '298.257222101],TOWGS84[10,0,0]]')); }],
    ['non-ASCII field-name alias', f => { f.dbf[32] |= 128; }]
]) test(`rejects ${name} before publishing any geometry or absence`, async () => {
    await assert.rejects(source(fixture({ mutate })).adapter.queryIds(['TEST-missing']), gateway);
});

test('ZIP data descriptors are checked against central metadata, with either signature form', () => {
    const base = Buffer.from(zipSync({ 'parcel.prj': strToU8('metadata') }, { level: 0 }));
    const directory = base.readUInt32LE(base.length - 6), crc = base.readUInt32LE(directory + 16);
    const compressed = base.readUInt32LE(directory + 20), size = base.readUInt32LE(directory + 24);
    const descriptor = { shapefileMembers: { prj: 'parcel.prj' }, zipEncoding: 'utf-8', maxDecompressedBytes: 1000 };
    for (const signed of [false, true]) {
        const tail = Buffer.alloc(signed ? 16 : 12), offset = signed ? 4 : 0;
        if (signed) tail.writeUInt32LE(0x08074b50);
        tail.writeUInt32LE(crc, offset); tail.writeUInt32LE(compressed, offset + 4); tail.writeUInt32LE(size, offset + 8);
        const bytes = Buffer.concat([base.subarray(0, directory), tail, base.subarray(directory)]);
        bytes.writeUInt16LE(8, 6); bytes.fill(0, 14, 26); bytes.writeUInt16LE(8, directory + tail.length + 8);
        bytes.writeUInt32LE(directory + tail.length, bytes.length - 6);
        assert.equal(Buffer.from(readShapefileZipMembers(bytes, descriptor).prj).toString(), 'metadata');
        bytes.writeUInt32LE(size + 1, directory + offset + 8);
        assert.throws(() => readShapefileZipMembers(bytes, descriptor), gateway);
    }
});

test('central-directory case aliases and encryption flags are rejected', () => {
    const d = { shapefileMembers: { prj: 'parcel.prj' }, zipEncoding: 'utf-8', maxDecompressedBytes: 1000 };
    const ambiguous = zipSync({ 'parcel.prj': strToU8('one'), 'PARCEL.prj': strToU8('two') });
    assert.throws(() => readShapefileZipMembers(ambiguous, d), gateway);
    for (const flag of [1, 64]) {
        const bytes = Buffer.from(zipSync({ 'parcel.prj': strToU8('one') }));
        const directory = bytes.readUInt32LE(bytes.length - 6);
        bytes.writeUInt16LE(flag, 6); bytes.writeUInt16LE(flag, directory + 8);
        assert.throws(() => readShapefileZipMembers(bytes, d), gateway);
    }
});

test('snapshot indexing cancellation returns timeout, never explicit absence', async () => {
    const f = fixture();
    await assert.rejects(indexShapefileSnapshot(f.files, { ...f.descriptor, maxRecordPoints: 100, maxSnapshotPoints: 100 }, AbortSignal.abort()), e => e.status === 504);
});

test('a verified empty layer can prove absence without inventing records', async () => {
    const s = source(fixture({ values: [] }));
    const result = await s.adapter.queryIds(['TEST-missing']);
    assert.deepEqual(result.absentIds, ['TEST-missing']); assert.equal(result.complete, true);
    assert.deepEqual((await s.adapter.queryBounds([0, 0, 0.001, 0.001])).features, []);
});

test('compressed member trailing bytes cannot hide behind a valid CRC', () => {
    const base = Buffer.from(zipSync({ 'parcel.prj': strToU8('metadata') }));
    const directory = base.readUInt32LE(base.length - 6), compressed = base.readUInt32LE(directory + 20);
    const bytes = Buffer.concat([base.subarray(0, directory), Buffer.from([1, 2, 3, 4]), base.subarray(directory)]);
    bytes.writeUInt32LE(compressed + 4, 18); bytes.writeUInt32LE(compressed + 4, directory + 4 + 20);
    bytes.writeUInt32LE(directory + 4, bytes.length - 6);
    assert.throws(() => readShapefileZipMembers(bytes, { shapefileMembers: { prj: 'parcel.prj' }, zipEncoding: 'utf-8', maxDecompressedBytes: 1000 }), gateway);
});

test('failed error-body cancellation preserves the provider denial', async () => {
    const f = fixture(), s = source(f, {}, { fetchImpl: async () => ({
        ok: false, status: 403, body: { cancel: async () => { throw new Error('stream already failed'); } }
    }) });
    await assert.rejects(s.adapter.queryIds(['TEST-missing']), e => e.upstreamStatus === 403 && e.code === 'parcel-source-blocked');
});
