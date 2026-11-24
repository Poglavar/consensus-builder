import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bbox, bboxPolygon } from '@turf/turf';
import { almatyDetailedPlanSource, interpretAlmatyDetailedZone } from '../planning/providers/almaty-detailed-plan.js';
import { getPlanningSources, planningRecord } from '../planning/sources.js';
import { loadParcelEnvelopes } from '../planning/parcel-envelopes.js';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { sourceSystemCatalogue } from '../routes/source-system.js';
import { parseCityConfigs } from '../../scripts/lib/city-configs.mjs';

const { id: source, city, edition, snapshotFilename } = almatyDetailedPlanSource;
const read = path => readFileSync(new URL(path, import.meta.url));
const recordId = '656373';

describe('Almaty detailed plans', () => {
    it('registers the configured source and preserves all three detailed plans in the overview', () => {
        const config = parseCityConfigs(read('../../frontend/data/city-configs.js').toString());
        expect(config.almaty.planning.sourceIds).toEqual([source]);
        const family = sourceSystemCatalogue().abstractions.find(item => item.id === 'planning');
        expect(family.sources.find(item => item.id === source)).toMatchObject({ adapter: 'kz-detailed-plan' });
        const snapshot = JSON.parse(gunzipSync(read(`../planning/data/${snapshotFilename}`)));
        const overview = JSON.parse(read(`../../frontend/data/planning/${source}-overview.json`));
        expect(overview).toMatchObject({ sourceId: source, bbox: bbox(snapshot) });
        expect(overview.zones).toHaveLength(1856);
        expect(overview.zones.map(([id]) => id)).toEqual(snapshot.features.map(feature => String(feature.id)));
        expect(new Set(snapshot.features.map(feature => feature.properties.pdp_name)).size).toBe(3);
        expect(snapshot.features.filter(feature => interpretAlmatyDetailedZone(feature.properties).heightM).length).toBe(94);
    });

    it('uses the detailed plan’s local height wording over the generic class', async () => {
        const { items: [record] } = await planningRecord(null, { source, city, recordId });
        expect(record).toMatchObject({
            id: `${source}:${recordId}`, authority: { effect: 'unknown' },
            assessment: { meaning: 'zoning-area', status: 'allowed' },
            constraints: [{ quantity: 'storeys', value: 9, evidence: 'direct' },
                { quantity: 'height', value: 27, evidence: 'derived' }],
            sourceEvidence: { properties: { pdp_name: expect.stringMatching(/^ПДП /),
                functional: expect.stringContaining('6-9'), name_usl: expect.stringContaining('6-12') },
                rules: { snapshotDate: edition, publishedApproval: 'unrecorded', storeyHeightM: 3 } }
        });
        expect(interpretAlmatyDetailedZone({ usl_i32: 11040002, functional: 'Зона жилой застройки 13 и выше этажей' }))
            .toMatchObject({ status: 'instrument_handoff', heightM: null, constraints: [] });
        expect(interpretAlmatyDetailedZone({ usl_i32: 11010001, functional: 'Зона усадебной застройки', implementation: 'Cуществующие' }))
            .toMatchObject({ stage: 'existing', heightM: null, constraints: [] });
    });

    it('derives an envelope over a municipal parcel and exposes the same exact site to MCP', async () => {
        const box = [76.86782, 43.17995, 76.86788, 43.17999];
        const parcel = { ...bboxPolygon(box), id: 'KZ-ALMATY-GZK-test', properties: { parcelNumber: 'test' } };
        const parcelProvider = descriptor => {
            expect(descriptor.id).toBe('kz-almaty-mapalmaty-gzk');
            return { queryBounds: async () => ({ complete: true, features: [parcel] }) };
        };
        const result = await loadParcelEnvelopes({ source, city, bbox: box }, { sources: getPlanningSources(), parcelProvider });
        expect(result.items).toMatchObject([{ parcelEnvelope: true, source: { id: source, parcel: parcel.id },
            volumes: [{ baseM: 0, topM: 27 }], sourceEvidence: { zoningRecordId: recordId, rules: { snapshotDate: edition } } }]);
        const readRecord = query => planningRecord(null, query);
        const { items: [record] } = await readRecord({ source, city, recordId });
        const read = { siteOfDesign: design => design.site, request: (path, query) => path === '/planning/record'
            ? readRecord(query) : { binding: { coverage: 'complete', parcels: [] } } };
        const tools = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
        const draft = await tools.draftParcelLayout({ city, planningArea: { source, recordId }, algorithm: 'equal', count: 2 });
        expect(draft.design.site).toEqual(record.site);
        expect(draft.design.sourceReferences[0]).toMatchObject({ providerId: source, recordId, edition });
    });
});
