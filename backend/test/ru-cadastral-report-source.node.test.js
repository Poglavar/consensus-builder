// Exercise report parsing, exact live-read semantics, scope and bounded transport failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuCadastralReportSource, parseCadastralReport, YAROSLAVL_REPORT_ENDPOINT,
    YAROSLAVL_REPORT_ID, YAROSLAVL_MSK76 } from '../parcels/ru-cadastral-report-source.js';
import { createParcelSource } from '../parcels/sources.js';
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';

const native = [[376300, 1330300], [376310, 1330300], [376310, 1330310], [376300, 1330300]];
const html = `<td>${YAROSLAVL_REPORT_ID}</td>Кадастровый номер Сведения о характерных точках границы земельного участка
    Coords1[0][0][0] = 'part'; ${native.flat().map((v, i) => `Coords1[0][0][${i + 1}] = ${v};`).join('\n')}`;
const descriptor = { id: 'ru-yaroslavl-kadastrovaya-karta-com-report', adapter: 'ru-cadastral-report',
    endpoint: YAROSLAVL_REPORT_ENDPOINT, nativeId: YAROSLAVL_REPORT_ID, nativeProjection: YAROSLAVL_MSK76,
    idPrefix: 'RU-YAROSLAVL-REPORT-', outFields: ['cadnum'], parcelNumberField: 'cadnum' };
const id = descriptor.idPrefix + YAROSLAVL_REPORT_ID;

test('extracts unchanged source coordinates without evaluating script', () => {
    assert.deepEqual(parseCadastralReport(html + '<script>throw new Error("must not run")</script>', YAROSLAVL_REPORT_ID),
        { type: 'Polygon', coordinates: [native] });
    for (const invalid of [html.replace('1330300;', 'NaN;'), html.replace('Coords1[0][0][2]', 'Coords1[0][0][12]'),
        html.replace('Coords1[0][0][8] = 1330300', 'Coords1[0][0][8] = 1330301'),
        html + 'Coords1[0][1][1] = 5;', html.replace(YAROSLAVL_REPORT_ID, '76:23:000000:0')]) {
        assert.throws(() => parseCadastralReport(invalid, YAROSLAVL_REPORT_ID));
    }
});

test('both factories fetch every exact read, retain only IDs, filter full polygons and bound scope', async () => {
    for (const factory of [createParcelSource, browserParcelFactories['ru-cadastral-report']]) {
        let requests = 0;
        const source = factory(descriptor, { fetchImpl: async (url, options) => {
            requests++; assert.equal(url, new URL(YAROSLAVL_REPORT_ENDPOINT).href);
            assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
            return new Response(html);
        } });
        const a = await source.queryIds([id]), b = await source.queryIds([id]);
        assert.equal(requests, 2); assert.deepEqual(a, b);
        assert.equal(a.features[0].id, id);
        assert.deepEqual(a.features[0].properties.sourceProperties, { cadnum: YAROSLAVL_REPORT_ID });
        const ring = a.features[0].geometry.coordinates[0];
        assert.equal(ring.length, native.length); assert.deepEqual(ring[0], ring.at(-1));
        assert.ok(ring.every(([x,y]) => x > 39 && x < 41 && y > 57 && y < 58));
        const [x,y] = ring[0];
        assert.equal((await source.queryBounds([x-.001,y-.001,x+.001,y+.001])).features.length, 1);
        assert.equal((await source.queryBounds([0,0,.001,.001])).features.length, 0);
        await assert.rejects(source.queryIds(['RU-YAROSLAVL-REPORT-76:23:000000:0']), /outside/);
        assert.equal((await source.queryIds([])).features.length, 0);
        await assert.rejects(source.queryBounds([0,0,10,10]), /too large/);
    }
});

test('fails closed on upstream HTTP errors and actual streamed byte overflow', async () => {
    const unavailable = createRuCadastralReportSource(descriptor, { fetchImpl: async () => new Response('', { status: 403 }) });
    await assert.rejects(unavailable.queryIds([id]), /403/);
    const large = createRuCadastralReportSource(descriptor, { maxResponseBytes: 1024,
        fetchImpl: async () => new Response('x'.repeat(1025), { headers: { 'content-length': '1' } }) });
    await assert.rejects(large.queryIds([id]), /byte limit/);
});
