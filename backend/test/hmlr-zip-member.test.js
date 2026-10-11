// Headless regressions for descriptor ZIP loading, safe HMLR IDs and unchanged polygon parsing.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { readGmlZipMember } from '../parcels/gml-zip-reader.js';
import { createGmlSnapshotParcelSource } from '../parcels/gml-snapshot-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { parseGmlParcels } from '../parcels/gml-parcel-reader.js';

const memberName = 'Land_Registry_Cadastral_Parcels.gml';
const ring = (x = 530800) => `${x} 180200 ${x + 10} 180200 ${x + 10} 180210 ${x} 180210 ${x} 180200`;
const polygon = (x = 530800) => `<g:Polygon><g:exterior><g:LinearRing><g:posList>${ring(x)}</g:posList></g:LinearRing></g:exterior><g:interior><g:LinearRing><g:posList>${x + 2} 180202 ${x + 4} 180202 ${x + 4} 180204 ${x + 2} 180204 ${x + 2} 180202</g:posList></g:LinearRing></g:interior></g:Polygon>`;
const parcel = (id = '001', geometry = polygon()) => `<g:featureMember><lr:PREDEFINED g:id="transport-row"><lr:INSPIREID>${id}</lr:INSPIREID><lr:IGNORED>discard</lr:IGNORED><lr:GEOMETRY><g:MultiSurface srsName="EPSG:27700" srsDimension="2"><g:surfaceMember>${geometry}</g:surfaceMember></g:MultiSurface></lr:GEOMETRY></lr:PREDEFINED></g:featureMember>`;
const xml = (members = parcel()) => `<?xml version="1.0" encoding="UTF-8"?><g:FeatureCollection xmlns:g="http://www.opengis.net/gml" xmlns:lr="www.landregistry.gov.uk">${members}</g:FeatureCollection>`;
const descriptor = { id: 'hmlr-zip-test', adapter: 'gml-snapshot', endpoint: 'https://publisher.example/authority.zip',
    idField: 'INSPIREID', idType: 'string', idPattern: '^[0-9]+$', idPrefix: 'GB-HMLR-TEST-', outFields: ['INSPIREID'], parcelNumberField: 'INSPIREID',
    maxSnapshotBytes: 1000000, maxDecompressedBytes: 2000000, maxSnapshotFeatures: 100, maxFeatures: 100, maxBboxKm2: 25 };
const bounds = [-0.117, 51.505, -0.115, 51.507];
const unavailable = error => error.status === 502 && error.code === 'parcel-source-unavailable';

// Construct standard signed/unsigned data-descriptor archives from independently compressed members.
function archive(entries = [{ name: memberName, data: strToU8(xml()), level: 6 }], { dataDescriptor = true, signed = true } = {}) {
    const locals = [], directories = []; let offset = 0;
    for (const { name, data, level = 6 } of entries) {
        const zip = Buffer.from(zipSync({ [name]: data }, { level }));
        const directoryOffset = zip.readUInt32LE(zip.length - 6);
        const local = Buffer.from(zip.subarray(0, directoryOffset));
        const central = Buffer.from(zip.subarray(directoryOffset, zip.length - 22));
        central.writeUInt32LE(offset, 42);
        let trailer = Buffer.alloc(0);
        if (dataDescriptor) {
            local.writeUInt16LE(local.readUInt16LE(6) | 8, 6);
            central.writeUInt16LE(central.readUInt16LE(8) | 8, 8);
            trailer = Buffer.alloc(signed ? 16 : 12); let start = 0;
            if (signed) { trailer.writeUInt32LE(0x08074b50); start = 4; }
            for (let i = 0; i < 3; i++) trailer.writeUInt32LE(central.readUInt32LE(16 + i * 4), start + i * 4);
            local.fill(0, 14, 26);
        }
        locals.push(local, trailer); directories.push(central); offset += local.length + trailer.length;
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directories.reduce((n, d) => n + d.length, 0), 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...directories, end]);
}
function metadata(bytes) {
    const end = bytes.length - 22, directory = bytes.readUInt32LE(end + 16), local = bytes.readUInt32LE(directory + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    return { end, directory, local, start, dataEnd: start + bytes.readUInt32LE(directory + 20) };
}
async function read(bytes, limit = 2000000, signal) {
    const chunks = []; for await (const chunk of readGmlZipMember(bytes, limit, signal)) chunks.push(chunk);
    return Buffer.concat(chunks);
}
function source(bytes = archive(), changes = {}, options = {}) {
    let calls = 0;
    const adapter = createGmlSnapshotParcelSource({ ...descriptor, ...changes }, {
        fetchImpl: async () => { calls++; return new Response(bytes); }, ...options
    });
    return { adapter, calls: () => calls };
}

for (const level of [0, 6]) for (const dataDescriptor of [false, true]) for (const signed of dataDescriptor ? [false, true] : [false]) {
    test(`reads exact stored/deflated member bytes (level=${level}, descriptor=${dataDescriptor}, signed=${signed})`, async () => {
        const data = strToU8(xml()); assert.deepEqual(await read(archive([{ name: memberName, data, level }], { dataDescriptor, signed })), Buffer.from(data));
    });
}

test('compressed data containing ZIP descriptor/header signatures is read by offsets', async () => {
    // Valid raw DEFLATE can contain these bytes; XML validation belongs to the parser, not the byte loader.
    const data = Buffer.concat([Buffer.alloc(70000, 65), Buffer.from([0x50, 0x4b, 7, 8, 0x50, 0x4b, 3, 4]), Buffer.alloc(70000, 66)]);
    // Level zero stores bytes verbatim; changing the member's method to raw DEFLATE uses explicit stored blocks below.
    const { deflateRawSync } = await import('node:zlib');
    const compressed = deflateRawSync(data, { level: 0 });
    const bytes = archive([{ name: memberName, data, level: 0 }]);
    const m = metadata(bytes), central = Buffer.from(bytes.subarray(m.directory, m.end)), local = Buffer.from(bytes.subarray(0, m.start));
    local.writeUInt16LE(8, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20);
    const trailer = Buffer.from(bytes.subarray(m.dataEnd, m.directory)); trailer.writeUInt32LE(compressed.length, 8);
    const end = Buffer.from(bytes.subarray(m.end)); end.writeUInt32LE(local.length + compressed.length + trailer.length, 16);
    assert.deepEqual(await read(Buffer.concat([local, compressed, trailer, central, end])), data);
});

test('ignores fake local GML headers inside an ancillary data-descriptor member', async () => {
    const name = strToU8(memberName), fake = Buffer.alloc(30 + name.length + 1);
    fake.writeUInt32LE(0x04034b50); fake.writeUInt16LE(8, 8); fake.writeUInt32LE(1, 18); fake.writeUInt32LE(1, 22);
    fake.writeUInt16LE(name.length, 26); fake.set(name, 30);
    const bytes = archive([{ name: 'licence.bin', data: fake, level: 0 }, { name: memberName, data: strToU8(xml()) }]);
    const result = await source(bytes).adapter.queryIds(['GB-HMLR-TEST-001']);
    assert.equal(result.features[0].properties.sourceParcelId, '001');
});

test('production dispatch preserves safe identities, holes, multipolygons, exact absence and full queried geometry', async () => {
    const data = xml(parcel('001', polygon() + '</g:surfaceMember><g:surfaceMember>' + polygon(530830)));
    const bytes = archive([{ name: 'licence.txt', data: strToU8('information'), level: 0 }, { name: memberName, data: strToU8(data) }]);
    let calls = 0;
    const adapter = createParcelSource(descriptor, { fetchImpl: async () => { calls++; return new Response(bytes); } });
    const result = await adapter.queryIds(['GB-HMLR-TEST-001', 'GB-HMLR-TEST-999', 'GB-HMLR-TEST-001']);
    assert.equal(result.complete, true); assert.equal(result.returnsWGS84, true); assert.deepEqual(result.absentIds, ['GB-HMLR-TEST-999']);
    assert.equal(result.features.length, 1); const feature = result.features[0];
    assert.equal(feature.id, 'GB-HMLR-TEST-001'); assert.deepEqual(feature.properties.sourceProperties, { INSPIREID: '001' });
    assert.equal(feature.geometry.type, 'MultiPolygon'); assert.equal(feature.geometry.coordinates.length, 2); assert.equal(feature.geometry.coordinates[0].length, 2);
    const expected = (await parseGmlParcels(data)).features[0].geometry;
    assert.deepEqual(feature.geometry, expected);
    assert.deepEqual((await adapter.queryBounds(bounds)).features[0].geometry, expected);
    assert.deepEqual((await adapter.queryGeometry(expected)).features[0].geometry, expected);
    feature.geometry.coordinates[0][0][0][0] = 0;
    assert.deepEqual((await adapter.queryIds(['GB-HMLR-TEST-001'])).features[0].geometry, expected); assert.equal(calls, 1);
});

test('complete snapshot enumeration is independent of pageSize; actual feature limits fail closed', async () => {
    const bytes = archive([{ name: memberName, data: strToU8(xml(parcel('1') + parcel('2', polygon(530801)))) }]);
    const adapter = source(bytes, { pageSize: 1 }).adapter;
    assert.equal((await adapter.queryBounds(bounds)).features.length, 2);
    await assert.rejects(source(bytes, { maxFeatures: 1 }).adapter.queryBounds(bounds), /parcel limit/);
    await assert.rejects(source(bytes, { maxSnapshotFeatures: 1 }).adapter.queryBounds(bounds), /feature limit/);
});

test('rejects invalid IDs and excessive viewports before download', async () => {
    const s = source();
    for (const ids of [[], ['OTHER-1'], ['GB-HMLR-TEST-bad'], ['GB-HMLR-TEST-1\''], Array(81).fill('GB-HMLR-TEST-001')]) {
        await assert.rejects(s.adapter.queryIds(ids), error => error.status === 400);
    }
    await assert.rejects(s.adapter.queryBounds([-1, 50, 0, 51]), error => error.status === 400);
    assert.equal(s.calls(), 0);
});

const mutations = {
    'split disk': (b, m) => b.writeUInt16LE(1, m.end + 4),
    'count disagreement': (b, m) => b.writeUInt16LE(2, m.end + 8),
    'directory offset': (b, m) => b.writeUInt32LE(m.directory + 1, m.end + 16),
    'directory size': (b, m) => b.writeUInt32LE(1, m.end + 12),
    'name boundary': (b, m) => b.writeUInt16LE(65535, m.directory + 28),
    'ZIP64 size': (b, m) => b.writeUInt32LE(0xffffffff, m.directory + 24),
    'ZIP64 offset': (b, m) => b.writeUInt32LE(0xffffffff, m.directory + 42),
    'encryption': (b, m) => b.writeUInt16LE(1, m.directory + 8),
    'compression': (b, m) => b.writeUInt16LE(99, m.directory + 10),
    'local flags': b => b.writeUInt16LE(0, 6),
    'local method': b => b.writeUInt16LE(0, 8),
    'local name': b => { b[30] = 88; },
    'local bounds': b => b.writeUInt16LE(65535, 28),
    'local size': b => b.writeUInt32LE(2, 22),
    'descriptor crc': (b, m) => b.writeUInt32LE(0, m.dataEnd + 4),
    'descriptor length': (b, m) => b.writeUInt32LE(1, m.dataEnd + 8),
    'compressed truncation': (b, m) => b.writeUInt32LE(1, m.directory + 20),
    'forged decompressed size': (b, m) => { b.writeUInt32LE(1, m.directory + 24); b.writeUInt32LE(1, m.dataEnd + 12); },
    'checksum mismatch': (b, m) => { b.writeUInt32LE(0, m.directory + 16); b.writeUInt32LE(0, m.dataEnd + 4); },
    'bad compressed bytes': (b, m) => { b[m.start] = 7; }
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects archive integrity failure: ${name}`, async () => {
    const bytes = archive(); mutate(bytes, metadata(bytes)); await assert.rejects(read(bytes), unavailable);
});

for (const name of ['../parcel.gml', '/parcel.gml', 'folder\\parcel.gml', 'C:parcel.gml', './parcel.gml']) test(`rejects unsafe member ${name}`, async () => {
    await assert.rejects(read(archive([{ name, data: strToU8(xml()) }])), unavailable);
});

test('bounds all declared output, member count, actual output, and unique member selection', async () => {
    await assert.rejects(read(archive(), 10), /limits/);
    await assert.rejects(read(archive([{ name: 'a.gml', data: strToU8(xml()) }, { name: 'b.gml', data: strToU8(xml()) }])), /ambiguous/);
    await assert.rejects(read(archive([{ name: 'a.gml', data: strToU8(xml()) }, { name: 'A.GML', data: strToU8(xml()) }])), /ambiguous/);
    await assert.rejects(read(archive([{ name: 'readme.txt', data: strToU8('no polygons') }])), /no GML/);
    await assert.rejects(read(archive(Array.from({ length: 21 }, (_, i) => ({ name: `${i}.txt`, data: strToU8('a') })))), /Unsupported/);
    await assert.rejects(read(archive().subarray(0, 30)), unavailable);
    await assert.rejects(read(archive(), 2000000, AbortSignal.abort()), /aborted/);
});

test('rejects trailing compressed bytes, overlapped local members, and EOCD truncation', async () => {
    const bytes = archive(), m = metadata(bytes);
    const expanded = Buffer.concat([bytes.subarray(0, m.dataEnd), Buffer.from([0]), bytes.subarray(m.dataEnd)]);
    // Use the original offsets plus insertion; central directory and descriptor must otherwise agree.
    expanded.writeUInt32LE(m.directory + 1, expanded.length - 6);
    expanded.writeUInt32LE(bytes.readUInt32LE(m.directory + 20) + 1, m.directory + 1 + 20);
    expanded.writeUInt32LE(bytes.readUInt32LE(m.directory + 20) + 1, m.dataEnd + 1 + 8);
    await assert.rejects(read(expanded), /trailing bytes/);
    const pair = archive([{ name: 'licence.txt', data: strToU8('safe') }, { name: memberName, data: strToU8(xml()) }]);
    const first = metadata(pair), second = first.directory + 46 + pair.readUInt16LE(first.directory + 28);
    pair.writeUInt32LE(0, second + 42);
    await assert.rejects(read(pair), unavailable);
    await assert.rejects(read(bytes.subarray(0, bytes.length - 1)), unavailable);
});

for (const [name, data] of [
    ['wrong namespace', xml().replace('www.landregistry.gov.uk', 'https://foreign.example')],
    ['invalid native identity', xml(parcel('not-numeric'))],
    ['duplicate identity field', xml().replace('</lr:INSPIREID>', '</lr:INSPIREID><lr:INSPIREID>2</lr:INSPIREID>')],
    ['conflicting identity geometry', xml(parcel('1') + parcel('1', polygon(530830)))],
    ['unclosed ring', xml().replace(ring(), '530800 180200 530810 180200 530810 180210 530800 180210')],
    ['unsupported CRS', xml().replace('EPSG:27700', 'EPSG:4326')],
    ['malformed XML', xml().slice(0, -20)],
    ['DTD', xml().replace('<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE data SYSTEM "https://foreign.example/entity">')]
]) test(`parser regression: ${name}`, async () => {
    await assert.rejects(source(archive([{ name: memberName, data: strToU8(data) }])).adapter.queryIds(['GB-HMLR-TEST-001']), unavailable);
});

test('failed archive loads are retryable and never publish a partial cache', async () => {
    const corrupt = archive(); const m = metadata(corrupt); corrupt.writeUInt32LE(0, m.directory + 16); corrupt.writeUInt32LE(0, m.dataEnd + 4);
    let calls = 0;
    const adapter = createGmlSnapshotParcelSource(descriptor, { fetchImpl: async () => new Response(++calls === 1 ? corrupt : archive()) });
    await assert.rejects(adapter.queryIds(['GB-HMLR-TEST-001']), unavailable);
    assert.equal((await adapter.queryIds(['GB-HMLR-TEST-001'])).features.length, 1); assert.equal(calls, 2);
});

test('HTTP blocks, revision changes and streamed compressed-byte limits remain explicit', async () => {
    await assert.rejects(createGmlSnapshotParcelSource(descriptor, { fetchImpl: async () => new Response('blocked', { status: 403 }) }).queryBounds(bounds), error => error.code === 'parcel-source-blocked');
    await assert.rejects(source(archive(), { expectedEtag: '"frozen"' }).adapter.queryBounds(bounds), /revision changed/);
    await assert.rejects(source(archive(), { maxSnapshotBytes: 10 }).adapter.queryBounds(bounds), /byte limit/);
    await assert.rejects(source(archive(), {}, { fetchImpl: async () => new Response(archive(), { headers: { 'content-length': '99999' } }) }).adapter.queryBounds(bounds), /incomplete/);
});

test('source overlaps are retained under distinct IDs without clipping, merging or dropping geometry', async () => {
    const data = xml(parcel('1', polygon()) + parcel('2', polygon(530801)));
    const expected = (await parseGmlParcels(data)).features.map(feature => feature.geometry);
    const result = await source(archive([{ name: memberName, data: strToU8(data) }])).adapter.queryBounds(bounds);
    assert.deepEqual(result.features.map(feature => feature.id), ['GB-HMLR-TEST-1', 'GB-HMLR-TEST-2']);
    assert.deepEqual(result.features.map(feature => feature.geometry), expected);
});

test('stored size disagreement fails before exposing any payload bytes', async () => {
    const bytes = archive([{ name: memberName, data: strToU8(xml()), level: 0 }]);
    const m = metadata(bytes), forgedSize = bytes.readUInt32LE(m.directory + 24) + 1;
    bytes.writeUInt32LE(forgedSize, m.directory + 24); bytes.writeUInt32LE(forgedSize, m.dataEnd + 12);
    const iterator = readGmlZipMember(bytes, 2000000);
    await assert.rejects(iterator.next(), /stored member sizes disagree/);
});

test('streamed GML crosses XML and UTF-8 chunk boundaries without altering geometry', async () => {
    // Place a multibyte character across the reader's 64 KiB boundary in an ignored field.
    const prefix = xml().split('discard')[0];
    const padding = 'x'.repeat(65535 - Buffer.byteLength(prefix));
    const data = xml().replace('discard', `${padding}é${'y'.repeat(100000)}`);
    const expected = (await parseGmlParcels(xml())).features[0].geometry;
    for (const level of [0, 6]) {
        const bytes = archive([{ name: memberName, data: strToU8(data), level }]);
        const result = await source(bytes).adapter.queryIds(['GB-HMLR-TEST-001']);
        assert.deepEqual(result.features[0].geometry, expected);
        assert.deepEqual(result.features[0].properties.sourceProperties, { INSPIREID: '001' });
    }
});

test('a shared failed CRC load rejects all callers and the next load publishes a complete snapshot', async () => {
    const corrupt = archive(), m = metadata(corrupt);
    corrupt.writeUInt32LE(0, m.directory + 16); corrupt.writeUInt32LE(0, m.dataEnd + 4);
    let calls = 0;
    const fetchImpl = async () => new Response(++calls === 1 ? corrupt : archive());
    const a = createGmlSnapshotParcelSource(descriptor, { fetchImpl });
    const b = createGmlSnapshotParcelSource(descriptor, { fetchImpl });
    const failures = await Promise.allSettled([a.queryBounds(bounds), b.queryIds(['GB-HMLR-TEST-001'])]);
    assert.equal(calls, 1);
    assert.ok(failures.every(result => result.status === 'rejected' && unavailable(result.reason)));
    const results = await Promise.all([a.queryBounds(bounds), b.queryIds(['GB-HMLR-TEST-001'])]);
    assert.equal(calls, 2);
    assert.ok(results.every(result => result.complete && result.features.length === 1));
    assert.deepEqual(results[0].features, results[1].features);
});
