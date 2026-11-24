import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bbox, bboxPolygon, pointOnFeature } from '@turf/turf';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { astanaGenplanSource, interpretAstanaZone } from '../planning/providers/astana-genplan.js';
import { getPlanningSources, planningRecord, planningRepresentations } from '../planning/sources.js';
import { loadParcelEnvelopes } from '../planning/parcel-envelopes.js';
import { loadParcelStudy } from '../planning/parcel-study.js';
import { setupPlanningRoutes } from '../routes/planning.js';
import { sourceSystemCatalogue } from '../routes/source-system.js';

const { id: source, city, edition, snapshotFilename } = astanaGenplanSource;
const recordId = '362036';

describe('Astana general plan reference', () => {
    it('registers the adapter and preserves all snapshot IDs in the whole-plan overview', () => {
        const family = sourceSystemCatalogue().abstractions.find(item => item.id === 'planning');
        expect(family.sources.find(item => item.id === source)).toMatchObject({ adapter: 'astana-genplan' });
        expect(getPlanningSources().find(p => p.descriptor.id === source).descriptor).toMatchObject({
            kind: 'reference', edition, zoningOverview: { detailZoom: 15 },
            parcelSourceId: 'kz-astana-pkk-esil', parcelStudy: 'direct-dimensions.v1',
            capabilities: { areas: true, volumes: false, constraintEvaluation: false }
        });
        const read = path => readFileSync(new URL(path, import.meta.url));
        const snapshot = JSON.parse(gunzipSync(read(`../planning/data/${snapshotFilename}`)));
        const overview = JSON.parse(read(`../../frontend/data/planning/${source}-overview.json`));
        expect(overview).toMatchObject({ sourceId: source, bbox: bbox(snapshot) });
        expect(overview.zones).toHaveLength(12914);
        expect(overview.zones.map(([id]) => id)).toEqual(snapshot.features.map(feature => String(feature.id)));
        expect(overview.uses.every(use => use.group && !use.landBasis)).toBe(true);
        expect(new Set(overview.uses.map(use => use.status))).toEqual(new Set(['allowed', 'instrument_handoff', null]));
    });

    it('returns the original housing class, dated source evidence, and the derived height', async () => {
        const { items: [record] } = await planningRecord(null, { source, city, recordId });
        expect(record).toMatchObject({
            id: `${source}:${recordId}`, authority: { effect: 'unknown' },
            assessment: { meaning: 'zoning-area', status: 'allowed' }, volumes: [],
            constraints: [{ quantity: 'storeys', value: 4, evidence: 'direct', bound: 'maximum' },
                { quantity: 'height', value: 12, evidence: 'derived', derivation: '4 × 3 m' }],
            metrics: { heightM: 12 }, use: { key: 'residential-mid', group: 'housing-mid', stage: 'planned' },
            sourceEvidence: { properties: { functional: 'Территория среднеэтажной жилой застройки(3-4 этажей)' },
                rules: { snapshotDate: edition, revisionVerification: 'unverified' } }
        });
        expect(record.landBasis).toBeUndefined();
        const bounds = bbox(record.site);
        const page = await planningRepresentations(null, { source, city, bbox: bounds, limit: 1000 });
        expect(page.items.find(item => item.id === record.id)).toEqual(record);
    });

    it.each([
        [11010000, 'Территория усадебной жилой застройки (1-3 этажа)', 9, 'allowed'],
        [11040000, 'Территория многоэтажной жилой застройки(5-9 этажей)', 27, 'allowed'],
        [11040000, 'Территория повышенной этажности жилой застройки(10-17 этажей)', 51, 'allowed'],
        [11040000, 'Территория высотной жилой застройки (от 18 и более этажей)', null, 'instrument_handoff'],
        [11050000, 'Территория общеобразовательных учреждений', null, null],
    ])('reads only the stated upper storey count for %s %s', (code, functional, heightM, status) => {
        const reading = interpretAstanaZone({ usl_i32: code, functional });
        expect(reading).toMatchObject({ heightM, status });
        expect(reading.constraints.map(rule => rule.quantity)).toEqual(heightM === null ? [] : ['storeys', 'height']);
    });

    it('builds a parcel envelope from the dated zone and keeps its provenance in the parcel study', async () => {
        const bounds = [71.42536, 51.12516, 71.42545, 51.12525];
        const parcel = { ...bboxPolygon(bounds), id: 'KZ-ASTANA-PKK-test', properties: { parcelNumber: 'test' } };
        const parcelProvider = descriptor => {
            expect(descriptor.id).toBe('kz-astana-pkk-esil');
            const read = async () => ({ complete: true, features: [parcel] });
            return { queryBounds: read, queryIds: read };
        };
        const options = { sources: getPlanningSources(), parcelProvider };
        const { items, unavailable } = await loadParcelEnvelopes({ source, city, bbox: bounds }, options);
        expect(unavailable).toEqual([]);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            parcelEnvelope: true, source: { id: source, edition, parcel: parcel.id },
            volumes: [{ baseM: 0, topM: 27 }],
            metrics: { heightM: 27 },
            sourceEvidence: { zoningRecordId: '364149', rules: {
                snapshotDate: edition, revisionVerification: 'unverified', redLineDecree: '№ 33 от 25.01.2024', storeyHeightM: 3
            } }
        });
        const study = await loadParcelStudy({ source, city, parcel: parcel.id }, options);
        expect(study).toMatchObject({
            source: { metrics: { heightM: 27 }, sourceEvidence: { rules: { snapshotDate: edition, storeyHeightM: 3 } } },
            sourceReference: { providerId: source, recordId: '364149', edition }
        });
    });

    it('uses the same exact zoning record for the MCP point lookup and design site', async () => {
        const readRecord = query => planningRecord(null, query);
        const { items: [record] } = await readRecord({ source, city, recordId });
        const [lon, lat] = pointOnFeature(record.site).geometry.coordinates;
        const endpoints = new Map();
        setupPlanningRoutes({ get: (path, fn) => endpoints.set(path, fn), post() {} }, null);
        const reply = { set() { return this; }, json(answer) { this.body = answer; } };
        await endpoints.get('/planning/areas')({ query: { city, source, lon: String(lon), lat: String(lat) } }, reply);
        expect(reply.body.items.map(item => item.planningArea)).toContainEqual({ source, recordId });

        const read = { siteOfDesign: design => design.site, request: (path, query) => path === '/planning/record'
            ? readRecord(query) : { binding: { coverage: 'complete', parcels: [] } } };
        const tools = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
        const result = await tools.draftParcelLayout({ city, planningArea: { source, recordId }, algorithm: 'equal', count: 2 });
        expect(result.design.site).toEqual(record.site);
        expect(result.design.sourceReferences[0]).toMatchObject({ providerId: source, recordId, edition });
    });
});
