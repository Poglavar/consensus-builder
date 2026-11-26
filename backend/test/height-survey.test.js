// Heights measured on demand from a height survey (frontend/js/buildings/height-survey.js): the
// GeoTIFF reader on a real Environment Agency answer, the estimator against cadastre-data's Python
// raster tier on the same cells, the no-height cases, and the retry that notices a hung request.
// Fixtures: a 27 m × 27 m window of the EA 1 m surface and terrain maps around one house on
// Highbury Station Road, London (Open Government Licence, © Environment Agency).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const survey = require('../../frontend/js/buildings/height-survey.js');
const terms = require('../../frontend/js/planning/rule-terms.js');
const config = require('../../frontend/data/height-surveys.json');
const proj4 = require('proj4');
import { parcelRestrictions } from '../planning/restrictions.js';

const fixture = name => readFileSync(new URL(`./fixtures/height-survey/${name}.tif`, import.meta.url));
const SURFACE = fixture('surface'), TERRAIN = fixture('terrain');
const EA = config.surveys[0];
const toWgs = proj4(EA.proj4, 'EPSG:4326');
// The house as OpenStreetMap draws it (way 31026824). cadastre-data's 01_heights raster tier on the
// same cells: ridge 9.1646 m, eave 8.4620 m, high confidence.
const HOUSE = { id: 'house', geometry: { type: 'Polygon', coordinates: [[[-0.1072251, 51.545037], [-0.107099, 51.5450654], [-0.1070516, 51.5449841], [-0.1071777, 51.5449556], [-0.1072251, 51.545037]]] } };
// A footprint drawn on the garden in the window's top-left corner, where nothing stands.
const metricRect = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(c => toWgs.forward(c))] });
const GARDEN = { id: 'garden', geometry: metricRect(531341.5, 184606, 531348.5, 184612.5) };

// A fetch that serves the fixtures by coverage id and an empty date index.
const answer = (body, status = 200) => ({ ok: status < 400, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), json: async () => body });
const fixtureFetch = (calls = []) => async url => {
    calls.push(url);
    if (url.includes(EA.surface.coverageId)) return answer(SURFACE);
    if (url.includes(EA.terrain.coverageId)) return answer(TERRAIN);
    return answer({ features: [{ type: 'Feature', properties: { sd_flown: '2017-12-07T00:00:00Z', ed_flown: '2018-01-24T00:00:00Z' },
        geometry: { type: 'Polygon', coordinates: [[[-0.2, 51.5], [0, 51.5], [0, 51.6], [-0.2, 51.6], [-0.2, 51.5]]] } }] });
};
const measurer = (fetchImpl, options = {}) => survey.createMeasurer({ surveys: config.surveys, proj4, fetchImpl, ...options });

describe('height survey', () => {
    it('reads the georeference and no-data of a WCS GeoTIFF', () => {
        const raster = survey.readGeoTiff(SURFACE);
        expect(raster).toMatchObject({ width: 27, height: 27, pixel: 1, minx: 531341, maxy: 184613 });
        expect(raster.values.every(Number.isFinite)).toBe(true);
        expect(survey.sample(raster, 531000, 184600)).toBeNaN();
    });

    it('measures a house as the Python raster tier does, with its survey and flight dates', async () => {
        const results = await measurer(fixtureFetch()).measure([HOUSE]);
        const house = results.get('house');
        expect(house.heightM).toBeCloseTo(9.1646, 2);
        expect(house.eaveM).toBeCloseTo(8.4620, 2);
        expect(house).toMatchObject({ confidence: 'high', survey: { id: EA.id }, surveyedFrom: '2017-12-07', surveyedTo: '2018-01-24' });
    });

    it('gives no height where the survey sees no building, and none outside every survey', async () => {
        const zagreb = { id: 'zagreb', geometry: { type: 'Polygon', coordinates: [[[15.97, 45.81], [15.9701, 45.81], [15.9701, 45.8101], [15.97, 45.81]]] } };
        const results = await measurer(fixtureFetch()).measure([GARDEN, zagreb]);
        expect(results.get('garden')).toMatchObject({ rejection: 'no-building-seen' });
        expect(results.get('garden').heightM).toBeUndefined();
        expect(results.get('zagreb')).toEqual({ rejection: 'outside-surveys' });
    });

    it('notices a hung request and asks again', async () => {
        let hung = 0;
        const serve = fixtureFetch();
        const fetchImpl = (url, { signal }) => {
            // The first surface request never answers; only its timeout ends it.
            if (url.includes(EA.surface.coverageId) && hung++ === 0) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
            return serve(url);
        };
        const started = Date.now();
        const results = await measurer(fetchImpl, { attemptMs: 100 }).measure([HOUSE]);
        expect(hung).toBe(2);
        expect(results.get('house').heightM).toBeCloseTo(9.1646, 2);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it('stops after the last attempt and reports the survey unavailable, without caching the failure', async () => {
        let calls = 0;
        const down = async url => { calls++; return url.includes('ogc/features') ? answer({ features: [] }) : answer(Buffer.from(''), 503); };
        const heights = measurer(down, { attempts: 3 });
        expect((await heights.measure([HOUSE])).get('house')).toMatchObject({ rejection: 'survey-unavailable' });
        expect(calls).toBe(3 + 3 + 1);
        await heights.measure([HOUSE]);
        expect(calls).toBeGreaterThan(7);
    });

    it('does not retry a request the service refuses', async () => {
        let calls = 0;
        const refusing = async () => { calls++; return answer(Buffer.from(''), 400); };
        await expect(survey.fetchPatiently('https://example.test/wcs', { fetchImpl: refusing, attempts: 5 })).rejects.toMatchObject({ code: 'refused' });
        expect(calls).toBe(1);
    });

    it('measures each building once per session', async () => {
        const calls = [];
        const heights = measurer(fixtureFetch(calls));
        await heights.measure([HOUSE]);
        const first = calls.length;
        await heights.measure([HOUSE]);
        expect(calls.length).toBe(first);
    });

    it('makes a measured height known to relative rule terms', async () => {
        const result = (await measurer(fixtureFetch()).measure([HOUSE])).get('house');
        const entry = { id: 'house', geometry: HOUSE.geometry, height_m: null, floors: null };
        expect(terms.buildingHeight(entry).known).toBe(false);
        const measured = terms.buildingHeight(survey.withMeasuredHeight(entry, result));
        expect(measured).toMatchObject({ known: true, source: 'measured' });
        expect(measured.heightM).toBeCloseTo(9.16, 2);
        const parcel = turf.buffer(turf.feature(HOUSE.geometry), 3, { units: 'meters' });
        const context = terms.existingContext({ parcel, buildings: [survey.withMeasuredHeight(entry, result)], geometryOps: turf });
        expect(terms.evaluate({ of: 'existingHeight', add: 1, addUnit: 'storeys' }, context, { storeyHeightM: 3 }).value).toBeCloseTo(12.16, 2);
    });

    // The best measure available: the survey's height replaces a tagged height and storeys × 3 m (the
    // house is 2 storeys in this entry, 6 m), keeps the storey count, and the source's height stands
    // where the survey sees no building.
    it('puts the survey\'s height in place of a tagged or storey height, and keeps the source\'s where it has none', async () => {
        const storeys = { id: 'house', geometry: HOUSE.geometry, height_m: null, floors: 2 };
        const tagged = { id: 'tagged', geometry: HOUSE.geometry, height_m: 12, floors: null };
        const garden = { id: 'garden', geometry: GARDEN.geometry, height_m: null, floors: 2 };
        expect(terms.buildingHeight(storeys)).toMatchObject({ known: true, source: 'levels', heightM: 6 });
        const [house, tag, empty] = await survey.withSurveyedHeights(measurer(fixtureFetch()), [storeys, tagged, garden]);
        expect(terms.buildingHeight(house)).toMatchObject({ known: true, source: 'measured', survey: { id: EA.id } });
        expect(terms.buildingHeight(house).heightM).toBeCloseTo(9.16, 2);
        expect(house.floors).toBe(2);
        expect(terms.buildingHeight(tag).heightM).toBeCloseTo(9.16, 2);
        expect(empty).toBe(garden);
        expect(terms.buildingHeight(empty)).toMatchObject({ source: 'levels', heightM: 6 });
    });

    // MCP parity: an agent's parcel context (backend/planning/restrictions.js) measures the same way.
    it('gives an agent the measured height in an English parcel\'s existing context', async () => {
        const serve = fixtureFetch();
        const fetchImpl = async url => {
            const parsed = new URL(url);
            if (parsed.host !== 'www.planning.data.gov.uk') return serve(url);
            if (parsed.pathname === '/entity.geojson') return answer({ type: 'FeatureCollection', features: [] });
            return answer({ entities: [], links: {} });
        };
        const parcel = turf.buffer(turf.feature(HOUSE.geometry), 3, { units: 'meters' });
        const result = await parcelRestrictions({ city: 'london', parcel, buildings: [{ id: 'way/31026824', geometry: HOUSE.geometry, height_m: null, floors: 2 }], fetchImpl });
        expect(result.existing.heightM).toBeCloseTo(9.16, 2);
        expect(result.existing.buildings[0]).toMatchObject({ known: true, source: 'measured', survey: { id: EA.id, surveyedFrom: '2017-12-07' } });
    });
});
