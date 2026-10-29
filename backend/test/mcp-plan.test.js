import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { registerMcpCompanion } from '../agents/mcp-companion.mjs';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { createTestPreviewLinks } from './helpers/mcp-preview-store.js';
import { cidOfObject } from '../cid.js';
import { defaultAllocations } from '../agents/agreement-objects.js';
const require = createRequire(import.meta.url);
const Approval = require('../../frontend/js/proposals/approval.js');
const ApprovalRegimes = require('../../frontend/js/proposals/approval-regimes.js');

const site = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] };
async function runtime() {
    const store = createTestPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example' });
    const paths = [];
    const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: { UGT_APP_ORIGIN: 'https://app.example' }, resolveDraftReference: store.resolve,
        fetchImpl: async url => {
            const path = new URL(url).pathname; paths.push(path);
            if (path === '/designs/binding') return Response.json({ parcelSourceId: 'test-source', binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unsurveyedM2: 0, unknownM2: 0 } });
            if (path === '/parcel-sources/test-source') return Response.json({ complete: true, features: [{ type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site }] });
            throw new Error(`Unexpected API request: ${path}`);
        } });
    const park = await tools.draftSpace({ city: 'zagreb', parcelSourceId: 'test-source', title: 'Test park', outline: site, spaceKind: 'park' });
    const namedPlan = await tools.draftPlan({ designs: [park.design], title: 'Existing named plan' });
    return { tools, paths, park, namedPlan };
}

describe('agreement MCP editing surface', () => {
    const schemas = () => {
        const tools = new Map();
        registerMcpCompanion({ registerTool: (name, options) => tools.set(name, options.inputSchema), registerResource() {}, registerPrompt() {} },
            { actions: {}, handler: fn => fn, readOnly: {} });
        return tools;
    };

    it('edits proposer acquisition through MCP and inspects land and balanced compensation', async () => {
        const { tools, namedPlan } = await runtime();
        const first = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'community-vote' });
        const allocations = first.agreement.outputs.map(output => ({ output: output.hash, to: { kind: 'proposer' } }));
        const changed = await tools.editAgreement({ plan: first.draftArtifact, expectedCid: first.cid, terms: {
            rule: { electorate: 'owners', binding: false, approvalConfig: null, lens: [], settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 } }, allocations
        } });
        expect(changed.agreement.allocations).toEqual(allocations);
        const inspected = await tools.inspectAgreement({ plan: changed.draftArtifact });
        expect(inspected.proposerM2).toBeGreaterThan(0);
        expect(inspected.cashSchedule.sponsorCents).toBeLessThan(0);
        const drafted = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'owner-vote', allocations });
        expect(drafted.agreement.allocations).toEqual(allocations);
    });
    it('requires an existing named plan to draft an agreement and has no design or cash-line inputs', () => {
        const draft = schemas().get('ugt_draft_agreement');
        const plan = { schema: 'plan/v1', title: 'Existing plan', designCids: [], view: { at: '51.5,-0.1,17', mode: '2d', city: 'london' } };
        expect(draft.parse({ plan }).plan).toEqual(plan);
        expect(draft.parse({ plan, allocations: [{ output: 'piece', to: { kind: 'proposer' } }] }).allocations[0].to.kind).toBe('proposer');
        const rule = { electorate: 'owners', binding: true, approvalConfig: { schema: 'proposal-approval/v1', rights: null,
            policy: { type: 'rules', tests: [], authorities: [{ authorityId: 'authority:district' }] }, regime: { id: 'de-umlegung-new', version: '1' } },
            lens: ['11111111111111111111111111111111'], settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 1000 } };
        expect(draft.parse({ plan, rulePreset: 'owner-deal', rule }).rule).toEqual(rule);
        expect(draft.safeParse({ designs: [] }).success).toBe(false);
        expect(draft.safeParse({ plan, money: { currency: 'EUR', lines: [] } }).success).toBe(false);
    });

    it('limits agreement edits to terms and permits selecting an existing plan', () => {
        const edit = schemas().get('ugt_edit_agreement');
        const plan = { schema: 'plan/v1', title: 'Replacement plan', designCids: [], view: { at: '51.5,-0.1,17', mode: '2d', city: 'london' } };
        const expectedCid = cidOfObject({ schema: 'agreement/v1', revision: 1 });
        expect(edit.parse({ plan, expectedCid, terms: { plan, settlement: { method: 'area', rateCentsPerM2: 12000, contributionBasisPoints: 0 } } }).terms.plan).toEqual(plan);
        expect(edit.parse({ plan, expectedCid, terms: { allocations: [{ output: 'piece', to: { kind: 'proposer' } }] } }).terms.allocations[0].to.kind).toBe('proposer');
        expect(edit.safeParse({ plan, expectedCid, operations: [{ type: 'remove', ref: 'design:x' }] }).success).toBe(false);
    });

    it('revises recipient and EUR/m² settlement on the same existing plan, deriving new cash', async () => {
        const { tools, paths, namedPlan } = await runtime();
        const original = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'owner-deal',
            rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [], settlement: null }, title: 'Initial terms' });
        expect(defaultAllocations({ parcels: original.agreement.inputs.parcels }, original.agreement.outputs)).toHaveLength(original.agreement.outputs.length);
        const recipients = original.agreement.outputs.map(output => ({ output: output.hash, to: { kind: 'public' } }));
        const edited = await tools.editAgreement({ plan: original.draftArtifact, expectedCid: original.cid,
            terms: { rulePreset: 'owner-vote', allocations: recipients, settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 } } });
        const changed = await tools.editAgreement({ plan: edited.draftArtifact, expectedCid: edited.cid,
            terms: { settlement: { method: 'area', rateCentsPerM2: 20000, contributionBasisPoints: 0 } } });
        expect(edited.agreement.planCid).toBe(namedPlan.cid);
        expect(changed.agreement.planCid).toBe(namedPlan.cid);
        expect(edited.agreement.allocations).toEqual(recipients);
        expect(edited.agreement.money.lines.length).toBeGreaterThan(0);
        expect(changed.agreement.money.lines[0].amountCents).toBeGreaterThan(edited.agreement.money.lines[0].amountCents);
        expect(Math.abs(changed.agreement.money.lines[0].amountCents - edited.agreement.money.lines[0].amountCents * 2)).toBeLessThanOrEqual(1);
        expect(original.agreement.allocations).not.toEqual(recipients);
        expect(original.agreement.rule.settlement).toBeNull();
        expect(paths).not.toContain('/plans');
        expect(paths).not.toContain('/agreements');
    });

    it('rejects design composition operations at runtime and leaves the source plan intact', async () => {
        const { tools, namedPlan } = await runtime();
        const original = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'community-vote' });
        await expect(tools.editAgreement({ plan: original.draftArtifact, expectedCid: original.cid,
            operations: [{ type: 'remove', ref: `design:${original.designs[0].cid}` }] })).rejects.toMatchObject({ code: 'agreement-terms-only' });
        expect(original.agreement.planCid).toBe(namedPlan.cid);
        expect(namedPlan.plan.designCids).toEqual([original.designs[0].cid]);
    });

    it('supports German authority rules, custom authority policy, lens edits and rights-holder refresh', async () => {
        const { tools, namedPlan } = await runtime();
        const original = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'community-vote' });
        const rights = { schema: 'parcel-rights/v1', source: { provider: 'agent-test' }, parcels: [
            { parcelId: 'A', complete: true, areaM2: null, owners: [{ ownerId: 'party-de', share: '1/1' }] }
        ] };
        const germanRegime = ApprovalRegimes.get('de-umlegung-new', ApprovalRegimes.CHECKED);
        const germanConfig = Approval.normalizeConfig({ schema: 'proposal-approval/v1', rights,
            policy: ApprovalRegimes.policyOf(germanRegime, ['authority:district']),
            regime: { id: germanRegime.id, version: germanRegime.version } });
        const firstRule = { electorate: 'owners', binding: true, approvalConfig: germanConfig,
            lens: ['11111111111111111111111111111111'], settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 1000 } };
        // Giving all the land to public breaks the scheme's 30% cap: the edit is refused with the owner and the cap.
        await expect(tools.editAgreement({ plan: original.draftArtifact, expectedCid: original.cid,
            terms: { rule: firstRule, rights, allocations: original.agreement.outputs.map(output => ({ output: output.hash, to: { kind: 'public' } })) } }))
            .rejects.toThrow(/Owner\(s\) of parcel A gives up 100% of their land; Germany — Umlegung, land developed for the first time allows at most 30%/);
        const allocations = original.agreement.outputs.map(output => ({ output: output.hash, to: { kind: 'party', ownerKey: 'parcel-owner:A' } }));
        const german = await tools.editAgreement({ plan: original.draftArtifact, expectedCid: original.cid,
            terms: { rule: firstRule, rights, allocations } });
        expect(german.agreement.rule.approvalConfig.regime).toEqual({ id: germanRegime.id, version: germanRegime.version });
        // The parcel stays its owners' abstract party; the rights name the person, only in the rule.
        expect(german.agreement.inputs.parcels[0]).not.toHaveProperty('holders');
        expect(german.agreement.rule.approvalConfig.rights.parcels[0].owners).toEqual([{ ownerId: 'party-de', share: '1/1' }]);
        const inspected = await tools.inspectAgreement({ plan: german.draftArtifact });
        expect(inspected.persons).toMatchObject({ resolved: true, persons: [{ personId: 'party-de', parcels: [{ parcelId: 'A', share: '1/1' }] }], totals: { balanced: true } });
        expect(inspected.persons.persons[0].landM2).toBeCloseTo(inspected.parties[0].assignedM2, 9);
        expect(inspected.scheme).toMatchObject({ id: 'de-umlegung-new', version: germanRegime.version, ok: true });
        expect(inspected.scheme.rules.map(rule => rule.kind)).toEqual(['cap', 'proposer']);

        const customConfig = Approval.normalizeConfig({ schema: 'proposal-approval/v1', rights,
            policy: { type: 'rules', tests: [], authorities: [{ authorityId: 'planning-board' }] } });
        const custom = await tools.editAgreement({ plan: german.draftArtifact, expectedCid: german.cid, terms: { rule: {
            ...firstRule, approvalConfig: customConfig, lens: ['11111111111111111111111111111112'],
            settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 }
        } } });
        expect(custom.agreement.rule.approvalConfig.policy).toMatchObject({ type: 'rules', authorities: [{ authorityId: 'planning-board' }] });
        expect(custom.agreement.rule.approvalConfig).not.toHaveProperty('regime');
        expect(custom.agreement.rule.lens).toEqual(['11111111111111111111111111111112']);
        expect(german.agreement.rule.lens).toEqual(firstRule.lens);
    });

    it('settles by value through MCP, reports the valuation and the scheme check, and refuses an area deal under a value scheme', async () => {
        const { tools, namedPlan } = await runtime();
        const first = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'community-vote' });
        const outputs = first.agreement.outputs;
        const valuation = { inputs: [{ parcelId: 'A', unitValueCents: 10000 }], outputs: outputs.map(output => ({ output: output.hash, unitValueCents: 25000 })) };
        const settlement = { method: 'value', rateCentsPerM2: 0, contributionBasisPoints: 0 };
        const allocations = outputs.map(output => ({ output: output.hash, to: { kind: 'party', ownerKey: 'parcel-owner:A' } }));
        const drafted = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'owner-vote', settlement, valuation, allocations });
        expect(drafted.agreement.rule.settlement).toEqual(settlement);
        expect(drafted.agreement.valuation).toEqual(valuation);
        // One owner keeps all the land: entitled to all of its value, no cash moves.
        expect(drafted.agreement.money.lines).toEqual([]);
        const inspected = await tools.inspectAgreement({ plan: drafted.draftArtifact });
        expect(inspected.valuation).toEqual(valuation);
        expect(inspected).toMatchObject({ valued: true, scheme: null });
        expect(inspected.distributableValueCents).toBe(inspected.parties[0].entitlementValueCents);
        expect(inspected.parties[0].contributedValueCents).toBeLessThan(inspected.parties[0].assignedValueCents);
        // A value is required for every piece: a draft that leaves one out is refused.
        await expect(tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'owner-vote', settlement, allocations, valuation: { inputs: valuation.inputs, outputs: [] } }))
            .rejects.toThrow(/value per m²/);
        // Gujarat distributes by value and charges half of the increment: the same deal under it pays half of the gain.
        const gujarat = ApprovalRegimes.latest('in-gj-tps');
        const rights = { schema: 'parcel-rights/v1', source: { provider: 'agent-test' }, parcels: [{ parcelId: 'A', complete: true, areaM2: null, owners: [{ ownerId: 'party-in', share: '1/1' }] }] };
        const config = Approval.normalizeConfig({ schema: 'proposal-approval/v1', rights, policy: ApprovalRegimes.policyOf(gujarat, ['authority:state']), regime: { id: gujarat.id, version: gujarat.version } });
        const rule = { electorate: 'owners', binding: true, approvalConfig: config, lens: ['11111111111111111111111111111111'], settlement };
        const edited = await tools.editAgreement({ plan: drafted.draftArtifact, expectedCid: drafted.cid, terms: { rule, rights,
            allocations } });
        const editedInspection = await tools.inspectAgreement({ plan: edited.draftArtifact });
        const owner = editedInspection.parties[0];
        const gainCents = -Math.round((owner.entitlementValueCents - owner.contributedValueCents) / 2);
        expect(edited.agreement.money.lines).toEqual([{ ownerKey: 'parcel-owner:A', amountCents: gainCents }]);
        // The one person behind the party pays all of it.
        expect(editedInspection.persons.persons).toMatchObject([{ personId: 'party-in', cashCents: gainCents }]);
        expect(drafted.persons).toBeNull();
        expect((await tools.inspectAgreement({ plan: edited.draftArtifact })).scheme).toMatchObject({ id: 'in-gj-tps', ok: true });
        await expect(tools.editAgreement({ plan: edited.draftArtifact, expectedCid: edited.cid, terms: { settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 }, valuation: null } }))
            .rejects.toThrow(/distributes by land value; this agreement settles by surface area/);
        // The schema accepts the value method and the valuation (mcp-discovery.test.js reads the scheme catalogue).
        const draft = schemas().get('ugt_draft_agreement');
        expect(draft.parse({ plan: namedPlan.plan, settlement, valuation }).valuation).toEqual(valuation);
        expect(draft.safeParse({ plan: namedPlan.plan, settlement: { method: 'worth', rateCentsPerM2: 0, contributionBasisPoints: 0 } }).success).toBe(false);
    });

    it('preserves explicit currency when terms select another existing named plan', async () => {
        const { tools, park, namedPlan } = await runtime();
        const other = await tools.draftPlan({ designs: [park.design], title: 'Another existing plan' });
        const original = await tools.draftAgreement({ plan: namedPlan.draftArtifact, rulePreset: 'community-vote', currency: 'GBP' });
        const revised = await tools.editAgreement({ plan: original.draftArtifact, expectedCid: original.cid,
            terms: { plan: other.draftArtifact } });
        expect(revised.agreement.planCid).toBe(other.cid);
        expect(revised.agreement.money.currency).toBe('GBP');
    });
});
