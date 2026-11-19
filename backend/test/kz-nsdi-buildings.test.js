// Astana's registered WFS source must retain building identity and distinguish storeys from metres.
import { expect, it, vi } from 'vitest';
import { buildingSourceRegistry } from '../buildings/index.js';
import { boxPolygon } from '../buildings/split-read.js';

const box = [71.428, 51.126, 71.434, 51.131];
const footprint = boxPolygon([71.430, 51.128, 71.431, 51.129]);

it('serves the same official building for footprint, model and region reads', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        type: 'FeatureCollection', numberMatched: 1, numberReturned: 1,
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } },
        features: [{ type: 'Feature', id: 'buildings_a.123', geometry: footprint, properties: { id: 54, levels: '6' } }]
    })));
    const source = buildingSourceRegistry.open('kz-nsdi-buildings', { fetchImpl });
    const area = boxPolygon(box);
    expect(await source.mapFootprints(area)).toMatchObject({ source: 'kz-nsdi-buildings', footprints: [
        { id: 'KZ-NSDI-B-54', geometry: footprint, floors: 6, height_m: null }
    ] });
    expect(await source.near(area, 0)).toMatchObject({ source: 'kz-nsdi-buildings', buildings: [
        { object_id: 'KZ-NSDI-B-54', z_max: 18, floors: 6, height_source: 'levels' }
    ] });
    expect((await source.footprintsUnder([{ key: 'site', geometry: area }])).regions.get('site'))
        .toMatchObject([{ id: 'KZ-NSDI-B-54', floors: 6, height_m: null }]);
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get('bbox')).toBe(`${box.join(',')},CRS:84`);
    expect(url.searchParams.get('propertyName')).toBe('geom,id,levels');
});
