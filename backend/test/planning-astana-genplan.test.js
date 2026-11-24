import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bbox, pointOnFeature } from '@turf/turf';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { astanaGenplanSource } from '../planning/providers/astana-genplan.js';
import { getPlanningSources, planningRecord, planningRepresentations } from '../planning/sources.js';
import { loadParcelEnvelopes } from '../planning/parcel-envelopes.js';
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
            capabilities: { areas: true, volumes: false, constraintEvaluation: false }
        });
        const read = path => readFileSync(new URL(path, import.meta.url));
        const snapshot = JSON.parse(gunzipSync(read(`../planning/data/${snapshotFilename}`)));
        const overview = JSON.parse(read(`../../frontend/data/planning/${source}-overview.json`));
        expect(overview).toMatchObject({ sourceId: source, bbox: bbox(snapshot) });
        expect(overview.zones).toHaveLength(12914);
        expect(overview.zones.map(([id]) => id)).toEqual(snapshot.features.map(feature => String(feature.id)));
        expect(overview.uses.every(use => use.group && use.status === null && !use.landBasis)).toBe(true);
    });

    it('returns the original housing class and full geometry without generating permitted constraints', async () => {
        const { items: [record] } = await planningRecord(null, { source, city, recordId });
        expect(record).toMatchObject({
            id: `${source}:${recordId}`, authority: { effect: 'unknown' },
            assessment: { meaning: 'zoning-area', status: null }, volumes: [], constraints: [],
            metrics: { heightM: null }, use: { key: 'residential-mid', group: 'housing-mid', stage: 'planned' },
            sourceEvidence: { properties: { functional: 'Территория среднеэтажной жилой застройки(3-4 этажей)' },
                rules: { snapshotDate: edition, revisionVerification: 'unverified' } }
        });
        expect(record.landBasis).toBeUndefined();
        const bounds = bbox(record.site);
        const page = await planningRepresentations(null, { source, city, bbox: bounds, limit: 1000 });
        expect(page.items.find(item => item.id === record.id)).toEqual(record);
        await expect(loadParcelEnvelopes({ source, city, bbox: bounds }, { sources: getPlanningSources() }))
            .rejects.toMatchObject({ code: 'study-unavailable' });
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
