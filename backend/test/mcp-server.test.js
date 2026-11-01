// The stdio MCP server (agents/mcp-server.mjs) over an in-memory transport: its 49 ugt_* tools on
// designs and agreements, their annotations and argument schemas (CIDs, lamports, confirm: true), and
// that every call reaches the shared tool surface (ugt-agent-tools.js) only when its arguments validate,
// with refusals coming back as tool errors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { cidOfObject } from '../cid.js';
import { MCP_DEBUG_TOOLS, MCP_LOCAL_TOOLS } from '../agents/mcp-catalog.js';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { createMemorySharedPlanRepository } from './helpers/shared-plan-repository.js';

const CID = cidOfObject({ schema: 'agreement/v1', title: 'An agreement' });
const DESIGN_CID = cidOfObject({ schema: 'design/v1', title: 'A design' });
const ACCOUNT = '11111111111111111111111111111111';

let client;
let server;

afterEach(async () => {
    await client?.close();
    await server?.close();
    client = null;
    server = null;
});

async function connect(tools, options = {}) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createUrbanGameTheoryMcpServer({ tools, env: {}, ...options });
    client = new Client({ name: 'ugt-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

const TOOL_METHODS = [
    'capabilities', 'getActivity', 'listAgreements', 'getAgreement', 'listAttesters', 'getSupport', 'getOracleEvents', 'chatCost',
    'inspectVerifiedFact', 'publishDesign', 'proposeAgreement', 'mintAgreement', 'fundAgreement', 'betOnAgreement',
    'buyVerifiedFact', 'requestOwnership', 'pledge', 'donate', 'refundDonation', 'voidPledge', 'revokePledge',
    'releaseDonations', 'fulfillPledge', 'resolve', 'claim', 'resolveExternal', 'claimExternal'
];

function stubTools() {
    return Object.fromEntries(TOOL_METHODS.map(name => [name, vi.fn(async args => ({ tool: name, args }))]));
}

async function toolsByName() {
    return Object.fromEntries((await client.listTools()).tools.map(tool => [tool.name, tool]));
}

describe('Urban Game Theory MCP server', () => {
    it('exposes configured costs through a bounded read-only tool', async () => {
        const tools = stubTools();
        tools.chatCost = vi.fn(async args => ({ provider: 'openai', model: 'test', currency: 'USD', pricesPerMillionTokens: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 }, maximumTurnReservationUsd: 1,
            ...(Object.keys(args).length ? { estimate: { costUsd: 0.00001, basis: 'configured-token-prices', actual: false, tokenCounts: { inputTokens: args.inputTokens || 0, outputTokens: args.outputTokens || 0, cachedInputTokens: args.cachedInputTokens || 0, cacheWriteTokens: args.cacheWriteTokens || 0 } } } : {}) }));
        await connect(tools, { env: { CHAT_DEBUG_COSTS: 'true' } });
        const listed = await client.listTools(), tool = listed.tools.find(row => row.name === 'ugt_chat_cost');
        const contextIndex = MCP_LOCAL_TOOLS.indexOf('ugt_parcel_context');
        expect(listed.tools.map(row => row.name)).toEqual([...MCP_LOCAL_TOOLS.slice(0, contextIndex), ...MCP_DEBUG_TOOLS, ...MCP_LOCAL_TOOLS.slice(contextIndex)]);
        const capabilities = await client.callTool({ name: 'ugt_capabilities', arguments: {} });
        expect(capabilities.structuredContent.tools.map(row => row.name)).toContain('ugt_chat_cost');
        expect(capabilities.structuredContent.features.map(row => row.feature)).toContain('chat-cost');
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        expect(tool.inputSchema.properties.inputTokens.maximum).toBe(1_000_000);
        expect((await client.callTool({ name: 'ugt_chat_cost', arguments: { inputTokens: 10 } })).structuredContent).toMatchObject({ provider: 'openai', estimate: { actual: false } });
        expect(tools.chatCost).toHaveBeenCalledWith({ inputTokens: 10 });
    });

    it('routes shared publication through owner approval and rejects ambiguous tool inputs', async () => {
        const sessions = createSharedPlanSessions({ repository: createMemorySharedPlanRepository(), validateArtifact: () => {} });
        const artifact = { cid: DESIGN_CID, plan: { schema: 'plan/v1', title: 'Saved plan' }, designs: [] };
        const created = await sessions.create(artifact), tools = stubTools();
        tools.publishPlan = vi.fn(async args => ({ cid: args.expectedCid, plan: args.plan.plan, publication: 'published', url: 'https://app.example/plans/test', publishedDesignCids: [] }));
        try {
            await connect(tools, { sharedPlans: sessions });
            const contracts = await toolsByName();
            expect(contracts.ugt_publish_plan.inputSchema.oneOf).toHaveLength(2);
            expect(contracts.ugt_inspect_shared_plan.outputSchema.properties).toHaveProperty('expiresAt');
            expect(contracts.ugt_inspect_shared_plan.outputSchema.properties).toHaveProperty('publicationApproval');
            const args = { sharedSession: { sessionId: created.id, capability: created.inviteToken }, expectedCid: DESIGN_CID, expectedVersion: 0, confirm: true };
            const call = arguments_ => client.callTool({ name: 'ugt_publish_plan', arguments: arguments_ });
            expect(await call(args)).toMatchObject({ isError: true, structuredContent: { code: 'shared-plan-publication-approval-required' } });
            expect(tools.publishPlan).not.toHaveBeenCalled();
            await sessions.approvePublication(created.id, created.ownerToken, { expectedVersion: 0, expectedCid: DESIGN_CID, approve: true });
            const { expectedVersion, ...missingVersion } = args;
            expect((await call(missingVersion)).isError).toBe(true);
            expect((await call({ ...args, expectedVersion: 1, plan: artifact })).isError).toBe(true);
            expect((await call({ ...args, expectedVersion: 1 })).isError).not.toBe(true);
            expect(tools.publishPlan).toHaveBeenCalledWith({ plan: artifact, expectedCid: DESIGN_CID, confirm: true });
            expect((await call({ plan: artifact, expectedCid: DESIGN_CID, confirm: true })).isError).not.toBe(true);
        } finally { await sessions.dispose(); }
    });

    it('carries a shared-plan turn through the real MCP tool boundary and rejects a late agent write', async () => {
        const sessions = createSharedPlanSessions({ repository: createMemorySharedPlanRepository(), validateArtifact: value => {
            if (!value?.cid || !value?.plan || !Array.isArray(value.designs)) throw new Error('invalid test artifact');
        } });
        const initial = { cid: DESIGN_CID, plan: { schema: 'plan/v1', title: 'Before' }, designs: [] };
        const created = await sessions.create(initial), tools = stubTools();
        tools.editPlan = vi.fn(async () => ({ cid: CID, plan: { schema: 'plan/v1', title: 'After' }, designs: [], changes: [], consequences: { removed: [], junctions: [], cuts: [] } }));
        try {
            await connect(tools, { sharedPlans: sessions });
            const inspected = await client.callTool({ name: 'ugt_inspect_shared_plan', arguments: { sessionId: created.id, capability: created.inviteToken } });
            expect(inspected.isError).not.toBe(true); expect(inspected.structuredContent).toMatchObject({ version: 0, cid: DESIGN_CID });
            const handover = await sessions.control(created.id, created.ownerToken, { expectedVersion: 0, controller: 'agent' });
            const edited = await client.callTool({ name: 'ugt_edit_shared_plan', arguments: { sessionId: created.id, capability: created.inviteToken,
                expectedVersion: handover.version, expectedCid: DESIGN_CID, operations: [] } });
            expect(edited.isError).not.toBe(true); expect(edited.structuredContent).toMatchObject({ version: 2, cid: CID });
            const owner = await sessions.control(created.id, created.ownerToken, { expectedVersion: 2, controller: 'owner' });
            const late = await client.callTool({ name: 'ugt_edit_shared_plan', arguments: { sessionId: created.id, capability: created.inviteToken,
                expectedVersion: owner.version, expectedCid: CID, operations: [] } });
            expect(late).toMatchObject({ isError: true, structuredContent: { code: 'shared-plan-control-required' } });
        } finally { await sessions.dispose(); }
    });
    it('exposes exact private inspection and granular edits through the actual MCP schemas', async () => {
        const calls=[];
        const observations=[];
        const tools=createUrbanGameTheoryTools({mode:'hosted',env:{},fetchImpl:async(url)=>{
            calls.push(new URL(url).pathname);
            return Response.json({parcelSourceId:'fixture',binding:{coverage:'complete',parcels:[{parcelId:'A'}]}});
        }});
        await connect(tools, { diagnosticRecorder: row => observations.push(row), env: { NODE_ENV: 'test' } });
        const drafted=await client.callTool({name:'ugt_draft_space',arguments:{city:'london',spaceKind:'park',treeCount:2,
            outline:{type:'Polygon',coordinates:[[[-.1,51.5],[-.099,51.5],[-.099,51.501],[-.1,51.501],[-.1,51.5]]]}}});
        expect(drafted.isError).not.toBe(true);
        const design=drafted.structuredContent.untrusted.design;
        const inspected=await client.callTool({name:'ugt_inspect_design',arguments:{design,paths:['/structureProposal/decorationDesign/trees']}});
        expect(inspected.structuredContent.values[0].untrustedValue).toEqual(design.structureProposal.decorationDesign.trees);
        const edited=await client.callTool({name:'ugt_edit_design',arguments:{design,expectedCid:drafted.structuredContent.cid,
            edits:[{op:'replace',path:'/title',value:'Edited garden'},{op:'remove',path:'/structureProposal/decorationDesign/trees/0'}]}});
        expect(edited.isError).not.toBe(true);
        expect(edited.structuredContent.untrusted.design.title).toBe('Edited garden');
        expect(edited.structuredContent.untrusted.design.structureProposal.decorationDesign.trees).toHaveLength(1);
        expect(calls.every(path=>path==='/designs/binding')).toBe(true);
        expect(observations.map(row => [row.operation, row.outcome])).toEqual([['create', 'success'], ['edit', 'success']]);
        expect(observations.every(row => row.source === 'mcp' && row.test === 'known-test' && row.sessionId === null)).toBe(true);
        expect(JSON.stringify(observations)).not.toContain('Edited garden');
        expect(JSON.stringify(observations)).not.toContain('coordinates');
    });
    it('publishes one declared tool surface for designs, agreements, editing, markets, support, activity and oracle facts', async () => {
        await connect(stubTools());
        const names = (await client.listTools()).tools.map(tool => tool.name);
        expect(names).toEqual(MCP_LOCAL_TOOLS);
        expect(names).not.toContain('ugt_chat_cost');
        const capabilities = await client.callTool({ name: 'ugt_capabilities', arguments: {} });
        expect(capabilities.structuredContent.features.map(row => row.feature)).not.toContain('chat-cost');
        expect(names).toContain('ugt_publish_plan');
        expect(names).toContain('ugt_inspect_agreement');
        expect(names.some(name => /proposal|forecast|verdict|accept/.test(name))).toBe(false);
    });

    it('declares only supported typed urban-rule inputs', async () => {
        await connect(stubTools());
        const rule = (await toolsByName()).ugt_draft_urban_rule.inputSchema.properties.rule;
        expect(rule.additionalProperties).toBe(false);
        expect(rule.required).toContain('typology');
        expect(rule.properties.typology.enum).toEqual(['block', 'row', 'detached']);
        expect(rule.properties.floors.maximum).toBe(200);
        expect(rule.properties.height.maximum).toBe(800);
    });

    it('refuses malformed successful authoring output while keeping structured recovery errors valid', async () => {
        const tools = stubTools();
        const observations = [];
        tools.draftBuilding = vi.fn(async () => ({ cid: DESIGN_CID }));
        await connect(tools, { diagnosticRecorder: row => observations.push(row) });
        const args = { city: 'london', typology: 'freeform', floors: 4 };
        const malformed = await client.callTool({ name: 'ugt_draft_building', arguments: args });
        expect(malformed).toMatchObject({ isError: true, structuredContent: { code: 'invalid-tool-output' } });
        expect(malformed.structuredContent.untrusted.message).toMatch(/Output validation error/);
        tools.draftBuilding.mockRejectedValueOnce(Object.assign(new Error('Ground is unavailable'), { code: 'ground-unavailable' }));
        const refused = await client.callTool({ name: 'ugt_draft_building', arguments: args });
        expect(refused).toMatchObject({ isError: true, structuredContent: { code: 'ground-unavailable', next: expect.any(Object) } });
        expect(refused.structuredContent).not.toHaveProperty('cid');
        expect(observations.map(row => row.outcome)).toEqual(['failure', 'failure']);
    });

    it('exposes bounded random-start and distance selection through the public parcel primitive', async () => {
        const tools = stubTools();
        tools.selectParcels = vi.fn(async () => ({ selection: { parcelSourceId: 'source', focusParcelId: 'p', parcelIds: ['p'], active: false }, point: [0, 0] }));
        await connect(tools);
        const tool = (await toolsByName()).ugt_select_parcels;
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: false });
        expect(tool.inputSchema.properties.action.enum).toContain('random');
        expect(tool.inputSchema.properties.radiusM.maximum).toBe(1000);
        const args = { city: 'london', parcelSourceId: 'source', action: 'random', point: [-0.08, 51.5], direction: 'southwest', radiusM: 500 };
        expect((await client.callTool({ name: 'ugt_select_parcels', arguments: args })).structuredContent.selection.parcelIds).toEqual(['p']);
        expect(tools.selectParcels).toHaveBeenCalledWith(args);
        expect((await client.callTool({ name: 'ugt_select_parcels', arguments: { ...args, radiusM: 1001 } })).isError).toBe(true);
        expect(tools.selectParcels).toHaveBeenCalledTimes(1);
    });

    it('exposes landmark relations and displayed parcel numbers through existing public primitives', async () => {
        const tools = stubTools();
        tools.selectParcels = vi.fn(async () => ({ selection: { parcelSourceId: 'source', focusParcelId: 'p', parcelIds: ['p'], active: false }, parcelNumber: '17/2' }));
        tools.mapView = vi.fn(async () => ({ view: { at: '0,0,18' }, parcelIdsVisible: true }));
        await connect(tools);
        const byName = await toolsByName();
        expect(byName.ugt_select_parcels.inputSchema.properties.action.enum).toContain('near');
        expect(byName.ugt_select_parcels.inputSchema.properties.maxDistanceM.maximum).toBe(200);
        expect(byName.ugt_select_parcels.inputSchema.properties.visibleParcels.maxItems).toBe(500);
        const args = { city: 'london', parcelSourceId: 'source', action: 'near', landmark: { osmId: 'way/1', point: [0,0] }, relation: 'edge', direction: 'southwest' };
        expect((await client.callTool({ name: 'ugt_select_parcels', arguments: args })).isError).toBeFalsy();
        expect(tools.selectParcels).toHaveBeenCalledWith(args);
        expect((await client.callTool({ name: 'ugt_map_view', arguments: { view: { at: '0,0,18' }, parcelIdsVisible: true } })).structuredContent.parcelIdsVisible).toBe(true);
        expect((await client.callTool({ name: 'ugt_select_parcels', arguments: { ...args, maxDistanceM: 201 } })).isError).toBe(true);
    });

    it('marks reads read-only, publishing additive and idempotent, and chain actions destructive', async () => {
        await connect(stubTools());
        const byName = await toolsByName();
        for (const name of ['ugt_capabilities', 'ugt_activity', 'ugt_list_agreements', 'ugt_get_agreement', 'ugt_list_attesters', 'ugt_support_status', 'ugt_oracle_events', 'ugt_inspect_verified_fact']) {
            expect(byName[name].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        }
        for (const name of ['ugt_publish_design', 'ugt_propose_agreement']) {
            expect(byName[name].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
        }
        expect(byName.ugt_mint_agreement.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
        expect(byName.ugt_bet_on_agreement.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
        expect(byName.ugt_donate.annotations.destructiveHint).toBe(true);
    });

    it('declares the agreement tools\' arguments: CIDs, whole lamports and confirm', async () => {
        await connect(stubTools());
        const byName = await toolsByName();
        const mint = byName.ugt_mint_agreement.inputSchema;
        expect(Object.keys(mint.properties)).toEqual(['agreementCid', 'lamports', 'confirm']);
        expect([...mint.required].sort()).toEqual(['agreementCid', 'confirm', 'lamports']);
        expect(Object.keys(byName.ugt_bet_on_agreement.inputSchema.properties)).toEqual(['agreementCid', 'side', 'amountUsdc', 'confirm']);
        expect(byName.ugt_bet_on_agreement.inputSchema.properties.side.enum).toEqual(['yes', 'no']);
        expect(Object.keys(byName.ugt_propose_agreement.inputSchema.properties)).toEqual(['agreement', 'expectedCid', 'designs', 'confirm']);
        expect(Object.keys(byName.ugt_publish_design.inputSchema.properties)).toEqual(['design', 'expectedCid', 'parcelSourceId', 'confirm']);
        expect(Object.keys(byName.ugt_list_agreements.inputSchema.properties)).toEqual(['city', 'design', 'parcel', 'limit']);
        expect(Object.keys(byName.ugt_pledge.inputSchema.properties)).toEqual(['agreementAccount', 'amountUsdc', 'confirm']);
        const ownership = byName.ugt_request_ownership.inputSchema;
        expect(Object.keys(ownership.properties)).toEqual(['serviceUrl', 'parcelUid', 'confirm']);
        expect(ownership.required).toEqual(['serviceUrl', 'parcelUid']);
    });

    it('validates arguments and returns structured output, with defaults applied', async () => {
        const tools = stubTools();
        await connect(tools);
        const result = await client.callTool({ name: 'ugt_list_agreements', arguments: { city: 'zagreb', design: DESIGN_CID } });
        expect(result.isError).not.toBe(true);
        expect(tools.listAgreements).toHaveBeenCalledWith({ city: 'zagreb', design: DESIGN_CID, limit: 20 });
        expect(result.structuredContent).toMatchObject({ tool: 'listAgreements', args: { city: 'zagreb', design: DESIGN_CID, limit: 20 } });
        const bad = await client.callTool({ name: 'ugt_list_agreements', arguments: { design: 'not-a-cid' } });
        expect(bad.isError).toBe(true);
        expect(tools.listAgreements).toHaveBeenCalledTimes(1);
    });

    it('requires confirm: true, a CID and whole lamports before a chain action reaches the tools', async () => {
        const tools = stubTools();
        await connect(tools);
        const call = args => client.callTool({ name: 'ugt_mint_agreement', arguments: args });
        expect((await call({ agreementCid: CID, lamports: '1000' })).isError).toBe(true);
        expect((await call({ agreementCid: CID, lamports: '1000', confirm: false })).isError).toBe(true);
        expect((await call({ agreementCid: 'proposal-7', lamports: '1000', confirm: true })).isError).toBe(true);
        expect((await call({ agreementCid: CID, lamports: '0.5', confirm: true })).isError).toBe(true);
        expect((await client.callTool({ name: 'ugt_donate', arguments: { agreementAccount: ACCOUNT, amountUsdc: '0.01', operationId: 'once' } })).isError).toBe(true);
        expect((await client.callTool({ name: 'ugt_publish_design', arguments: { design: { schema: 'proposal/v3' }, confirm: true } })).isError).toBe(true);
        expect(tools.mintAgreement).not.toHaveBeenCalled();
        expect(tools.donate).not.toHaveBeenCalled();
        expect(tools.publishDesign).not.toHaveBeenCalled();
        const ok = await call({ agreementCid: CID, lamports: '1000', confirm: true });
        expect(ok.isError).not.toBe(true);
        expect(tools.mintAgreement).toHaveBeenCalledWith({ agreementCid: CID, lamports: '1000', confirm: true });
    });

    it('answers a tool\'s refusal as a tool error and serialises bigint results', async () => {
        const tools = stubTools();
        tools.betOnAgreement.mockRejectedValueOnce(new Error('agreement X is Executed; its market takes no more stakes'));
        tools.fundAgreement.mockResolvedValueOnce({ escrowLamports: 9000n, nested: { amount: 5n } });
        await connect(tools);
        const refused = await client.callTool({ name: 'ugt_bet_on_agreement', arguments: { agreementCid: CID, side: 'yes', amountUsdc: '0.01', confirm: true } });
        expect(refused).toMatchObject({ isError: true, structuredContent: { code: 'tool-failed', message: 'Tool request failed.', untrusted: { message: 'agreement X is Executed; its market takes no more stakes' }, next: { action: expect.any(String) } } });
        const funded = await client.callTool({ name: 'ugt_fund_agreement', arguments: { agreementCid: CID, targetLamports: '9000', confirm: true } });
        expect(funded.structuredContent).toEqual({ escrowLamports: '9000', nested: { amount: '5' } });
    });

    it('surfaces the real tool surface\'s refusal to mint a poll', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ugt-mcp-test-'));
        try {
            const keypairFile = path.join(directory, 'agent.json');
            const agent = Keypair.generate();
            fs.writeFileSync(keypairFile, JSON.stringify(Array.from(agent.secretKey)), { mode: 0o600 });
            const content = { schema: 'agreement/v1', title: 'A vote', sponsor: agent.publicKey.toBase58(), rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] } };
            const cid = cidOfObject(content);
            const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ cid, content }), { status: 200, headers: { 'content-type': 'application/json' } }));
            const tools = createUrbanGameTheoryTools({
                env: { UGT_API_BASE: 'https://api.example.test', UGT_MCP_LIVE: '1', UGT_AGENT_KEYPAIR: keypairFile },
                fetchImpl, createConnection: () => ({}), dependencies: { mintAgreement: vi.fn() }
            });
            await connect(tools);
            const result = await client.callTool({ name: 'ugt_mint_agreement', arguments: { agreementCid: cid, lamports: '0', confirm: true } });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/is a non-binding community vote: it is a poll in the index and is never minted/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
