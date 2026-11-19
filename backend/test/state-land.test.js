// State land layers (frontend/js/state-land.js): cadastre requests through the relay, page checks,
// projection to WGS84 and the rule that marks a free state plot granted.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import proj4 from 'proj4';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const StateLand = require('../../frontend/js/state-land.js');

const config = StateLand.normalizeConfig({ provider: 'kazakhstan-pkk', relaySourceId: 'kz-alatau-pkk', districtId: 364, zone: 13 });
const square = (x, y, size) => ({ type: 'MultiPolygon', coordinates: [[[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]] });
const intersectArea = (a, b) => {
    const overlap = turf.intersect(turf.feature(a), turf.feature(b));
    return overlap ? StateLand.planarArea(overlap.geometry) : 0;
};
const plot = (geometry, createTime = '2026-02-21T08:00:00Z') => ({ geometry, properties: { gid: 1, id: '03341720260221000001', create_time: createTime } });
const parcel = (geometry, cdate, kad = '033411462579') => ({ geometry, properties: { gid: 2, kad_nomer: kad, cdate } });

describe('state land configuration and requests', () => {
    it('accepts only a complete Kazakhstan PKK block', () => {
        expect(config).toEqual({ provider: 'kazakhstan-pkk', relaySourceId: 'kz-alatau-pkk', districtId: 364, zone: 13 });
        expect(StateLand.normalizeConfig({ provider: 'kazakhstan-pkk', relaySourceId: 'kz-alatau-pkk', districtId: 364 })).toBeNull();
        expect(StateLand.normalizeConfig({ provider: 'other', relaySourceId: 'x', districtId: 1, zone: 13 })).toBeNull();
        expect(StateLand.normalizeConfig(undefined)).toBeNull();
    });

    it('reads each view in the district with only its named fields, through the source relay', () => {
        const free = new URL(StateLand.viewUrl(config, 'free', { startIndex: 1000 }));
        expect(free.origin + free.pathname).toBe('https://map.gov4c.kz/geoserver/wfs');
        expect(Object.fromEntries(free.searchParams)).toMatchObject({
            typename: 'egkn:freelands_view', propertyname: 'gid,id,usedesc_ru,create_time,geom',
            viewparams: 'district_id:364', startIndex: '1000', count: '1000', sortBy: 'gid'
        });
        expect(free.searchParams.has('bbox')).toBe(false);
        const registered = new URL(StateLand.viewUrl(config, 'registered', { bbox: [1, 2, 3, 4] }));
        expect(registered.searchParams.get('typename')).toBe('egkn:u_view');
        expect(registered.searchParams.get('propertyname')).toBe('gid,kad_nomer,cdate,geom');
        expect(registered.searchParams.get('bbox')).toBe('1,2,3,4');
        expect(new URL(StateLand.viewUrl(config, 'applications')).searchParams.get('typename')).toBe('egkn:reqland_view');
        expect(() => StateLand.viewUrl(config, 'owners')).toThrow(/Unknown/);

        const relay = new URL(StateLand.relayUrl('https://api.example.test/', config, free.href));
        expect(relay.origin + relay.pathname).toBe('https://api.example.test/parcel-provider-relay/kz-alatau-pkk');
        expect(relay.searchParams.get('url')).toBe(free.href);
        expect(relay.searchParams.get('referer')).toBe('https://map.gov4c.kz/egkn/');
    });

    it('pages until the reported match count and refuses short or malformed pages', () => {
        const page = (features, matched) => ({ type: 'FeatureCollection', features, numberMatched: matched });
        expect(StateLand.readPage(page([{}, {}], 3), 0).next).toBe(2);
        expect(StateLand.readPage(page([{}], 3), 2).next).toBeNull();
        expect(() => StateLand.readPage(page([], 3), 2)).toThrow(/ended/);
        expect(() => StateLand.readPage(page([{}, {}], 1), 0)).toThrow(/incomplete/);
        expect(() => StateLand.readPage({ features: [] }, 0)).toThrow(/incomplete/);
    });
});

describe('granted free plots', () => {
    const plotGeometry = square(13668000, 4855000, 100);

    it('marks a plot granted when a parcel registered after its listing covers it', () => {
        // Alatau, 2026: plot 03341720260221000001 listed on 21 February; parcel 033411462579 registered over 99% of it on the 23rd.
        const grant = StateLand.grantOf(plot(plotGeometry), [parcel(square(13668000, 4855001, 100), '2026-02-23T18:00:00Z')], intersectArea);
        expect(grant).toEqual({ status: 'granted', parcelNumber: '033411462579', registeredOn: '2026-02-23' });
    });

    it('keeps a plot listed when the covering parcel predates the listing or covers too little', () => {
        expect(StateLand.grantOf(plot(plotGeometry), [parcel(plotGeometry, '2025-01-10T00:00:00Z')], intersectArea)).toEqual({ status: 'listed' });
        expect(StateLand.grantOf(plot(plotGeometry), [parcel(square(13668000, 4855000, 80), '2026-03-01T00:00:00Z')], intersectArea))
            .toEqual({ status: 'listed' });
        expect(StateLand.grantOf(plot(plotGeometry, null), [parcel(plotGeometry, '2026-03-01T00:00:00Z')], intersectArea)).toEqual({ status: 'listed' });
        expect(StateLand.grantOf(plot(plotGeometry), [parcel(plotGeometry, '2026-03-01T00:00:00Z')], () => null)).toEqual({ status: 'listed' });
    });

    it('projects native zone 13 metres to WGS84 and keeps only the shown fields', () => {
        const project = proj4(StateLand.projectionDefinition(13), 'EPSG:4326').forward;
        const feature = StateLand.toDisplayFeature({ geometry: plotGeometry, properties: {
            gid: 15282, id: '03341720260221000001', usedesc_ru: ' ЛПХ ', create_time: '2026-02-21T08:00:00Z', seller_iin: '123'
        } }, 'free', project, { status: 'listed' });
        const [lon, lat] = feature.geometry.coordinates[0][0][0];
        expect(lon).toBeGreaterThan(76.5); expect(lon).toBeLessThan(77.5);
        expect(lat).toBeGreaterThan(43.5); expect(lat).toBeLessThan(44);
        expect(feature.properties).toEqual({ kind: 'free', gid: 15282, id: '03341720260221000001', use: 'ЛПХ', listedOn: '2026-02-21', status: 'listed' });
        expect(StateLand.summarize([feature, { properties: { kind: 'free', status: 'granted' } }, { properties: { kind: 'application' } }]))
            .toEqual({ free: 1, granted: 1, applications: 1 });
    });
});
