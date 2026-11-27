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
        // The agreement takes the building's own parcel; the rest of A stays A, outside it.
        const taken = ground.outputs.reduce((sum, o) => sum + o.areaM2, 0);
        expect(taken).toBeLessThan(turf.area(parcels[0]) - 1);
        expect(taken).toBeCloseTo(ground.inputs.parcels[0].areaM2, 2);
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
    }, 30000); // Whole restated plans: ~2 s on an idle laptop, past the 5 s default under load or on a 2-core runner.
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
        expect(inspected.items[0]).not.toHaveProperty('recipient');
        expect(inspected.parties).toBeNull();
        expect(inspected.cashSchedule).toBeNull();
        expect(inspected.rule).toEqual({ electorate: 'community', binding: false });
        const revised = await tools.editAgreement({ plan: result.draftArtifact, expectedCid: result.cid, terms: { title: 'Revised park agreement' } });
        expect(revised.agreement.planCid).toBe(result.agreement.planCid);
        expect(revised.agreement.title).toBe('Revised park agreement');
        expect(paths).not.toContain('/pins');
        expect(paths).not.toContain('/agreements');
    });

    // Strong Suburbs para 2 through the real tool: refused on a plan that does not claim the street
    // code; on one that does, the server's check goes into the voting record and survives a terms edit.
    it('drafts a Strong Suburbs street vote only on a plan claiming its street code, recording the check', async () => {
        const design = make('space', { spaceKind: 'park' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async url => {
            const path = new URL(url).pathname;
            return Response.json(path === '/designs/binding'
                ? { parcelSourceId: 'selected-source', binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unsurveyedM2: 0, unknownM2: 0 } }
                : { complete: true, features: parcels });
        } });
        const consultation = { organiser: null, participationUrl: null, voting: { schema: 'community-voting/v2', id: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
            codeHashes: ['a'.repeat(64)], rule: { id: 'gb-street-vote-strong-suburbs', version: '2026-11-27' } } };
        const unclaimed = await tools.draftPlan({ designs: [design.content], title: 'Park without a code' });
        await expect(tools.draftAgreement({ plan: unclaimed.draftArtifact, rulePreset: 'community-vote', consultation })).rejects.toMatchObject({ code: 'street-code-unclaimed' });
        const claimed = await tools.draftPlan({ designs: [design.content], title: 'Park', codes: [{ id: 'gb-strong-suburbs-street-code', version: '2021' }] });
        const result = await tools.draftAgreement({ plan: claimed.draftArtifact, rulePreset: 'community-vote', consultation });
        expect(result.agreement.consultation.voting.streetCode).toMatchObject({ set: { id: 'gb-strong-suburbs-street-code', version: '2021' }, planCid: result.agreement.planCid, street: null, buildings: [] });
        expect(result.streetCode).toMatchObject({ required: true, summary: { buildings: 0 } });
        expect(result.streetCode).not.toHaveProperty('recorded');
        const revised = await tools.editAgreement({ plan: result.draftArtifact, expectedCid: result.cid, terms: { title: 'Revised' } });
        expect(revised.agreement.consultation.voting.streetCode).toEqual(result.agreement.consultation.voting.streetCode);
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

    it('drafts, inspects and revises a land-free crowdfunding agreement on an existing plan', async () => {
        const design = make('space', { spaceKind: 'park' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {} });
        const plan = await tools.draftPlan({ designs: [design.content], title: 'Funded park plan' });
        const terms = { rulePreset: 'crowdfunding', plan: plan.draftArtifact, sponsor: 'So11111111111111111111111111111111111111112',
            lenses: ['9xQeWvG816bUx9EPf9HmaT23yvVMZ4vQ1B9cY6p2gYt'], deadline: '2099-01-01T00:00:00.000Z', targetUsdcAtomic: '1000000',
            contract: { name: 'investor-terms.txt', mediaType: 'text/plain', data: 'dGVybXM=' } };
        const draft = await tools.draftAgreement(terms);
        expect(draft.agreement).toMatchObject({ rule: { electorate: 'investors', binding: true, approvalConfig: null, settlement: null },
            inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], funding: { targetUsdcAtomic: '1000000', contract: terms.contract } });
        const inspected = await tools.inspectAgreement({ plan: draft.draftArtifact });
        expect(inspected).toMatchObject({ funding: draft.agreement.funding, investorReview: {
            contract: 'investor-terms.txt', payout: terms.sponsor,
            decisionVerifierWallets: terms.lenses, lensThreshold: 1, developerIsVerifier: false, decisionMethod: 'program-checks-funding-target',
            fundingTargetUsdcAtomic: '1000000',
            contributorEligibility: 'any-wallet', kycEnforcedOnChain: false
        }, parties: null, cashSchedule: null });
        const revised = await tools.editAgreement({ plan: draft.draftArtifact, expectedCid: draft.cid, terms: { targetUsdcAtomic: '2000000' } });
        expect(revised.agreement.funding.targetUsdcAtomic).toBe('2000000');
        expect(revised.cid).not.toBe(draft.cid);
        // Two verifiers, the developer one of them, both required; then no lens at all: the target alone settles it.
        const both = await tools.editAgreement({ plan: draft.draftArtifact, expectedCid: draft.cid, terms: { lenses: [...terms.lenses, terms.sponsor], lensThreshold: 2 } });
        expect(both.agreement.rule).toMatchObject({ lens: [...terms.lenses, terms.sponsor], lensThreshold: 2 });
        expect((await tools.inspectAgreement({ plan: both.draftArtifact })).investorReview).toMatchObject({ lensThreshold: 2, developerIsVerifier: true });
        const none = await tools.editAgreement({ plan: draft.draftArtifact, expectedCid: draft.cid, terms: { lenses: [] } });
        expect(none.agreement.rule.lens).toEqual([]);
        expect(none.agreement.rule).not.toHaveProperty('lensThreshold');
        await expect(tools.editAgreement({ plan: draft.draftArtifact, expectedCid: draft.cid, terms: { lensThreshold: 2 } })).rejects.toThrow(/from 1 to the number of members/);
    });

    it('authors, inspects and revises the same apartment schedule a buyer reviews in the browser', async () => {
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {} });
        const design = make('space', { spaceKind: 'park', city: 'zagreb' });
        const plan = await tools.draftPlan({ title: 'Podbrežje courtyard', designs: [design.content] });
        const drawing = { name: 'floor-six.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') };
        const apartment = id => ({ unitId: id, label: id.toUpperCase(), xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::' + id.toUpperCase(),
            at: '45.7665,15.9722,19', priceUsdcAtomic: '100000000', depositUsdcAtomic: '10000000', drawing });
        const apartments = { projectId: 'podbrezje', units: [apartment('a4-c-23'), apartment('a4-c-21')] };
        const draft = await tools.draftAgreement({ rulePreset: 'crowdfunding', plan: plan.draftArtifact,
            sponsor: 'So11111111111111111111111111111111111111112', lenses: ['9xQeWvG816bUx9EPf9HmaT23yvVMZ4vQ1B9cY6p2gYt'],
            deadline: '2099-01-01T00:00:00.000Z', targetUsdcAtomic: '20000000',
            contract: { name: 'terms.txt', mediaType: 'text/plain', data: 'dGVybXM=' }, apartments });
        const preview = await tools.inspectAgreement({ plan: draft.draftArtifact, includeAvailability: true });
        expect(preview.funding.apartments).toMatchObject(apartments);
        expect(preview.investorReview).toMatchObject({ contributorEligibility: 'lens-qualified-buyer', qualificationBefore: 'reservation-deposit',
            decisionVerifierWallets: draft.agreement.rule.lens });
        expect(preview.investorReview.availability).toEqual({ status: 'unverified' });
        expect(preview.investorReview.action).toContain('reserve');
        const updated = { ...apartments, units: [{ ...apartments.units[0], priceUsdcAtomic: '110000000' }, apartments.units[1]] };
        const revised = await tools.editAgreement({ plan: draft.draftArtifact, expectedCid: draft.cid, terms: { apartments: updated } });
        expect(revised.cid).not.toBe(draft.cid);
        expect(revised.agreement.funding.apartments).toMatchObject(updated);
        expect(draft.agreement.funding.apartments.units[0].priceUsdcAtomic).toBe('100000000');
    });

    it('adds a published round\'s apartment states and counts by the browser\'s model, accepting from the chain', async () => {
        const authoring = createUrbanGameTheoryTools({ mode: 'hosted', env: {} });
        const plan = await authoring.draftPlan({ title: 'Round plan', designs: [make('space', { spaceKind: 'park', city: 'zagreb' }).content] });
        const drawing = { name: 'floor-six.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') };
        const apartment = id => ({ unitId: id, label: id.toUpperCase(), xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::' + id.toUpperCase(),
            at: '45.7665,15.9722,19', priceUsdcAtomic: '100000000', depositUsdcAtomic: '10000000', drawing });
        const sponsor = 'So11111111111111111111111111111111111111112';
        const draft = await authoring.draftAgreement({ rulePreset: 'crowdfunding', plan: plan.draftArtifact, sponsor, lenses: ['9xQeWvG816bUx9EPf9HmaT23yvVMZ4vQ1B9cY6p2gYt'],
            deadline: '2099-01-01T00:00:00.000Z', targetUsdcAtomic: '20000000', contract: { name: 'terms.txt', mediaType: 'text/plain', data: 'dGVybXM=' },
            apartments: { projectId: 'round', units: [apartment('a1'), apartment('a2'), apartment('a3')] } });
        const { agreement: content, plan: planContent, designs } = draft.draftArtifact;
        const cid = cidOfObject(content);
        const buyer = '9xQeWvG816bUx9EPf9HmaT23yvVMZ4vQ1B9cY6p2gYt';
        // The index's chain inventory (GET /agreements/:cid?inventory=1) and the round's own account.
        const units = [{ unitId: 'a1', status: 'reserved', buyer }, { unitId: 'a2', status: 'available' }, { unitId: 'a3', status: 'unlisted' }];
        const asked = [];
        const fetchImpl = async url => {
            asked.push(String(url));
            return new Response(JSON.stringify({ cid, content, plan: planContent, designs, apartmentAvailability: { status: 'confirmed', units } }));
        };
        const chainStatus = { value: { status: 'Active', deadline: 4070908800 } };
        const readAgreementAccount = async (_connection, { cid: asks, sponsor: of }) => (asks === cid && of === sponsor ? chainStatus.value : null);
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: { UGT_API_BASE: 'https://api.test' }, fetchImpl, createConnection: () => ({}), dependencies: { readAgreementAccount } });
        const inspected = await tools.inspectAgreement({ plan: cid, includeAvailability: true });
        expect(asked[0]).toBe(`https://api.test/agreements/${cid}?inventory=1`);
        expect(inspected.apartmentStats).toMatchObject({ accepting: true, chainStatus: 'Active', counts: { offered: 3, reserved: 1, available: 1, unavailable: 1 },
            reservedDeposits: '10000000', target: '20000000', percent: 50, floors: [{ building: 1, level: 6, offered: 3 }] });
        expect(inspected.apartmentStats.units.map(row => [row.unitId, row.state, row.reason])).toEqual([['a1', 'reserved', null], ['a2', 'available', null], ['a3', 'unavailable', 'unlisted']]);
        // A round no longer Active on chain takes no reservation: its listed unit reads closed.
        chainStatus.value = { status: 'Executed', deadline: 4070908800 };
        const executed = await tools.inspectAgreement({ plan: cid, includeAvailability: true });
        expect(executed.apartmentStats).toMatchObject({ accepting: false, chainStatus: 'Executed' });
        expect(executed.apartmentStats.units[1]).toMatchObject({ state: 'unavailable', reason: 'closed' });
        // Without includeAvailability nothing is read from the chain.
        expect(await tools.inspectAgreement({ plan: cid })).not.toHaveProperty('apartmentStats');
    });

    it('takes crowdfunding city and default currency from the canonical plan view', async () => {
        const design = make('space', { spaceKind: 'park', city: 'alatau' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {} });
        const plan = await tools.draftPlan({ designs: [design.content], title: 'Alatau plan' });
        const agreement = await tools.draftAgreement({ plan: plan.draftArtifact, rulePreset: 'crowdfunding', sponsor: 'So11111111111111111111111111111111111111112',
            lenses: ['9xQeWvG816bUx9EPf9HmaT23yvVMZ4vQ1B9cY6p2gYt'], deadline: '2099-01-01T00:00:00.000Z', targetUsdcAtomic: '1000000',
            contract: { name: 'terms.txt', mediaType: 'text/plain', data: 'dGVybXM=' } });
        expect(agreement.agreement).toMatchObject({ city: 'alatau', money: { currency: 'KZT', lines: [] } });
    });

    it('keeps an investor draft private without a sponsor, then gives the sponsored revision a new CID', async () => {
        const design = make('space', { spaceKind: 'park' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {} });
        const plan = await tools.draftPlan({ designs: [design.content], title: 'Private funding plan' });
        const draft = await tools.draftAgreement({ plan: plan.draftArtifact, rulePreset: 'crowdfunding', lenses: ['9xQeWvG816bUx9EPf9HmaT23yvVMZ4vQ1B9cY6p2gYt'],
            deadline: '2099-01-01T00:00:00.000Z', targetUsdcAtomic: '1000000', contract: { name: 'terms.txt', mediaType: 'text/plain', data: 'dGVybXM=' } });
        expect(draft.agreement.sponsor).toBeNull();
        const revised = await tools.editAgreement({ plan: draft.draftArtifact, expectedCid: draft.cid,
            terms: { sponsor: 'So11111111111111111111111111111111111111112' } });
        expect(revised.agreement.sponsor).toBe('So11111111111111111111111111111111111111112');
        expect(revised.cid).not.toBe(draft.cid);
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

    it('exposes bounded crowdfunding contract terms through the registered MCP draft and edit schemas', () => {
        const tools = new Map();
        registerMcpCompanion({ registerTool: (name, options) => tools.set(name, options.inputSchema), registerResource() {}, registerPrompt() {} }, { actions: {}, handler: fn => fn, readOnly: {} });
        const contract = { name: 'terms.txt', mediaType: 'text/plain', data: 'dGVybXM=' };
        const draft = tools.get('ugt_draft_agreement');
        expect(draft.parse({ plan: {}, rulePreset: 'crowdfunding', targetUsdcAtomic: '1000000', contract }).rulePreset).toBe('crowdfunding');
        expect(draft.safeParse({ plan: {}, rulePreset: 'crowdfunding', targetUsdcAtomic: '0', contract }).success).toBe(false);
        const edit = tools.get('ugt_edit_agreement');
        expect(edit.parse({ plan: {}, expectedCid: cidOfObject({ schema: 'agreement/v1', title: 'terms' }), terms: { targetUsdcAtomic: '2000000', contract } }).terms.contract).toEqual(contract);
    });
});
