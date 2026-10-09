import { describe, expect, it, vi } from 'vitest';
import { createGeojsonSnapshotParcelSource } from '../parcels/geojson-snapshot-source.js';
import { CSV_GEOJSON_FIELDS, readCsvGeojsonParcelSnapshot } from '../parcels/csv-geojson-parcel-reader.js';

const descriptor = { id: 'rosario-section9', endpoint: 'https://example.org/parcels.csv', idPrefix: 'AR-ROS-9-',
    snapshotFormat: 'csv-geojson', csvFields: [...CSV_GEOJSON_FIELDS], csvGeometryField: 'GEOJSON',
    idFields: ['MSLINK'], outFields: ['MSLINK', 'SECCION', 'CARPETA'], parcelNumberField: 'MSLINK',
    maxSnapshotBytes: 100000, maxSnapshotFeatures: 20, maxFeatures: 20, maxBboxKm2: 25 };
const polygon = { type: 'Polygon', coordinates: [[[ -60, -32 ], [ -59.999, -32 ],
    [ -59.999, -31.999 ], [ -60, -31.999 ], [ -60, -32 ]]] };
const embedded = (geometry = polygon, properties = {}) => ({ type: 'Feature', geometry, properties });
const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;
const line = (id, geometry = polygon, carpeta = 'A') => {
    const values = [id, '09', '002', '44', '0', '0', '0', carpeta, JSON.stringify(embedded(geometry, { owner: 'ignored "quoted" value' }))];
    return values.map(csvCell).join(',');
};
const lineWithGeojsonText = text => ['00017', '09', '002', '44', '0', '0', '0', 'A', text].map(csvCell).join(',');
const csv = rows => `${CSV_GEOJSON_FIELDS.join(',')}\r\n${rows.join('\r\n')}`;
const response = body => new Response(body, { headers: { 'Content-Type': 'text/csv' } });
const parcelId = 'AR-ROS-9-00017';

describe('CSV GeoJSON parcel snapshot reader', () => {
    it('parses CSV escaping and multiline fields, retaining only the embedded geometry and selected CSV strings', async () => {
        const carpeta = 'A,\r\n"B"';
        const fetchImpl = vi.fn(async () => response(csv([line('00017', polygon, carpeta)])));
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl });
        const result = await source.queryIds([parcelId, 'AR-ROS-9-absent']);
        expect(result).toMatchObject({ complete: true, sourceId: descriptor.id, returnsWGS84: true,
            absentIds: ['AR-ROS-9-absent'] });
        expect(result.features).toHaveLength(1);
        expect(result.features[0]).toMatchObject({ id: parcelId, geometry: polygon,
            properties: { parcelNumber: '00017', sourceParcelId: '00017', sourceProperties: {
                MSLINK: '00017', SECCION: '09', CARPETA: carpeta
            } } });
        expect(result.features[0].properties.sourceProperties).not.toHaveProperty('GRAFICO');
        expect(result.features[0].properties.sourceProperties).not.toHaveProperty('owner');
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('requires the exact ordered publisher schema and valid descriptor field selections', () => {
        const text = csv([line('00017')]);
        expect(() => readCsvGeojsonParcelSnapshot(text, { ...descriptor,
            csvFields: [...CSV_GEOJSON_FIELDS].reverse() })).toThrow(/descriptor/);
        for (const header of [CSV_GEOJSON_FIELDS.map((field, i) => i === 1 ? 'MSLINK' : field),
            [...CSV_GEOJSON_FIELDS].reverse()]) {
            const drifted = `${header.join(',')}\n${line('00017')}`;
            expect(() => readCsvGeojsonParcelSnapshot(drifted, descriptor)).toThrow(/schema/);
        }
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor, csvGeometryField: 'shape' })).toThrow();
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor, outFields: ['MSLINK', 'GEOJSON'] })).toThrow();
        expect(() => createGeojsonSnapshotParcelSource({ ...descriptor, snapshotFormat: 'csv' })).toThrow();
    });

    it.each([
        ['empty native identity', csv([line('')])],
        ['repeated native identity', csv([line('00017'), line('00017', polygon)])],
        ['duplicate header', `MSLINK,MSLINK,MANZANA,GRAFICO,SD,SP,PASILLO,CARPETA,GEOJSON\n${line('00017')}`],
        ['wrong row width', `${CSV_GEOJSON_FIELDS.join(',')}\n"00017","09"`],
        ['unclosed quoted field', `${CSV_GEOJSON_FIELDS.join(',')}\n"00017","09","002","44","0","0","0","A","{`],
        ['malformed embedded JSON', csv([lineWithGeojsonText('{broken')])],
        ['null embedded geometry', csv([line('00017', null)])],
        ['null embedded JSON feature', csv([lineWithGeojsonText('null')])],
        ['unsupported embedded geometry', csv([line('00017', { type: 'Point', coordinates: [-60, -32] })])],
        ['truncated embedded JSON', csv([line('00017')]).slice(0, -8)],
        ['trailing characters after a quoted value', `${CSV_GEOJSON_FIELDS.join(',')}\n"00017"junk,"09","002","44","0","0","0","A",${csvCell(JSON.stringify(embedded()))}`],
        ['unquoted embedded comma', `${CSV_GEOJSON_FIELDS.join(',')}\n00017,09,002,44,0,0,0,A,{"type":"Feature"}`]
    ])('rejects %s without exposing a partial snapshot', async (_label, body) => {
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl: async () => response(body) });
        await expect(source.queryBounds([-60.001, -32.001, -59.998, -31.998])).rejects.toMatchObject({ status: 502 });
        await expect(source.queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
    });

    it('rejects invalid UTF-8 instead of replacing bytes in a native identifier', async () => {
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl: async () => new Response(new Uint8Array([0xff])) });
        await expect(source.queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
    });

    it('preserves a previous complete cache only until expiry and never publishes a malformed refresh', async () => {
        let time = 0;
        const fetchImpl = vi.fn().mockImplementationOnce(async () => response(csv([line('00017')]))).
            mockImplementationOnce(async () => response(csv([line('00017'), line('00018', { type: 'Point', coordinates: [-60, -32] })]))).
            mockImplementationOnce(async () => response(csv([line('00018')])));
        const source = createGeojsonSnapshotParcelSource(descriptor, { fetchImpl, now: () => time });
        expect((await source.queryIds([parcelId])).features).toHaveLength(1);
        time = 300000;
        await expect(source.queryIds([parcelId])).rejects.toMatchObject({ status: 502 });
        expect((await source.queryIds(['AR-ROS-9-00018'])).features).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
});
