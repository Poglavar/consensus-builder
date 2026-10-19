// Headless tests for the fixed Spanish ATOM transport, ZIP selection and complete CP geometry contract.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createParcelSource } from '../parcels/sources.js';
import { createGmlSnapshotParcelSource } from '../parcels/gml-snapshot-source.js';
import { parseGmlParcels } from '../parcels/gml-parcel-reader.js';
import { readGmlZipMember } from '../parcels/gml-zip-reader.js';
import { CATASTRO_ATOM_PROFILE as profile, CATASTRO_ATOM_GML_SCHEMA as schema } from '../parcels/catastro-atom-profile.js';

const native = '6415809UM5161E', other = '6415810UM5161E', missing = '0000000UM5100S';
const canonical = id => `ES-DGC-${id}`;
const descriptor = {
    id: profile.sourceId, adapter: 'gml-snapshot', endpoint: profile.endpoint, countryCode: 'ES',
    idField: schema.idField, idPrefix: 'ES-DGC-', idType: 'string', idPattern: schema.localIdPattern,
    outFields: [schema.idField], parcelNumberField: schema.idField, metricSrid: 25830,
    maxSnapshotBytes: 1000000, maxDecompressedBytes: 2000000, maxSnapshotFeatures: 100,
    maxFeatures: 100, maxBboxKm2: 1, bbox: [-10, 35, 5, 44]
};
const ring = (x = 355900, y = 4611400, size = 20) => `${x} ${y} ${x + size} ${y} ${x + size} ${y + size} ${x} ${y + size} ${x} ${y}`;
const patch = (x = 355900) => `<g:Surface><g:patches><g:PolygonPatch><g:exterior><g:LinearRing><g:posList>${ring(x)}</g:posList></g:LinearRing></g:exterior><g:interior><g:LinearRing><g:posList>${ring(x + 4, 4611404, 3)}</g:posList></g:LinearRing></g:interior></g:PolygonPatch></g:patches></g:Surface>`;
const geometry = `<c:geometry><g:MultiSurface srsName="http://www.opengis.net/def/crs/EPSG/0/25830" srsDimension="2"><g:surfaceMember>${patch()}</g:surfaceMember><g:surfaceMember>${patch(355930)}</g:surfaceMember></g:MultiSurface></c:geometry>`;
const parcel = (id = native, shape = geometry) => `<w:member><c:CadastralParcel g:id="ES.SDGC.CP.${id}"><c:label>discarded</c:label>${shape}<c:nationalCadastralReference>${id}</c:nationalCadastralReference><c:referencePoint><g:Point srsName="EPSG:25830"><g:pos>355900 4611400</g:pos></g:Point></c:referencePoint></c:CadastralParcel></w:member>`;
const xml = (members = parcel(), matched = 1, returned = matched) => `<w:FeatureCollection xmlns:w="http://www.opengis.net/wfs/2.0" xmlns:c="${schema.featureNamespace}" xmlns:g="${schema.gmlNamespace}" xmlns:x="urn:untrusted" xmlns:xi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xl="http://www.w3.org/1999/xlink" numberMatched="${matched}" numberReturned="${returned}">${members}</w:FeatureCollection>`;
const archive = (data = xml(), changes = {}) => zipSync({
    [profile.parcelMember]: strToU8(data),
    [profile.members[1]]: strToU8('<zoning>Not a parcel and never parsed.</zoning>'),
    [profile.members[2]]: strToU8('<metadata/>'), ...changes
});
const unavailable = error => error.status === 502 && error.code === 'parcel-source-unavailable';
const parse = data => parseGmlParcels(data, { schema });
const source = (bytes = archive(), changes = {}, options = {}) => createParcelSource({ ...descriptor, ...changes }, {
    fetchImpl: async () => new Response(bytes), ...options
});
const bounds = [-4.731, 41.640, -4.728, 41.643];

async function readZip(bytes, selectedProfile) {
    const chunks = [];
    for await (const chunk of readGmlZipMember(bytes, 2000000, undefined, selectedProfile)) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

test('production dispatch retains native identity, every polygon and hole, full archive counts and explicit absence', async () => {
    let calls = 0;
    const adapter = source(archive(), {}, { fetchImpl: async () => { calls++; return new Response(archive()); } });
    const result = await adapter.queryIds([canonical(native), canonical(missing), canonical(native)]);
    assert.equal(result.complete, true); assert.equal(result.returnsWGS84, true);
    assert.deepEqual(result.absentIds, [canonical(missing)]); assert.equal(result.features.length, 1);
    assert.deepEqual(result.snapshotCounts, { featureCount: 1, uniqueFeatureCount: 1, numberMatched: 1, numberReturned: 1, sourceCrs: 'EPSG:25830' });
    const feature = result.features[0];
    assert.equal(feature.id, canonical(native)); assert.equal(feature.properties.sourceParcelId, native);
    assert.deepEqual(feature.properties.sourceProperties, { nationalCadastralReference: native });
    assert.equal(feature.geometry.type, 'MultiPolygon'); assert.equal(feature.geometry.coordinates.length, 2);
    assert.equal(feature.geometry.coordinates[0].length, 2); assert.equal(feature.geometry.coordinates[1].length, 2);
    const [lon, lat] = feature.geometry.coordinates[0][0][0];
    assert.ok(Math.abs(lon - (-4.7302539554)) < 1e-8); assert.ok(Math.abs(lat - 41.6413233447) < 1e-8);
    const original = structuredClone(feature.geometry);
    const selected = await adapter.queryGeometry(original);
    assert.deepEqual(selected.features[0].geometry, original);
    assert.equal((await adapter.queryBounds(bounds)).features.length, 1);
    result.features[0].geometry.coordinates[0][0][0][0] = 0; result.snapshotCounts.featureCount = 999;
    const reread = await adapter.queryIds([canonical(native)]);
    assert.deepEqual(reread.features[0].geometry, original); assert.equal(reread.snapshotCounts.featureCount, 1);
    assert.equal(calls, 1);
});

test('fixed ZIP profile selects parcels alongside zoning while the default stays ambiguous', async () => {
    const bytes = archive(); assert.equal(await readZip(bytes, profile), xml());
    await assert.rejects(readZip(bytes), /ambiguous|unsafe/);
    await assert.rejects(readZip(bytes, { ...profile }), /Invalid parcel ZIP profile/);
    for (const name of ['unexpected.gml', '../escape.gml', 'a/../escape.gml']) {
        await assert.rejects(readZip(archive(xml(), { [name]: strToU8(xml()) }), profile), unavailable);
    }
    const incomplete = zipSync({ [profile.parcelMember]: strToU8(xml()) });
    await assert.rejects(readZip(incomplete, profile), /incomplete member set/);
    const corrupt = Buffer.from(bytes); const directory = corrupt.readUInt32LE(corrupt.length - 6);
    corrupt.writeUInt32LE(0, directory + 16); corrupt.writeUInt32LE(0, 14);
    await assert.rejects(readZip(corrupt, profile), /checksum/);
});

for (const [name, data] of [
    ['unknown total', xml().replace('numberMatched="1"', 'numberMatched="unknown"')],
    ['missing total', xml().replace(' numberMatched="1"', '')],
    ['missing returned count', xml().replace(' numberReturned="1"', '')],
    ['truncated declared count', xml(parcel(), 2, 2)],
    ['only matched count disagrees', xml(parcel(), 2, 1)],
    ['duplicate native geometry', xml(parcel() + parcel(), 2, 2)],
    ['conflicting native geometry', xml(parcel() + parcel(native, geometry.replaceAll('355900', '355901')), 2, 2)],
    ['wrong namespace', xml().replaceAll(schema.featureNamespace, 'urn:unexpected')],
    ['wrong CRS', xml().replaceAll('25830', '25831')],
    ['three dimensional', xml().replace('srsDimension="2"', 'srsDimension="3"')],
    ['invalid native identifier', xml().replaceAll(native, native.toLowerCase())],
    ['injected native field', xml().replace('<c:nationalCadastralReference>', '<c:nationalCadastralReference><x:field>').replace('</c:nationalCadastralReference>', '</x:field></c:nationalCadastralReference>')],
    ['nested native field', xml().replace('<c:nationalCadastralReference>', '<c:label><c:nationalCadastralReference>').replace('</c:nationalCadastralReference>', '</c:nationalCadastralReference></c:label>')],
    ['foreign native namespace', xml().replaceAll('c:nationalCadastralReference', 'x:nationalCadastralReference')],
    ['repeated native field', xml().replace('</c:CadastralParcel>', `<c:nationalCadastralReference>${native}</c:nationalCadastralReference></c:CadastralParcel>`)],
    ['nil geometry', xml().replace('<c:geometry>', '<c:geometry xi:nil="true">')],
    ['referenced geometry', xml().replace('<g:surfaceMember>', '<g:surfaceMember xl:href="#unresolved">')],
    ['empty geometry component', xml().replace('<g:surfaceMember>', '<g:surfaceMember/><g:surfaceMember>')],
    ['malformed geometry nesting', xml().replaceAll('g:LinearRing', 'g:surfaceMember')],
    ['unexpected geometry text', xml().replace('<g:surfaceMember>', '<g:surfaceMember>discard-me')],
    ['empty collection member', xml(parcel() + '<w:member/>')],
    ['multiple parcels in one member', xml(parcel() + parcel(other), 2).replace('</w:member><w:member>', '')],
    ['referenced collection member', xml().replace('<w:member>', '<w:member xl:href="#elsewhere">')],
    ['nil collection member', xml().replace('<w:member>', '<w:member xi:nil="true">')],
    ['foreign empty collection member', xml(parcel() + '<g:featureMember/>')],
    ['nil native identifier', xml().replace('<c:nationalCadastralReference>', '<c:nationalCadastralReference xi:nil="true">')],
    ['referenced native identifier', xml().replace('<c:nationalCadastralReference>', '<c:nationalCadastralReference xl:href="#elsewhere">')],
    ['CRS on a preceding feature only', xml(parcel() + parcel(other, geometry.replace(' srsName="http://www.opengis.net/def/crs/EPSG/0/25830"', '')), 2)],
    ['CRS on following reference point only', xml(parcel(native, geometry.replace(' srsName="http://www.opengis.net/def/crs/EPSG/0/25830"', '')))],
    ['nested parcel path', xml().replace('<w:member>', '<w:member><x:wrapper>').replace('</w:member>', '</x:wrapper></w:member>')],
    ['external entity', '<!DOCTYPE w:FeatureCollection SYSTEM "https://example.invalid/entity">' + xml()],
    ['incomplete XML', xml().slice(0, -10)]
]) test(`schema fails closed: ${name}`, async () => { await assert.rejects(parse(data), unavailable); });

test('Spanish CRS declarations are inherited from geometry ancestors with every ring retained', async () => {
    const onProperty = geometry.replace('<c:geometry>', '<c:geometry srsName="EPSG:25830">')
        .replace(' srsName="http://www.opengis.net/def/crs/EPSG/0/25830"', '');
    const parsed = await parse(xml(parcel(native, onProperty)));
    assert.deepEqual(parsed.features[0].geometry, (await parse(xml())).features[0].geometry);
    assert.equal(parsed.sourceCrs, 'EPSG:25830');
});

test('Spanish declared feature limit is enforced before consuming parcel bodies', async () => {
    await assert.rejects(parseGmlParcels(xml('', 101), { schema, maxFeatures: 100 }), /feature limit/);
});

test('snapshot limits fail before partial results and ID/bbox limits fail before downloads', async () => {
    let calls = 0;
    const adapter = source(archive(), {}, { fetchImpl: async () => { calls++; return new Response(archive()); } });
    for (const ids of [[], Array(81).fill(canonical(native)), ['OTHER-' + native], [canonical(native.toLowerCase())], [canonical('../' + native)], [canonical(native + '0')]]) {
        await assert.rejects(adapter.queryIds(ids), error => error.status === 400);
    }
    await assert.rejects(adapter.queryBounds([-5, 41, -4, 42]), error => error.status === 400);
    assert.equal(calls, 0);
    const two = archive(xml(parcel() + parcel(other), 2));
    await assert.rejects(source(two, { maxSnapshotFeatures: 1 }).queryIds([canonical(native)]), /feature limit/);
    await assert.rejects(source(two, { maxFeatures: 1 }).queryBounds(bounds), /parcel limit/);
    await assert.rejects(source(archive(), { maxSnapshotBytes: 10 }).queryIds([canonical(native)]), /byte limit/);
    await assert.rejects(source(archive(), { maxDecompressedBytes: 10 }).queryIds([canonical(native)]), /decompressed limits/);
    await assert.rejects(source(archive(xml('', 0))).queryIds([canonical(missing)]), /no verified polygons/);
    const bytes = archive();
    await assert.rejects(source(bytes, {}, { fetchImpl: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }) }).queryIds([canonical(native)]), /incomplete/);
});

test('complete snapshots have no paging; expired or incomplete refreshes cannot prove absence', async () => {
    let calls = 0, time = 0;
    const fetchImpl = async () => { calls++; return new Response(calls === 2 ? archive(xml(parcel(), 2)) : archive()); };
    const adapter = source(archive(), { pageSize: 1 }, { fetchImpl, now: () => time, cacheTtlMs: 10 });
    await Promise.all([adapter.queryIds([canonical(native)]), adapter.queryBounds(bounds)]);
    assert.equal(calls, 1); time = 11;
    await assert.rejects(adapter.queryIds([canonical(missing)]), /incomplete|inconsistent/);
    assert.equal(calls, 2);
    const retry = await adapter.queryIds([canonical(missing)]);
    assert.deepEqual(retry.absentIds, [canonical(missing)]); assert.equal(calls, 3);
});

test('default Spanish transport is source scoped, anonymous, bounded, and refuses redirects', async () => {
    const original = globalThis.fetch, calls = [];
    let time = 0, response = () => new Response(archive());
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response(); };
    try {
        const adapter = createGmlSnapshotParcelSource(descriptor, { cacheTtlMs: 1, now: () => ++time * 10 });
        assert.equal((await adapter.queryIds([canonical(native)])).features.length, 1);
        assert.equal(calls[0].url, profile.endpoint); assert.equal(calls[0].init.redirect, 'manual');
        assert.match(calls[0].init.headers.Accept, /application\/x-zip-compressed/);
        assert.equal(calls[0].init.headers.Cookie, undefined); assert.ok(calls[0].init.signal);
        for (const change of [{ endpoint: profile.endpoint + '?q=1' }, { endpoint: profile.endpoint + '#fragment' }, { endpoint: profile.endpoint.replace('https:', 'http:') }, { idPrefix: 'OTHER-' }, { outFields: [schema.idField, 'label'] }]) {
            assert.throws(() => createGmlSnapshotParcelSource({ ...descriptor, ...change }), /Invalid Spanish/);
        }
        const before = calls.length;
        await assert.rejects(createGmlSnapshotParcelSource({ ...descriptor, id: 'unregistered-source' }).queryIds([canonical(native)]), /Unsupported official/);
        assert.equal(calls.length, before);
        response = () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/untrusted.zip' } });
        await assert.rejects(adapter.queryIds([canonical(native)]), /redirects are unsupported/);
        assert.equal(calls.length, before + 1);
        response = () => new Response('denied', { status: 403 });
        await assert.rejects(adapter.queryIds([canonical(native)]), error => error.code === 'parcel-source-blocked' && error.upstreamStatus === 403);
        response = () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
        await assert.rejects(adapter.queryIds([canonical(native)]), error => error.code === 'parcel-source-rate-limited' && error.retryAfterSeconds === 30);
    } finally { globalThis.fetch = original; }
});
