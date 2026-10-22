// The node host runs actual app handlers: closed ground conserves area and hashes the final pieces.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { deriveAgreementGround } from '../agents/mcp-ground.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { cidOfObject } from '../cid.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const links = require('../../frontend/js/draft-link.js');
const site = { type: 'Polygon', coordinates: [[[-0.1, 51.5], [-0.099, 51.5], [-0.099, 51.501], [-0.1, 51.501], [-0.1, 51.5]]] };
const parcels = [{ type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site }];
const make = (kind, extra = {}) => {
    const content = builder.build({ kind, site, city: 'london', authoredAt: '2026-10-23T00:00:00.000Z', ...extra }, { turf });
    return { content, cid: cidOfObject(content), parcelIds: ['A'] };
};
describe('headless app formation host', () => {
    for (const design of [make('space', { spaceKind: 'park' }), make('building', { floors: 4 }), make('parcel-layout', { algorithm: 'equal', count: 4 })]) {
        it(`derives ${design.content.goal} from the same app handlers without losing ground`, async () => {
            const derived = await deriveAgreementGround({ designs: [design], parcels });
            expect(derived.inputs.parcels.map(p => p.parcelId)).toEqual(['A']);
            expect(derived.outputs.reduce((sum, output) => sum + output.areaM2, 0)).toBeCloseTo(turf.area(parcels[0]), 2);
            const record = require('../../frontend/js/agreement-record.js');
            expect(derived.outputs.every(output => output.hash === record.outputHash(output.geometry))).toBe(true);
            if (design.content.parcelLayout) expect(derived.outputs.filter(o => o.role === 'plot')).toHaveLength(4);
        });
    }
    it('creates a community agreement, counts money in the city currency and previews its exact artifact', async () => {
        const design = make('space', { spaceKind: 'park' });
        const paths = [];
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async (url) => {
            const path = new URL(url).pathname; paths.push(path);
            return new Response(JSON.stringify(path === '/designs/binding'
                ? { binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unsurveyedM2: 0, unknownM2: 0 } }
                : { complete: true, features: parcels }));
        } });
        const result = await tools.draftAgreement({ designs: [design.content], parcelSourceId: 'test', title: 'A park' });
        expect(result.cid).toBe(cidOfObject(result.agreement));
        expect(result.agreement.money).toEqual({ currency: 'GBP', lines: [] });
        expect(result.agreement.rule.binding).toBe(false);
        const artifact = await links.parse(new URL(result.previewUrl).hash);
        expect(artifact.agreement).toEqual(result.agreement);
        expect(paths).not.toContain('/pins');
        expect(paths).not.toContain('/agreements');
    });
});
