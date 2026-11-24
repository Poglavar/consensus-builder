import { describe, expect, it } from 'vitest';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { readZagrebRecord } from '../planning/providers/zagreb-gup.js';
import { area } from '@turf/turf';

const id = '000430f3ec13c828d392ad837a17e96be4d4c53f63854e5ccf55a9f2b2f42a49';
describe('MCP planning-area parity', () => {
    it('drafts four covering plots from an exact planning area and preserves its source reference', async () => {
        const [record] = await readZagrebRecord({}, { recordId: id, edition: '2025' });
        const read = { siteOfDesign: design => design.site, request: async path => path === '/planning/record' ? { items: [record] } : { binding: { coverage: 'complete', parcels: [] } } };
        const tools = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
        const result = await tools.draftParcelLayout({ city: 'zagreb', planningArea: { source: 'zagreb-gup-2025', recordId: id }, algorithm: 'equal', count: 4 });
        expect(result.design.parcelLayout.plots).toHaveLength(4);
        expect(result.design.sourceReferences).toHaveLength(1);
        expect(result.design.sourceReferences[0].recordId).toBe(id);
        const site = record.site.type === 'Polygon' ? { type: 'MultiPolygon', coordinates: [record.site.coordinates] } : record.site;
        expect(result.design.site).toEqual(site);
        expect(result.design.parcelLayout.plots.reduce((m2, plot) => m2 + area(plot.geometry), 0)).toBeCloseTo(area(site), 0);
    });
    it('can draft on the plan boundary while the cadastral source is unavailable', async () => {
        const [record] = await readZagrebRecord({}, { recordId: id, edition: '2025' });
        const read = { siteOfDesign: design => design.site, request: async path => {
            if (path === '/planning/record') return { items: [record] };
            throw new Error('Cadastral source unavailable');
        } };
        const tools = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
        const result = await tools.draftParcelLayout({ city: 'zagreb', planningArea: { source: 'zagreb-gup-2025', recordId: id }, algorithm: 'equal', count: 2 });
        expect(result.binding).toBeNull();
        expect(result).not.toHaveProperty('takes');
        expect(result.design.sourceReferences[0].recordId).toBe(id);
    });
    it('rejects conflicting and unavailable planning-area inputs', async () => {
        const read = { request: async path => path === '/planning/record' ? { items: [] } : { binding: { coverage: 'complete', parcels: [] } } };
        const tools = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
        await expect(tools.draftParcelLayout({ city: 'zagreb', planningArea: { source: 'zagreb-gup-2025', recordId: id }, outline: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,0]]] }, algorithm: 'equal', count: 4 })).rejects.toMatchObject({ code: 'site-ambiguous' });
        await expect(tools.draftParcelLayout({ city: 'zagreb', planningArea: { source: 'zagreb-gup-2025', recordId: 'missing' }, algorithm: 'equal', count: 4 })).rejects.toMatchObject({ code: 'planning-area-unavailable' });
    });
});
