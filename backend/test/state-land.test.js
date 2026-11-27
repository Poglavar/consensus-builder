// State land layers (frontend/js/state-land.js): cadastre requests through the relay, page checks,
// projection to WGS84 and the reading of each record's procedure status.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import proj4 from 'proj4';

const require = createRequire(import.meta.url);
const StateLand = require('../../frontend/js/state-land.js');

const config = StateLand.normalizeConfig({ provider: 'kazakhstan-pkk', relaySourceId: 'kz-alatau-pkk', districtId: 364, zone: 13 });
const square = (x, y, size) => ({ type: 'MultiPolygon', coordinates: [[[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]] });

describe('state land configuration and requests', () => {
    it('accepts only a complete Kazakhstan PKK block', () => {
        expect(config).toEqual({ provider: 'kazakhstan-pkk', relaySourceId: 'kz-alatau-pkk', districtId: 364, zone: 13 });
        expect(StateLand.normalizeConfig({ provider: 'kazakhstan-pkk', relaySourceId: 'kz-alatau-pkk', districtId: 364 })).toBeNull();
        expect(StateLand.normalizeConfig({ provider: 'other', relaySourceId: 'x', districtId: 1, zone: 13 })).toBeNull();
        expect(StateLand.normalizeConfig(undefined)).toBeNull();
    });

    it('reads each view in the district with only its named fields, through the source relay', () => {
        const free = new URL(StateLand.viewUrl(config, 'free', { startIndex: 1000 }));
        expect(free.origin + free.pathname).toBe('https://map.gov4c.kz/geoserver/egkn/freelands_view/wfs');
        expect(Object.fromEntries(free.searchParams)).toMatchObject({
            typename: 'egkn:freelands_view', propertyname: 'gid,id,usedesc_ru,create_time,update_time,auction_land_status_id,geom',
            viewparams: 'district_id:364', startIndex: '1000', count: '1000', sortBy: 'gid'
        });
        const applications = new URL(StateLand.viewUrl(config, 'applications'));
        expect(applications.origin + applications.pathname).toBe('https://map.gov4c.kz/geoserver/egkn/reqland_view/wfs');
        expect(applications.searchParams.get('typename')).toBe('egkn:reqland_view');
        expect(applications.searchParams.get('propertyname')).toBe('gid,id,usedesc_ru,create_time,update_time,status_land_id,geom');
        expect(() => StateLand.viewUrl(config, 'registered')).toThrow(/Unknown/);

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

describe('procedure status', () => {
    it('reads each view\'s own status field against the cadastre legend', () => {
        // Alatau, 2026: application status 100 is the akimat's resolution; free plot 03341720260221000001 was refused on review.
        expect(StateLand.statusOf('applications', { status_land_id: 100 })).toEqual({ code: 100, stage: 'granted', label: 'Постановление МИО выдано' });
        expect(StateLand.statusOf('free', { auction_land_status_id: '25' })).toEqual({ code: 25, stage: 'stopped', label: 'Отказано при рассмотрении заявления' });
        expect(StateLand.statusOf('free', { auction_land_status_id: 94 }).stage).toBe('granted');
        expect(StateLand.statusOf('applications', { status_land_id: 120 }).stage).toBe('registered');
        // The application field is not the free plots' field.
        expect(StateLand.statusOf('free', { status_land_id: 100 })).toEqual({ code: null, stage: 'pending', label: null });
    });

    it('keeps codes missing from the legend unknown, never guessed', () => {
        expect(StateLand.statusOf('applications', { status_land_id: 57 })).toEqual({ code: 57, stage: 'unknown', label: null });
        expect(StateLand.statusOf('applications', { status_land_id: null })).toEqual({ code: null, stage: 'unknown', label: null });
        expect(StateLand.statusOf('free', { auction_land_status_id: 'x' })).toEqual({ code: null, stage: 'unknown', label: null });
        for (const table of Object.values(StateLand.STATUSES)) {
            for (const entry of Object.values(table)) expect(StateLand.STAGES).toContain(entry.stage);
        }
    });

    it('projects native zone 13 metres to WGS84 and keeps only the shown fields', () => {
        const project = proj4(StateLand.projectionDefinition(13), 'EPSG:4326').forward;
        const feature = StateLand.toDisplayFeature({ geometry: square(13668000, 4855000, 100), properties: {
            gid: 15282, id: '03341720260221000001', usedesc_ru: ' ЛПХ ', create_time: '2026-02-21T08:00:00Z',
            update_time: '2026-04-22T12:28:16.709Z', auction_land_status_id: 25, seller_iin: '123'
        } }, 'free', project);
        const [lon, lat] = feature.geometry.coordinates[0][0][0];
        expect(lon).toBeGreaterThan(76.5); expect(lon).toBeLessThan(77.5);
        expect(lat).toBeGreaterThan(43.5); expect(lat).toBeLessThan(44);
        expect(feature.properties).toEqual({
            kind: 'free', gid: 15282, id: '03341720260221000001', use: 'ЛПХ', listedOn: '2026-02-21',
            statusCode: 25, stage: 'stopped', statusLabel: 'Отказано при рассмотрении заявления', statusOn: '2026-04-22'
        });
        const counts = StateLand.summarize([feature, { properties: { kind: 'free', stage: 'granted' } }, { properties: { kind: 'application', stage: 'pending' } }]);
        expect(counts.free).toMatchObject({ total: 2, stopped: 1, granted: 1 });
        expect(counts.application).toMatchObject({ total: 1, pending: 1 });
    });
});
