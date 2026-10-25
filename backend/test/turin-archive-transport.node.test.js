// Turin's HTTP publication is an exact, hash-pinned exception shared by browser and backend transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShapefileSnapshotParcelSource, isTorinoArchive, TORINO_ARCHIVE_ENDPOINT } from '../parcels/shapefile-snapshot-source.js';
import { validateParcelProviderRelayRequest, createProviderRelayFetch } from '../parcels/provider-relay.js';
const descriptor = { id: 'it-comune-torino-catasto-urbano', adapter: 'shapefile-snapshot', endpoint: TORINO_ARCHIVE_ENDPOINT,
    expectedSnapshotSha256: '1ae313dd9203f2a6c3e13e77efebdc7f1b9f56ef26327e32435be315699e98f1',
    idPrefix: 'IT-COMUNE-TORINO-CATASTO-URBANO|CIT_PART|', idField: 'CIT_PART', idFields: ['CIT_PART'], outFields: ['CIT_PART'],
    sourceCrs: 'EPSG:3003', idType: 'integer', integerDecimalFields: ['CIT_PART'], expectedSnapshotFeatures: 67587,
    shapefileMembers: { shp: 'catasto_urbano.shp', shx: 'catasto_urbano.shx', dbf: 'catasto_urbano.dbf', prj: 'catasto_urbano.prj' } };
test('HTTP exception binds source, adapter, literal endpoint and immutable release', async () => {
    assert.equal(isTorinoArchive(descriptor), true);
    const request = { url: TORINO_ARCHIVE_ENDPOINT, redirect: 'error' };
    assert.equal(validateParcelProviderRelayRequest(descriptor.id, request, { sources: [descriptor] }).target.href, request.url);
    for (const mutation of [{ id: 'other' }, { adapter: 'shapefile-zip' }, { expectedSnapshotSha256: 'a'.repeat(64) },
        { endpoint: TORINO_ARCHIVE_ENDPOINT + '?other=1' }]) {
        const changed = { ...descriptor, ...mutation };
        assert.equal(isTorinoArchive(changed), false);
        assert.throws(() => createShapefileSnapshotParcelSource(changed));
        assert.throws(() => validateParcelProviderRelayRequest(changed.id, request, { sources: [changed] }));
    }
    for (const url of [TORINO_ARCHIVE_ENDPOINT + '?x=1', TORINO_ARCHIVE_ENDPOINT.replace('catasto_urbano', 'other')]) {
        assert.throws(() => validateParcelProviderRelayRequest(descriptor.id, { url }, { sources: [descriptor] }));
    }
    for (const redirect of ['follow', 'manual']) assert.throws(() => validateParcelProviderRelayRequest(descriptor.id,
        { ...request, redirect }, { sources: [descriptor] }));
    let sent = false;
    const adapter = createShapefileSnapshotParcelSource(descriptor, { fetchImpl: async (url, options) => {
        sent = true; assert.equal(url, TORINO_ARCHIVE_ENDPOINT); assert.equal(options.redirect, 'error');
        return new Response('', { status: 302 });
    } });
    await assert.rejects(adapter.queryIds([descriptor.idPrefix + '95158']), error => error.status === 502);
    assert.equal(sent, true);
});
test('HTTP transport still rejects private DNS before opening a socket', async () => {
    const transport = createProviderRelayFetch({ lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        httpRequestImpl: () => { throw new Error('Must not open a socket'); } });
    await assert.rejects(transport(new URL(TORINO_ARCHIVE_ENDPOINT)), error => error.status === 403);
    await assert.rejects(transport(new URL('http://example.test/other')), error => error.status === 400);
});
