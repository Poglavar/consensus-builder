// Alatau general plan (Decree 727) Permitted source: zone interpretation, live WFS reads limited to
// Alatau's territory, record re-reads, and a study on a one-part MultiPolygon lot from the cadastre.
import { describe, it, expect, vi } from 'vitest';
import * as turf from '@turf/turf';
import { createAlatauGenplanProvider, alatauGenplanSource, interpretZone, ALATAU_ADMTERR_ID } from '../planning/providers/alatau-genplan.js';
import { planningRepresentations, getPlanningSources } from '../planning/sources.js';
import { assembleParcelStudy } from '../planning/parcel-study.js';

// A real zone in Yntymak (object 481223, existing detached housing), coordinates as served.
const yntymakRing = [[76.97164927, 43.41549894], [76.97021284, 43.41102108], [76.9691655, 43.41136301], [76.97055485, 43.41571063], [76.97164927, 43.41549894]];
const zone = (id, functional, changes = {}, ring = yntymakRing) => ({ type: 'Feature', id: `gpzone.${id}`,
    geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
    properties: { object_id_i32: id, admterr_id: ALATAU_ADMTERR_ID, usl_i32: 1, name_usl: functional, functional,
        implementation: 'Существующие', gpzone: 'Жилые зоны', shape_length: 0.01, shape_area: 0.00001, ...changes } });
const HOUSES = 'Территория усадебной застройки с земельным участком при доме (квартире)';

function service(features) {
    const fetchImpl = vi.fn(async href => {
        const url = new URL(href);
        const filter = url.searchParams.get('FILTER') || '';
        const start = Number(url.searchParams.get('startIndex') || 0), count = Number(url.searchParams.get('count'));
        // A record read filters by object id; a viewport read filters by territory (and bounds), as the service does.
        const pool = filter.includes('object_id_i32') ? features.filter(f => filter.includes(`<fes:Literal>${f.properties.object_id_i32}</fes:Literal>`))
            : features.filter(f => filter.includes(`<fes:Literal>${f.properties.admterr_id}</fes:Literal>`));
        const page = pool.slice(start, start + count);
        return { ok: true, json: async () => ({ type: 'FeatureCollection', features: page, numberMatched: pool.length, numberReturned: page.length }) };
    });
    return { fetchImpl, provider: createAlatauGenplanProvider(alatauGenplanSource, { fetchImpl }) };
}
const bbox = [76.965, 43.405, 76.975, 43.42];

describe('Alatau general plan zones', () => {
    it('reads residential storey classes as storey and height limits', () => {
        expect(interpretZone({ functional: HOUSES })).toMatchObject({ status: 'allowed', storeys: 3, heightM: 9, use: 'Усадебная застройка' });
        expect(interpretZone({ functional: 'Территория многоэтажной застройки (6-12 этажей)' })).toMatchObject({ status: 'allowed', storeys: 12, heightM: 36 });
        const mid = interpretZone({ functional: 'Территория среднеэтажной застройки (4-5 и 6* этажей)' });
        expect(mid).toMatchObject({ status: 'allowed', storeys: 5, uplift: { storeys: 6 } });
        expect(mid.constraints.map(item => [item.quantity, item.value, item.bound])).toEqual([['storeys', 5, 'maximum'], ['height', 15, 'maximum']]);
    });

    it('hands taller and non-residential building zones to the detailed plan, and keeps open land unbuilt', () => {
        expect(interpretZone({ functional: 'Территория застройки повышенной этажности (выше 12 этажей)' })).toMatchObject({ status: 'instrument_handoff', storeys: null, constraints: [] });
        expect(interpretZone({ functional: 'Территория учреждений образования' })).toMatchObject({ status: 'instrument_handoff' });
        expect(interpretZone({ functional: 'Территория парков, скверов и т.д. (зона кратковременного отдыха)' })).toMatchObject({ status: 'prohibited', constraints: [] });
        // The served label carries a no-break space.
        expect(interpretZone({ functional: 'Территория железных дорог и сооружений железнодорожного транспорта' })).toMatchObject({ status: 'prohibited', use: 'Железные дороги' });
        expect(interpretZone({ functional: 'Новая зона' })).toMatchObject({ status: 'unrecorded', constraints: [] });
    });
});

describe('Alatau general plan provider', () => {
    it('asks the service for Alatau zones in a latitude-first box and pages by service row', async () => {
        const features = [zone(481223, HOUSES), zone(481224, 'Территория учреждений образования'), zone(900001, HOUSES, { admterr_id: '751210000' })];
        const { provider, fetchImpl } = service(features);
        const first = await provider.query(null, { bbox, limit: 2 });
        expect(first.items.map(item => item.id)).toEqual(['alatau-genplan-727:481223', 'alatau-genplan-727:481224']);
        expect(first.items[0]).toMatchObject({ role: 'permitted', title: 'Усадебная застройка · до 3 эт. · существующая',
            assessment: { meaning: 'zoning-area', status: 'allowed' }, metrics: { heightM: 9 } });
        expect(first.items[0].constraints.map(item => item.quantity)).toEqual(['storeys', 'height']);
        expect(first.nextAfter).toBe('2');
        const second = await provider.query(null, { bbox, limit: 2, after: first.nextAfter });
        // The neighbour's zone is never returned, so it is not an omission that would mark a read incomplete.
        expect(second).toMatchObject({ items: [], omitted: 0, nextAfter: null });
        const url = new URL(fetchImpl.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://map.gov4c.kz/ggkgs/ows');
        expect(url.searchParams.get('typeNames')).toBe('kz:gpzone');
        expect(url.searchParams.has('bbox')).toBe(false);
        const viewportFilter = url.searchParams.get('FILTER');
        expect(viewportFilter).toContain('<fes:ValueReference>admterr_id</fes:ValueReference><fes:Literal>191810000</fes:Literal>');
        expect(viewportFilter).toContain('<gml:lowerCorner>43.405 76.965</gml:lowerCorner><gml:upperCorner>43.42 76.975</gml:upperCorner>');
        expect(url.searchParams.get('sortBy')).toBe('object_id_i32');
        expect(fetchImpl.mock.calls[0][1].headers.Referer).toBe('https://map.gov4c.kz/egkn/');
    });

    it('re-reads one record by its object id and refuses invalid ids', async () => {
        const { provider, fetchImpl } = service([zone(481223, HOUSES), zone(481224, 'Территория учреждений образования')]);
        const [item] = await provider.record(null, { recordId: '481224' });
        expect(item).toMatchObject({ id: 'alatau-genplan-727:481224', assessment: { status: 'instrument_handoff' } });
        expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('FILTER')).toContain('<fes:ValueReference>object_id_i32</fes:ValueReference>');
        expect(await provider.record(null, { recordId: '1 OR 1=1' })).toEqual([]);
    });

    it('fails as unavailable when the service answers badly', async () => {
        const provider = createAlatauGenplanProvider(alatauGenplanSource, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
        await expect(provider.query(null, { bbox, limit: 5 })).rejects.toMatchObject({ status: 503, code: 'planning-source-unavailable' });
    });

    it('is a registered planning source answering through the shared representation contract', async () => {
        expect(getPlanningSources().some(source => source.descriptor.id === 'alatau-genplan-727')).toBe(true);
        const { provider } = service([zone(481223, HOUSES)]);
        const answer = await planningRepresentations(null, { city: 'alatau', bbox, limit: 10, source: 'alatau-genplan-727' }, [provider]);
        expect(answer).toMatchObject({ coverage: 'source-results', truncated: false });
        expect(answer.items).toHaveLength(1);
    });

    it('studies a lot the cadastre serves as a one-part MultiPolygon', async () => {
        const { provider } = service([zone(481223, HOUSES)]);
        const [record] = await provider.record(null, { recordId: '481223' });
        const lot = turf.bboxPolygon([76.9700, 43.4125, 76.9702, 43.4127]);
        const multi = { ...lot, id: 'KZ-ALATAU-PKK-1', geometry: { type: 'MultiPolygon', coordinates: [lot.geometry.coordinates] } };
        const study = assembleParcelStudy(multi, { id: 'kz-alatau-pkk' }, [record]);
        expect(study.source.id).toBe('alatau-genplan-727:481223');
        expect(study.parcel.geometry.type).toBe('Polygon');
        const twoParts = { ...multi, geometry: { type: 'MultiPolygon', coordinates: [lot.geometry.coordinates, turf.bboxPolygon([76.9703, 43.4125, 76.9704, 43.4126]).geometry.coordinates] } };
        expect(() => assembleParcelStudy(twoParts, { id: 'kz-alatau-pkk' }, [record])).toThrow('unsupported-parcel-shape');
    });
});
