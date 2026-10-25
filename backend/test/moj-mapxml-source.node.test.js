import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { parseMojMapXml, MOJ_ZONE_10 } from '../parcels/moj-mapxml-reader.js';
import { createMojMapXmlParcelSource } from '../parcels/moj-mapxml-source.js';
import { sha256Hex } from '../parcels/portable-hash.js';
import proj4 from 'proj4';

const filename = '04102-3700-118.xml';
const point = ([e, n]) => `<g:GM_Position.direct><g:X>${n}</g:X><g:Y>${e}</g:Y></g:GM_Position.direct>`;
const curve = (id, coordinates) => `<g:GM_Curve id="${id}"><g:GM_OrientablePrimitive.orientation>+</g:GM_OrientablePrimitive.orientation><g:GM_Curve.segment><g:GM_LineString><g:GM_LineString.controlPoint>${coordinates.map(p => `<g:GM_PointArray.column>${point(p)}</g:GM_PointArray.column>`).join('')}</g:GM_LineString.controlPoint></g:GM_LineString></g:GM_Curve.segment></g:GM_Curve>`;
const ring = ids => `<g:GM_Ring>${ids.map(id => `<g:GM_CompositeCurve.generator idref="${id}"/>`).join('')}</g:GM_Ring>`;
const boundary = (exterior, holes = []) => `<g:GM_SurfaceBoundary><g:GM_SurfaceBoundary.exterior>${ring(exterior)}</g:GM_SurfaceBoundary.exterior>${holes.map(ids => `<g:GM_SurfaceBoundary.interior>${ring(ids)}</g:GM_SurfaceBoundary.interior>`).join('')}</g:GM_SurfaceBoundary>`;
function fixture({ multi = false } = {}) {
    return strToU8(`<m:地図 xmlns:m="http://www.moj.go.jp/MINJI/tizuxml" xmlns:g="http://www.moj.go.jp/MINJI/tizuzumen"><m:座標系>公共座標10系</m:座標系><m:測地系判別>測量</m:測地系判別>
${curve('C1', [[10000,-190000],[10100,-190000]])}${curve('C2', [[10100,-189900],[10100,-190000]])}${curve('C3', [[10100,-189900],[10000,-189900],[10000,-190000]])}
${curve('C4', [[10020,-189980],[10080,-189980],[10080,-189920],[10020,-189920],[10020,-189980]])}
<g:GM_Surface id="F1"><g:GM_Surface.patch><g:GM_Polygon><g:GM_Polygon.boundary>${boundary(['C1','C2','C3'], [['C4']])}${multi ? boundary(['C4']) : ''}</g:GM_Polygon.boundary></g:GM_Polygon></g:GM_Surface.patch></g:GM_Surface>
<m:筆 id="H000000001"><m:形状 idref="F1"/><m:unselected>discarded</m:unselected></m:筆></m:地図>`);
}
const archive = xml => zipSync({ '04102-3700-118.zip': zipSync({ [filename]: xml }) });
const descriptor = bytes => ({ id: 'jp-moj-test', idPrefix: 'JP-MOJ-', endpoint: 'https://example.org/map.zip',
    outFields: ['id'], archiveSha256: sha256Hex(bytes), sheetIndex: [{ zip: '04102-3700-118.zip', xml: filename, bbox: [140,38,142,39] }] });

test('joins reversed native curves, preserves holes and safe sheet-scoped IDs', () => {
    const parsed = parseMojMapXml(fixture(), filename);
    assert.equal(parsed.features.length, 1);
    const f = parsed.features[0];
    assert.equal(f.id, filename + '#H000000001');
    assert.deepEqual(f.properties, { id: f.id });
    assert.equal(f.geometry.type, 'Polygon');
    assert.equal(f.geometry.coordinates.length, 2);
    const expected = proj4(MOJ_ZONE_10, 'EPSG:4326').forward([10000,-190000]);
    assert.deepEqual(f.geometry.coordinates[0][0], expected);
    assert.equal(f.geometry.coordinates[0].length, 5);
    assert.equal(f.geometry.coordinates[1].length, 5);
    assert.equal(parseMojMapXml(fixture({ multi: true }), filename).features[0].geometry.type, 'MultiPolygon');
});

test('resolves indirect point references without retaining unselected fields', () => {
    let xml = new TextDecoder().decode(fixture());
    xml = xml.replace('<g:GM_Surface id="F1">', '<g:GM_Point id="P1"><g:GM_Point.position><g:DirectPosition><g:X>-190000</g:X><g:Y>10000</g:Y></g:DirectPosition></g:GM_Point.position></g:GM_Point><g:GM_Surface id="F1">');
    xml = xml.replace(point([10000,-190000]), '<g:GM_Position.indirect><g:GM_PointRef.point idref="P1"/></g:GM_Position.indirect>');
    assert.deepEqual(parseMojMapXml(strToU8(xml), filename).features, parseMojMapXml(fixture(), filename).features);
});

test('rejects missing references, native endpoint gaps, entities and unplaced coordinates', () => {
    const xml = new TextDecoder().decode(fixture());
    for (const bad of [xml.replace('idref="F1"','idref="F9"'), xml.replace('<g:Y>10100</g:Y>', '<g:Y>10101</g:Y>'),
        xml.replace('公共座標10系','任意座標系'), '<!DOCTYPE map [<!ENTITY x "test">]>' + xml]) {
        assert.throws(() => parseMojMapXml(strToU8(bad), filename));
    }
});

test('nested live archive exact IDs, complete absence, bounds, immutable cached output and edition pin', async () => {
    const bytes = archive(fixture()); let requests = 0;
    const d = descriptor(bytes), source = createMojMapXmlParcelSource(d, { fetchImpl: async (_url, init) => {
        requests++; assert.equal(init.redirect, 'follow'); return new Response(bytes);
    } });
    const id = d.idPrefix + filename + '#H000000001', absent = d.idPrefix + filename + '#H999999999';
    const a = await source.queryIds([id, absent]);
    assert.deepEqual(a.absentIds, [absent]); assert.equal(a.complete, true); assert.equal(a.features.length, 1);
    const geometry = structuredClone(a.features[0].geometry);
    a.features[0].geometry.coordinates[0][0][0] = 0;
    assert.deepEqual((await source.queryIds([id])).features[0].geometry, geometry);
    const p = geometry.coordinates[0];
    const bounds = [Math.min(...p.map(v=>v[0])), Math.min(...p.map(v=>v[1])), Math.max(...p.map(v=>v[0])), Math.max(...p.map(v=>v[1]))];
    assert.equal((await source.queryBounds(bounds)).features.length, 1);
    assert.equal(requests, 1);
    await assert.rejects(source.queryIds(['foreign']));
    const changed = createMojMapXmlParcelSource({ ...d, archiveSha256: '0'.repeat(64) }, { fetchImpl: async () => new Response(bytes) });
    await assert.rejects(changed.queryIds([id]), /edition changed/);
});

test('relay follows only the configured CKAN resource into its exact public S3 path', async () => {
    const { validateParcelProviderRelayRequest, fetchParcelProviderRelay } = await import('../parcels/provider-relay.js');
    const endpoint = 'https://www.geospatial.jp/ckan/dataset/908edd07-4618-4631-a69d-c70dc6fbf520/resource/2eeff73b-3b0e-45d6-81a2-6c06a7c73b18/download/04102-3700-2025.zip';
    const d = { id: 'jp-moj-relay-test', adapter: 'moj-mapxml', endpoint, maxSnapshotBytes: 41943040 };
    const path = 'https://ckan-storage.s3.amazonaws.com/ckan/resources/2eeff73b-3b0e-45d6-81a2-6c06a7c73b18/04102-3700-2025.zip';
    const request = validateParcelProviderRelayRequest(d.id, { url: endpoint, redirect: 'follow' }, { sources: [d] });
    assert.equal(request.timeoutMs, 60000);
    const calls = [];
    const response = await fetchParcelProviderRelay(request, { providerFetch: async url => {
        calls.push(url.href);
        return url.href === endpoint ? new Response(null, { status: 302, headers: { location: path + '?response-content-disposition=attachment' } }) : new Response('zip');
    } });
    assert.equal(await response.text(), 'zip'); assert.equal(calls.length, 2);
    for (const url of [path.replace('04102-3700-2025.zip', 'other.zip'), path.replace('ckan-storage.s3.amazonaws.com', 'other.example')]) {
        assert.throws(() => validateParcelProviderRelayRequest(d.id, { url }, { sources: [d] }));
    }
});
