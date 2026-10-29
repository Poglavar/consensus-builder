// The node host runs actual app handlers: closed ground conserves area and hashes the final pieces.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { deriveAgreementGround } from '../agents/mcp-ground.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { cidOfObject } from '../cid.js';
import { restatementFixture } from './fixtures/mcp-restatements.mjs';
import { registerMcpCompanion } from '../agents/mcp-companion.mjs';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const site = { type: 'Polygon', coordinates: [[[-0.1, 51.5], [-0.099, 51.5], [-0.099, 51.501], [-0.1, 51.501], [-0.1, 51.5]]] };
const parcels = [{ type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site }];
const make = (kind, extra = {}) => {
    const content = builder.build({ kind, site, city: 'london', authoredAt: '2026-10-23T00:00:00.000Z', ...extra }, { turf });
    return { content, cid: cidOfObject(content), parcelIds: ['A'] };
};
describe('headless app formation host', () => {
    it('keeps a station as attached content without forming another parcel', async () => {
        const design = make('space', { spaceKind: 'park' });
        design.content.goal = 'station'; design.content.structureProposal.kind = 'station'; design.cid = cidOfObject(design.content);
        const ground = await deriveAgreementGround({ designs: [design], parcels });
        expect(ground.outputs).toHaveLength(1);
        expect(ground.outputs[0].producedBy).toBeNull();
        expect(ground.outputs[0].fromParcelIds).toEqual(['A']);
    });
    it('forms a single freeform building with the app’s footprint-parcel rule', async () => {
        const design = make('building', { floors: 4 }); design.content.goal = 'single'; design.cid = cidOfObject(design.content);
        const ground = await deriveAgreementGround({ designs: [design], parcels });
        expect(ground.outputs.some(o => o.producedBy === design.cid)).toBe(true);
        expect(ground.outputs.reduce((sum, o) => sum + o.areaM2, 0)).toBeCloseTo(turf.area(parcels[0]), 2);
    });
    for (const key of ['borovje-official', 'borovje-blocks', 'folnegoviceva-rapska']) it(`derives the actual ${key} designs over their archived immutable source`, async () => {
        const fixture = await restatementFixture(key);
        const ground = await deriveAgreementGround(fixture);
        expect(ground.inputs.parcels.length).toBeGreaterThan(0);
        expect(ground.outputs.length).toBeGreaterThan(1);
        expect(ground.outputs.reduce((sum, piece) => sum + piece.areaM2, 0)).toBeCloseTo(ground.inputs.parcels.reduce((sum, piece) => sum + piece.areaM2, 0), 0);
        if (key.startsWith('borovje')) {
            const park = fixture.designs.find(d => d.content.title?.includes('park Z1-5'));
            expect(ground.outputs.some(o => o.producedBy === park.cid && o.fromParcelIds.includes('HR-335550-4302/4'))).toBe(true);
        }
    });
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
    it('creates a community agreement from an existing named plan and previews its exact artifact', async () => {
        const design = make('space', { spaceKind: 'park' });
        const paths = [];
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async (url) => {
            const path = new URL(url).pathname; paths.push(path);
            return new Response(JSON.stringify(path === '/designs/binding'
                ? { parcelSourceId: 'selected-source', binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unsurveyedM2: 0, unknownM2: 0 } }
                : { complete: true, features: parcels }));
        } });
        const consultation = { organiser: 'did:web:community.example', participationUrl: 'https://community.example/participate' };
        const named = await tools.draftPlan({ designs: [design.content], title: 'Existing plan' });
        const result = await tools.draftAgreement({ plan: named.draftArtifact, rulePreset: 'community-vote', title: 'A park', consultation });
        expect(paths).toContain('/parcel-sources/selected-source');
        expect(result.agreement.inputs.parcels[0].parcelSourceId).toBe('selected-source');
        expect(result.cid).toBe(cidOfObject(result.agreement));
        expect(result.agreement.money.currency).toBe('GBP');
        expect(result.agreement.rule.binding).toBe(false);
        expect(result.agreement.consultation).toEqual(consultation);
        expect(result.previewUrl).toBeNull();
        expect(result.draftArtifact).toMatchObject({ agreement: result.agreement, parcelSourceId: 'selected-source' });
        const inspected = await tools.inspectAgreement({ plan: result.draftArtifact, filter: { kind: 'piece' } });
        expect(inspected.items[0]).toHaveProperty('recipient');
        expect(inspected).toHaveProperty('parties');
        expect(inspected).toHaveProperty('cashSchedule');
        const revised = await tools.editAgreement({ plan: result.draftArtifact, expectedCid: result.cid, terms: { title: 'Revised park agreement' } });
        expect(revised.agreement.planCid).toBe(result.agreement.planCid);
        expect(revised.agreement.title).toBe('Revised park agreement');
        expect(paths).not.toContain('/pins');
        expect(paths).not.toContain('/agreements');
    });

    it('defaults omitted agreement currency to the plan city money', async () => {
        const design = make('space', { spaceKind: 'park', city: 'bogota' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async url => {
            const path = new URL(url).pathname;
            return Response.json(path === '/designs/binding'
                ? { parcelSourceId: 'selected-source', binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unsurveyedM2: 0, unknownM2: 0 } }
                : { complete: true, features: parcels });
        } });
        const plan = await tools.draftPlan({ designs: [design.content], title: 'Bogotá plan' });
        const agreement = await tools.draftAgreement({ plan: plan.draftArtifact, rulePreset: 'community-vote' });
        expect(agreement.agreement.city).toBe('bogota');
        expect(agreement.agreement.money.currency).toBe('COP');
    });

    it('keeps strict optional consultation metadata in drafting and revision tool schemas', () => {
        const tools = new Map();
        registerMcpCompanion({ registerTool: (name, options) => tools.set(name, options.inputSchema), registerResource() {}, registerPrompt() {} }, { actions: {}, handler: fn => fn, readOnly: {} });
        const consultation = { organiser: 'did:web:community.example', participationUrl: 'https://community.example/participate' };
        const design = make('space', { spaceKind: 'park' }).content;
        const draft = tools.get('ugt_draft_agreement');
        expect(draft.parse({ plan: cidOfObject({ schema: 'plan/v1', title: 'p', designCids: [cidOfObject(design)], view: { at: '51.5,-0.1,17', mode: '2d', city: 'london' } }), consultation }).consultation).toEqual(consultation);
        expect(draft.parse({ plan: cidOfObject({ schema: 'plan/v1', title: 'p', designCids: [cidOfObject(design)], view: { at: '51.5,-0.1,17', mode: '2d', city: 'london' } }) }).currency).toBeUndefined();
        expect(draft.safeParse({ plan: {}, consultation: { ...consultation, extra: true } }).success).toBe(false);
        expect(draft.safeParse({ designs: [design], consultation: { organiser: 'x'.repeat(2049), participationUrl: null } }).success).toBe(false);
        const edit = tools.get('ugt_edit_agreement');
        expect(edit.parse({ plan: {}, expectedCid: cidOfObject(design), terms: { consultation } }).terms.consultation).toEqual(consultation);
        expect(edit.safeParse({ plan: {}, expectedCid: cidOfObject(design), terms: { consultation: { organiser: null } } }).success).toBe(false);
    });
});
