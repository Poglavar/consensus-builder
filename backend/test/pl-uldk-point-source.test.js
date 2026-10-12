// Unit tests for the GUGiK ULDK point and exact-ID adapter: reply grammar, identity echo, strict WKT,
// point containment, explicit absence, pacing, and failure mapping. No network access.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createUldkPointSource, parseUldkPolygonWkt, ULDK_NATIVE_ID_PATTERN } from '../parcels/pl-uldk-point-source.js';

// Bydgoszcz parcel 046101_1.0128.268/2. The ULDK body was rebuilt from the repository sample
// (world-parcels/research/overnight-next-2101-2200-2026-10-09/bydgoszcz-parcel-sample.geojson) with
// vertex 24 restored to the source value its review receipt records; it is not a raw capture.
const fixtureBody = readFileSync(new URL('./fixtures/pl-uldk-bydgoszcz-parcel.txt', import.meta.url), 'utf8');
const descriptor = {
    adapter: 'pl-uldk-point',
    id: 'pl-gugik-uldk',
    idPrefix: 'PL-ULDK-',
    endpoint: 'https://uldk.gugik.gov.pl/',
    idField: 'id',
    idPattern: ULDK_NATIVE_ID_PATTERN,
    outFields: ['id']
};
const nativeId = '046101_1.0128.268/2';
const parcelId = `${descriptor.idPrefix}${nativeId}`;
// UN WUP 2025 population-weighted centre of Bydgoszcz, which ULDK resolved to this parcel.
const point = [17.997811624784, 53.1261021859871];
const fixtureRecord = fixtureBody.trimEnd().split('\n')[1];
const fixtureWkt = fixtureRecord.split('|')[1].slice('SRID=4326;'.length);
const fixtureGeometry = parseUldkPolygonWkt(fixtureWkt);

function reply(body, status = 200, headers = { 'Content-Type': 'text/plain; charset=UTF-8' }) {
    return new Response(body, { status, headers });
}

function clock() {
    let time = 1_000_000;
    const waits = [];
    return {
        now: () => time,
        waitImpl: vi.fn(async ms => { waits.push(ms); time += ms; }),
        advance: ms => { time += ms; },
        waits
    };
}

function source(fetchImpl, options = {}) {
    const { now, waitImpl } = clock();
    return createUldkPointSource(descriptor, { fetchImpl, now, waitImpl, ...options });
}

const multiPolygonWithHole = 'MULTIPOLYGON(((18 53,18.01 53,18.01 53.01,18 53.01,18 53),(18.004 53.004,18.006 53.004,18.006 53.006,18.004 53.006,18.004 53.004)),((18.02 53,18.03 53,18.03 53.01,18.02 53)))';

afterEach(() => vi.restoreAllMocks());

describe('ULDK point parcel source', () => {
    it('reads one WGS84 parcel at a point and keeps only the native TERYT ID', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(fixtureBody));
        const result = await source(fetchImpl).queryPoint(point);

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://uldk.gugik.gov.pl/?request=GetParcelByXY&xy=17.997811624784%2C53.1261021859871%2C4326&result=id%2Cgeom_wkt&srid=4326');
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'text/plain' } });
        expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
        expect(result).toMatchObject({ complete: true, queryType: 'point', sourceId: descriptor.id, returnsWGS84: true, point });
        expect(result.features).toHaveLength(1);
        expect(result.features[0]).toMatchObject({
            id: parcelId,
            geometry: { type: 'Polygon' },
            properties: { parcelId, sourceId: descriptor.id, sourceParcelId: nativeId, parcelNumber: nativeId, sourceProperties: { id: nativeId } }
        });
        expect(Object.keys(result.features[0].properties.sourceProperties)).toEqual(['id']);
        // Coordinates are canonicalised to 1e-7 degrees (backend transform noise is ~1e-11 degrees):
        // vertex 24 (17.9972192485999, 53.126844057528 as printed) becomes the nearest 1e-7 values.
        expect(result.features[0].geometry.coordinates[0][24]).toEqual([17.9972192, 53.1268441]);
        expect(result.features[0].geometry.coordinates[0]).toHaveLength(32);
    });

    it('reads an exact ID by its native identity and returns byte-identical geometry to the point read', async () => {
        const pointResult = await source(vi.fn().mockResolvedValue(reply(fixtureBody))).queryPoint(point);
        const fetchImpl = vi.fn().mockResolvedValue(reply(fixtureBody.trimEnd()));
        const result = await source(fetchImpl).queryIds([parcelId, parcelId]);

        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toBe(
            'https://uldk.gugik.gov.pl/?request=GetParcelById&id=046101_1.0128.268%2F2&result=id%2Cgeom_wkt&srid=4326');
        expect(result).toMatchObject({ complete: true, queryType: 'ids', sourceId: descriptor.id, returnsWGS84: true, absentIds: [] });
        expect(result.features.map(feature => feature.id)).toEqual([parcelId]);
        expect(JSON.stringify(result.features[0].geometry)).toBe(JSON.stringify(pointResult.features[0].geometry));
    });

    it('gives one geometry for backend replies that differ only by ~1e-11 degree transform noise', async () => {
        const live = readFileSync(new URL('./fixtures/pl-uldk-warsaw-point-2026-10-12.txt', import.meta.url), 'utf8');
        const noisy = live.replace(/(\d+\.\d{10})(\d+)/g, (_, head, tail) => `${head}${String((Number(tail[0]) + 3) % 10)}${tail.slice(1)}9`);
        expect(noisy).not.toBe(live);
        const a = await source(vi.fn().mockResolvedValue(reply(live))).queryPoint([21.0008161096, 52.2229170531]);
        const b = await source(vi.fn().mockResolvedValue(reply(noisy))).queryPoint([21.0008161096, 52.2229170531]);
        expect(JSON.stringify(b.features[0].geometry)).toBe(JSON.stringify(a.features[0].geometry));
        const coordinate = a.features[0].geometry.coordinates[0][0][0];
        expect(Math.round(coordinate * 1e7) / 1e7).toBe(coordinate);
    });

    it('accepts the exact live two-line no-result reply as absence and nothing near it', async () => {
        const live = readFileSync(new URL('./fixtures/pl-uldk-no-result-2026-10-12.txt', import.meta.url), 'utf8');
        const absentId = 'PL-ULDK-146506_8.0104.999999';
        await expect(source(vi.fn().mockResolvedValue(reply(live))).queryIds([absentId]))
            .resolves.toMatchObject({ complete: true, absentIds: [absentId], features: [] });
        await expect(source(vi.fn().mockResolvedValue(reply(live))).queryPoint([52.2, 21.0]))
            .resolves.toMatchObject({ complete: true, features: [] });
        for (const body of [live.replace('Zbiorcza', 'Inna'), live.replace('-1 brak wyników', '-1 wystąpił bład'), `${live}\nextra`]) {
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryIds([absentId]))
                .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        }
    });

    it('reads the live Warsaw point reply as one containing parcel with its native ID', async () => {
        const live = readFileSync(new URL('./fixtures/pl-uldk-warsaw-point-2026-10-12.txt', import.meta.url), 'utf8');
        const result = await source(vi.fn().mockResolvedValue(reply(live))).queryPoint([21.0008161096, 52.2229170531]);
        expect(result.features.map(f => f.properties.parcelId)).toEqual(['PL-ULDK-146506_8.0104.1']);
    });

    it('treats only the documented no-result line as explicit absence', async () => {
        const absentId = 'PL-ULDK-046101_1.0128.99999/9';
        for (const body of ['-1 brak wyników', '-1 brak wyników\n', '-1 brak wyników \r\n', '-1 brak wyników\n']) {
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryIds([absentId]))
                .resolves.toMatchObject({ complete: true, queryType: 'ids', absentIds: [absentId], features: [] });
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryPoint([18.5, 53.1]))
                .resolves.toMatchObject({ complete: true, queryType: 'point', point: [18.5, 53.1], features: [] });
        }
        for (const body of ['-1 wystąpił bład\n', '-1 brak wyników dla powiatu\n', '-1\n', '-1 Brak wyników\n', '-1 brak wyników\n\n']) {
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryIds([absentId]))
                .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryPoint([18.5, 53.1]))
                .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        }
    });

    it('rejects unknown status lines, multi-record replies, and non-text bodies', async () => {
        const record = fixtureRecord;
        const bodies = ['', '\n', '0\n', '0', '1\n' + record, '2\n' + record + '\n' + record, '0\n' + record + '\n' + record,
            '00\n' + record, ' 0\n' + record, record, '0\n\n' + record, '<html><body>Przerwa techniczna</body></html>'];
        for (const body of bodies) {
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryPoint(point))
                .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        }
        const html = reply(fixtureBody, 200, { 'Content-Type': 'text/html; charset=UTF-8' });
        await expect(source(vi.fn().mockResolvedValue(html)).queryPoint(point)).rejects.toMatchObject({ status: 502 });
        const untyped = new Response(fixtureBody, { status: 200, headers: {} });
        untyped.headers.delete('content-type');
        await expect(source(vi.fn().mockResolvedValue(untyped)).queryPoint(point)).rejects.toMatchObject({ status: 502 });
        const latin2 = reply(new Uint8Array([0x2d, 0x31, 0x20, 0x62, 0xb3, 0xb1, 0x64]));
        await expect(source(vi.fn().mockResolvedValue(latin2)).queryPoint(point)).rejects.toMatchObject({ status: 502 });
    });

    it('rejects a wrong ID echo, out-of-format IDs, and records without exactly two fields', async () => {
        const echo = fixtureBody.replace('268/2', '268/3');
        await expect(source(vi.fn().mockResolvedValue(reply(echo))).queryIds([parcelId]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        for (const record of ['046101_1.128.268/2', '046101_1.0128.268/2a', '046101_1.0128.268-2', '046101_1.0128.268/2/1', 'ul. Długa 1']) {
            const body = fixtureBody.replace(nativeId, record);
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryPoint(point)).rejects.toMatchObject({ status: 502 });
        }
        const extraField = fixtureBody.replace('|SRID', '|Bydgoszcz|SRID');
        await expect(source(vi.fn().mockResolvedValue(reply(extraField))).queryPoint(point)).rejects.toMatchObject({ status: 502 });
        const noGeometry = `0\n${nativeId}\n`;
        await expect(source(vi.fn().mockResolvedValue(reply(noGeometry))).queryPoint(point)).rejects.toMatchObject({ status: 502 });
    });

    it('rejects malformed WKT, other SRIDs, non-polygons and unclosed rings without repairing them', async () => {
        const variants = [
            fixtureBody.replace('SRID=4326;', 'SRID=2180;'),
            fixtureBody.replace('SRID=4326;', ''),
            fixtureBody.replace('POLYGON((', 'POLYGON Z(('),
            fixtureBody.replace('POLYGON((', 'CURVEPOLYGON(('),
            fixtureBody.replace('POLYGON((', 'POLYGON(').replace('))\n', ')\n'),
            fixtureBody.replace('))\n', ')\n'),
            fixtureBody.replace('17.9970275929801 53.1265185678819,', '17.9970275929801 53.1265185678819 104.2,'),
            fixtureBody.replace('17.9970275929801 53.1265185678819,', '17.9970275929801,'),
            fixtureBody.replace('17.9970275929801 53.1265185678819,', '17.9970275929801 53.1265185678819,,'),
            fixtureBody.replace('17.9970275929801 53.1265185678819,', '17.99702759x29801 53.1265185678819,'),
            fixtureBody.replace(/POLYGON\(\(17\.9970275929801 53\.1265185678819,/, 'POLYGON((17.99 53.12,'),
            `0\n${nativeId}|SRID=4326;POLYGON EMPTY\n`,
            `0\n${nativeId}|SRID=4326;POINT(17.99 53.12)\n`,
            `0\n${nativeId}|SRID=4326;POLYGON((17.99 53.12,17.998 53.12,17.99 53.12))\n`
        ];
        for (const body of variants) {
            expect(body).not.toBe(fixtureBody);
            await expect(source(vi.fn().mockResolvedValue(reply(body))).queryPoint(point))
                .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        }
    });

    it('preserves MultiPolygon parts and holes, and rejects a point that falls in a hole', async () => {
        const id = 'PL-ULDK-046101_1.0128.AR_12.268/2';
        const body = `0\n046101_1.0128.AR_12.268/2|SRID=4326;${multiPolygonWithHole}\n`;
        const result = await source(vi.fn().mockResolvedValue(reply(body))).queryPoint([18.001, 53.001]);
        expect(result.features[0].id).toBe(id);
        expect(result.features[0].geometry).toEqual(parseUldkPolygonWkt(multiPolygonWithHole));
        expect(result.features[0].geometry.type).toBe('MultiPolygon');
        expect(result.features[0].geometry.coordinates).toHaveLength(2);
        expect(result.features[0].geometry.coordinates[0]).toHaveLength(2);
        expect(result.features[0].geometry.coordinates[0][1][0]).toEqual([18.004, 53.004]);

        await expect(source(vi.fn().mockResolvedValue(reply(body))).queryPoint([18.005, 53.005]))
            .rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        const exact = await source(vi.fn().mockResolvedValue(reply(body))).queryIds([id]);
        expect(exact.features[0].geometry).toEqual(result.features[0].geometry);
    });

    it('rejects a parcel that does not contain the queried point instead of snapping to it', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(reply(fixtureBody));
        const adapter = source(fetchImpl);
        for (const invalid of [null, [], [18, 53, 1], ['18', 53], [181, 53], [18, -91], [NaN, 53], [18, Infinity]]) {
            await expect(adapter.queryPoint(invalid)).rejects.toMatchObject({ status: 400, code: 'invalid-parcel-point' });
        }
        expect(fetchImpl).not.toHaveBeenCalled();
        // A swapped axis order also lands here: the same record queried at [lat, lon] is outside the polygon.
        await expect(adapter.queryPoint([53.1261021859871, 17.997811624784])).rejects.toMatchObject({ status: 502 });
        await expect(adapter.queryPoint([18.1, 53.2])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid IDs and refuses area requests without calling the provider', async () => {
        const fetchImpl = vi.fn();
        const adapter = source(fetchImpl);
        for (const ids of [[nativeId], ['PL-ULDK-'], ['PL-ULDK-046101_1.0128'], ['PL-ULDK-046101_1.0128.268/2|x'],
            ['PL-ULDK-046101_1.0128.268/2\n0'], ['pl-uldk-046101_1.0128.268/2'], ['PL-ULDK-046101_10.0128.268/2'],
            ['PL-ULDK-046101_1.0128.ar_12.268/2'], [42], 'PL-ULDK-046101_1.0128.268/2',
            Array.from({ length: 81 }, (_, index) => `PL-ULDK-046101_1.0128.${index + 1}`)]) {
            await expect(adapter.queryIds(ids)).rejects.toMatchObject({ status: 400, code: 'invalid-parcel-ids' });
        }
        await expect(adapter.queryBounds([18, 53, 18.01, 53.01])).rejects.toMatchObject({ status: 422, code: 'parcel-source-area-unsupported' });
        await expect(adapter.queryGeometry({ type: 'Polygon', coordinates: [] })).rejects.toMatchObject({ status: 422, code: 'parcel-source-area-unsupported' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('accepts an 80-ID batch, reading each ID once in order', async () => {
        const ids = Array.from({ length: 80 }, (_, index) => `PL-ULDK-046101_1.0128.${index + 1}`);
        const fetchImpl = vi.fn().mockImplementation(async () => reply('-1 brak wyników\n'));
        const result = await source(fetchImpl).queryIds(ids);
        expect(fetchImpl).toHaveBeenCalledTimes(80);
        expect(result.absentIds).toEqual(ids);
        expect(fetchImpl.mock.calls[79][0]).toContain('id=046101_1.0128.80&');
    });

    it('starts sequential provider requests at least one second apart across calls and within a batch', async () => {
        const { now, waitImpl, waits, advance } = clock();
        const starts = [];
        const fetchImpl = vi.fn().mockImplementation(async () => { starts.push(now()); advance(120); return reply('-1 brak wyników\n'); });
        const adapter = createUldkPointSource(descriptor, { fetchImpl, now, waitImpl });
        await adapter.queryPoint([18.5, 53.1]);
        await adapter.queryIds(['PL-ULDK-046101_1.0128.1', 'PL-ULDK-046101_1.0128.2', 'PL-ULDK-046101_1.0128.3']);
        advance(5000);
        await adapter.queryPoint([18.6, 53.1]);
        expect(starts).toHaveLength(5);
        for (let index = 1; index < starts.length; index++) expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(1000);
        expect(waits).toEqual([880, 880, 880]);
    });

    it('keeps a full second after a late timer and waits again after an early one', async () => {
        let time = 5_000;
        const waits = [];
        const starts = [];
        const drift = [5, -1];
        const waitImpl = async ms => { waits.push(ms); time += Math.max(1, ms + (drift.shift() ?? 0)); };
        const fetchImpl = vi.fn().mockImplementation(async () => { starts.push(time); return reply('-1 brak wyników\n'); });
        const adapter = createUldkPointSource(descriptor, { fetchImpl, now: () => time, waitImpl });
        for (const longitude of [18.5, 18.6, 18.7]) await adapter.queryPoint([longitude, 53.1]);
        expect(waits).toEqual([1000, 1000, 1]);
        expect(starts).toEqual([5_000, 6_005, 7_005]);
    });

    it('gives concurrent callers consecutive one-second start slots', async () => {
        // A fake timer queue: the clock moves only to the earliest pending timer, as real time would.
        let time = 1_000_000;
        const waits = [];
        const timers = [];
        const starts = [];
        const waitImpl = ms => new Promise(resolve => { waits.push(ms); timers.push({ at: time + ms, resolve }); });
        const fetchImpl = vi.fn().mockImplementation(async () => { starts.push(time); return reply('-1 brak wyników\n'); });
        const adapter = createUldkPointSource(descriptor, { fetchImpl, now: () => time, waitImpl });
        let settled = false;
        const all = Promise.all([adapter.queryPoint([18.5, 53.1]), adapter.queryPoint([18.6, 53.1]), adapter.queryIds(['PL-ULDK-046101_1.0128.1'])])
            .finally(() => { settled = true; });
        for (let step = 0; step < 50 && !settled; step++) {
            await new Promise(resolve => setImmediate(resolve));
            timers.sort((a, b) => a.at - b.at);
            const next = timers.shift();
            if (next) { time = Math.max(time, next.at); next.resolve(); }
        }
        await all;
        expect(waits).toEqual([1000, 2000]);
        expect(starts).toEqual([1_000_000, 1_001_000, 1_002_000]);
    });

    it('maps timeouts, access failures and oversized replies without retrying', async () => {
        const timedOut = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        await expect(source(timedOut).queryPoint(point)).rejects.toMatchObject({ status: 504 });
        expect(timedOut).toHaveBeenCalledOnce();

        const network = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
        await expect(source(network).queryIds([parcelId])).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        expect(network).toHaveBeenCalledOnce();

        const forbidden = vi.fn().mockResolvedValue(reply('Forbidden', 403, { 'content-type': 'text/html' }));
        await expect(source(forbidden).queryPoint(point)).rejects.toMatchObject({ status: 502, code: 'parcel-source-blocked', upstreamStatus: 403 });
        expect(forbidden).toHaveBeenCalledOnce();

        const rateLimited = vi.fn().mockResolvedValue(reply('<html>slow down</html>', 429, { 'content-type': 'text/html', 'retry-after': '17' }));
        await expect(source(rateLimited).queryIds([parcelId])).rejects.toMatchObject({
            status: 502, code: 'parcel-source-rate-limited', upstreamStatus: 429, retryAfterSeconds: 17
        });
        expect(rateLimited).toHaveBeenCalledOnce();

        const serverError = vi.fn().mockResolvedValue(reply('-1 brak wyników\n', 500));
        await expect(source(serverError).queryIds([parcelId])).rejects.toMatchObject({ status: 502, upstreamStatus: 500 });

        const large = vi.fn().mockResolvedValue(reply(`0\n${nativeId}|SRID=4326;POLYGON((${' '.repeat(2 * 1024 * 1024)}))`));
        await expect(source(large).queryPoint(point)).rejects.toMatchObject({ status: 502, code: 'parcel-source-unavailable' });
        const declaredLarge = vi.fn().mockResolvedValue(reply(fixtureBody, 200, { 'content-type': 'text/plain', 'content-length': String(3 * 1024 * 1024) }));
        await expect(source(declaredLarge).queryPoint(point)).rejects.toMatchObject({ status: 502 });
    });

    it('requires the descriptor to keep the verified endpoint, ID field and ID pattern', () => {
        expect(() => createUldkPointSource(descriptor, { fetchImpl: vi.fn() })).not.toThrow();
        for (const change of [{ endpoint: 'http://uldk.gugik.gov.pl/' }, { outFields: ['id', 'parcel'] }, { idField: 'teryt' },
            { idPrefix: 'PL-' }, { idPattern: '^.*$' }, { adapter: 'tkgm-point' }, { parcelNumberField: 'parcel' }]) {
            expect(() => createUldkPointSource({ ...descriptor, ...change }, { fetchImpl: vi.fn() })).toThrow(/Invalid ULDK/);
        }
    });
});

describe('ULDK WKT reader', () => {
    it('keeps polygon rings, holes and parts in provider order', () => {
        expect(parseUldkPolygonWkt('POLYGON((1 2,3 4,5 6,1 2),(1.5 2.5,2 3,2.5 3.5,1.5 2.5))')).toEqual({
            type: 'Polygon', coordinates: [[[1, 2], [3, 4], [5, 6], [1, 2]], [[1.5, 2.5], [2, 3], [2.5, 3.5], [1.5, 2.5]]]
        });
        expect(parseUldkPolygonWkt('MULTIPOLYGON (((1 2, 3 4, 5 6, 1 2)), ((7 8, 9 10, 11 12, 7 8)))').coordinates).toHaveLength(2);
        expect(fixtureGeometry.coordinates[0][0]).toEqual([17.9970275929801, 53.1265185678819]);
    });

    it('refuses dimensions, nesting and trailing text it does not understand', () => {
        for (const text of ['POLYGON((1 2 3,4 5 6,7 8 9,1 2 3))', 'POLYGON(((1 2,3 4,5 6,1 2)))', 'MULTIPOLYGON((1 2,3 4,5 6,1 2))',
            'POLYGON((1 2,3 4,5 6,1 2)) x', 'POLYGON((1 2,3 4,5 6,1 2)', 'POLYGON((12,3 4,5 6,12))', 'polygon((1 2,3 4,5 6,1 2))',
            'POLYGON((1 2,3 4,5 6,1 2)),', 'GEOMETRYCOLLECTION(POLYGON((1 2,3 4,5 6,1 2)))']) {
            expect(() => parseUldkPolygonWkt(text)).toThrow(/ULDK/);
        }
    });
});
