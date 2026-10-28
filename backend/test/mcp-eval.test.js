// Evaluation scoring checks returned artifact content; model prose cannot turn a failed task green.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as turf from '@turf/turf';
import { buildEvalTasks, buildDiscoveryEvalTasks } from '../agents/mcp-eval-tasks.js';
import { scoreArtifact, scoreConversation, runEval, assertEvalPublication } from '../scripts/mcp-eval.mjs';
import { createMcpHttpService } from '../agents/mcp-http.mjs';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { acceptanceFixtures } from '../scripts/mcp-acceptance-fixtures.mjs';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { createTestPreviewLinks } from './helpers/mcp-preview-store.js';
import { agreementObject, communityRule, noMoney, parcelOutputs } from '../agents/agreement-objects.js';
import { assertContractResult } from '../scripts/mcp-check-contracts.mjs';
import { cidOfObject } from '../cid.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
describe('MCP agent evaluation artifacts', () => {
    it('creates thirty concrete tasks including all fourteen constructors from a source fixture and an optional bet task', () => {
        const seed = { city: 'london', parcelSourceId: 'test', parcelIds: ['A'], streetPoints: [[0, 0], [0.001, 0]] };
        expect(buildEvalTasks(seed)).toHaveLength(30);
        expect(new Set(buildEvalTasks(seed).map(task=>task.constructionType).filter(Boolean)).size).toBe(14);
        expect(buildDiscoveryEvalTasks({city:'london',query:'a riverside park'})).toHaveLength(2);
        expect(buildDiscoveryEvalTasks().every(task=>!task.request.includes('oss-wfs'))).toBe(true);
        expect(buildEvalTasks({ ...seed, agreementAccount: '11111111111111111111111111111111' })).toHaveLength(31);
    });
    it('rejects invented CIDs, wrong lane counts and narrative-only claims', () => {
        const design = builder.build({ kind: 'road', city: 'london', points: [[0, 0], [0.001, 0]], preset: '1+1' }, { turf });
        const previewUrl = `https://app.example/designs?draft=${encodeURIComponent(`https://mcp.example/mcp/previews/${'a'.repeat(32)}`)}`;
        const artifact = { untrusted: { design }, cid: cidOfObject(design), takes: ['A'], previewUrl, previewStatus: 'private-link' };
        const task = { expected: { goal: 'road-track', drivingLanes: 2, cycleLanes: 0 } };
        expect(scoreArtifact(task, [artifact]).passed).toBe(true);
        expect(scoreArtifact(task, [{ untrusted: { design: { schema: 'design/v1', description: 'Schema descriptor' } } }, artifact]).passed).toBe(true);
        expect(scoreArtifact(task, [{ ...artifact, previewUrl: `https://app.example/designs#draft=${'a'.repeat(32)}` }]).passed).toBe(false);
        expect(scoreArtifact({ expected: { ...task.expected, drivingLanes: 4 } }, [artifact]).passed).toBe(false);
        expect(scoreArtifact(task, [{ ...artifact, cid: 'invented' }])).toEqual({ passed: false, reason: 'cid-mismatch' });
        expect(scoreArtifact(task, [{ message: 'I made a road.' }]).passed).toBe(false);
        const record = { artifacts: [artifact], messages: [{ role: 'assistant', content: [{ type: 'text', text: artifact.previewUrl + 'corrupted' }] }] };
        expect(scoreConversation(task, record)).toEqual({ passed: false, reason: 'preview-link-not-delivered' });
        record.messages[0].content[0].text = artifact.previewUrl.replace('aaaa', 'bbbb');
        expect(scoreConversation(task, record)).toEqual({ passed: false, reason: 'preview-link-not-delivered' });
        record.messages[0].content[0].text = artifact.previewUrl;
        expect(scoreConversation(task, record).passed).toBe(true);
        const forkDesign = { ...design, origin: { cid: 'a copied object that was never returned' } };
        const forkArtifact = { ...artifact, untrusted: { design: forkDesign }, cid: cidOfObject(forkDesign) };
        const forkTask = { expected: { ...task.expected, origin: true } };
        record.artifacts.push(forkArtifact);
        expect(scoreConversation(forkTask, record)).toEqual({ passed: false, reason: 'fork-source-not-returned' });
        forkDesign.origin.cid = artifact.cid; forkArtifact.cid = cidOfObject(forkDesign);
        expect(scoreConversation(forkTask, record).passed).toBe(true);
    });
    it('measures widening against the returned origin instead of accepting unchanged fork geometry', () => {
        const original = builder.build({ kind: 'road', points: [[0,0],[0.001,0]], preset: '1+1' }, { turf });
        const preview = design => ({ design, cid: cidOfObject(design), takes: [], previewStatus: 'private-link', previewUrl: 'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
        const before = preview(original), unchanged = preview({ ...original, origin: { cid: before.cid } });
        const task = { expected: { goal: 'road-track', origin: true, widthIncreaseM: 2 } };
        expect(scoreArtifact(task, [before, unchanged]).passed).toBe(false);
        const changed = builder.modify(original, [{ type: 'widen', metres: 2, side: 'both' }], { turf });
        changed.origin = { cid: before.cid };
        const after = preview(changed);
        expect(scoreArtifact(task, [before, after]).passed).toBe(true);
        expect(scoreArtifact(task, [after]).passed).toBe(false);
        expect(scoreConversation(task, { artifacts: [before, after], messages: [{ role: 'assistant', content: [{ type: 'text', text: after.previewUrl }] }] }).passed).toBe(true);
    });
    it('scores actual named-plan membership, title, view and immutable revision lineage', () => {
        const road = builder.build({ kind:'road',points:[[0,0],[0.001,0]] },{turf});
        const park = builder.build({ kind:'space',spaceKind:'park',site:{type:'Polygon',coordinates:[[[0,0],[.001,0],[.001,.001],[0,.001],[0,0]]]} },{turf});
        const designs = [road,park].map(design=>({design,cid:cidOfObject(design)}));
        const make = (plan,extra={})=>({plan,cid:cidOfObject(plan),previewStatus:'private-link',previewUrl:'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',...extra});
        const before=make(PlanRecord.create('Before',designs.map(row=>row.cid),{at:'0,0,17',mode:'model'}));
        const after=make(PlanRecord.create('Housing revision',[designs[0].cid],{at:'0,0,17',mode:'2d'}),{previousCid:before.cid});
        const task={expected:{schema:'plan/v1',title:'Housing revision',mode:'2d',designCount:1,revision:true,removedGoal:'park'}};
        expect(scoreArtifact(task,[...designs,before,after]).passed).toBe(true);
        expect(scoreArtifact(task,[...designs,after]).passed).toBe(false);
        expect(scoreArtifact(task,[before,after]).passed).toBe(false);
        expect(scoreArtifact({...task,expected:{...task.expected,mode:'photo'}},[...designs,before,after]).passed).toBe(false);
    });
    it('requires real discovery and ordered source-error recovery rather than successful artifact prose', () => {
        const design=builder.build({kind:'space',spaceKind:'park',site:{type:'Polygon',coordinates:[[[0,0],[.001,0],[.001,.001],[0,.001],[0,0]]]}},{turf});
        const artifact={design,cid:cidOfObject(design),takes:['A'],previewStatus:'private-link',previewUrl:'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
        const task={expected:{goal:'park',sourceRecovery:true,requiredTools:['ugt_list_sources']}};
        const record={artifacts:[artifact],messages:[{role:'assistant',content:[{type:'text',text:artifact.previewUrl}]}],calls:[]};
        expect(scoreConversation(task,record).reason).toBe('required-discovery-not-used');
        record.calls=[{tool:'ugt_list_sources',isError:false}];expect(scoreConversation(task,record).reason).toBe('source-recovery-not-demonstrated');
        record.calls=[{tool:'ugt_draft_space',isError:true,result:{code:'parcel-source-required'}},{tool:'ugt_list_sources',isError:false},{tool:'ugt_draft_space',isError:false}];
        expect(scoreConversation(task,record).passed).toBe(true);
    });
    it('requires explicit staging publication authorization and rejects production before any work',async()=>{
        expect(assertEvalPublication({origin:'https://urbangametheory.xyz'})).toBe(false);
        for(const origin of ['https://urbangametheory.xyz','https://api.urbangametheory.xyz','https://unrelated.example'])expect(()=>assertEvalPublication({origin,allowPublication:true,confirmPublication:true,publicationOrigin:origin})).toThrow(/production is forbidden/);
        expect(()=>assertEvalPublication({origin:'https://staging.example',allowPublication:true,publicationOrigin:'https://staging.example'})).toThrow(/explicit/);
        expect(assertEvalPublication({origin:'https://staging.example',allowPublication:true,confirmPublication:true,publicationOrigin:'https://staging.example'})).toBe(true);
        const recordUsage=vi.fn(),create=vi.fn();
        await expect(runEval({origin:'https://urbangametheory.xyz',allowPublication:true,confirmPublication:true,publicationOrigin:'https://urbangametheory.xyz',tasks:[],anthropic:{messages:{batches:{create}}},recordUsage})).rejects.toThrow(/production is forbidden/);
        expect(create).not.toHaveBeenCalled();expect(recordUsage).not.toHaveBeenCalled();
    });
    it('checks contract semantics rather than marking any addressed content successful',()=>{
        const design=builder.build({kind:'road',points:[[0,0],[.001,0]]},{turf});
        const result={design,cid:cidOfObject(design),draftRef:'https://mcp.example/mcp/previews/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',previewUrl:'https://app.example/designs?draft=x',previewStatus:'private-link'};
        expect(assertContractResult('ugt_draft_road',result,{})).toBe(true);
        expect(()=>assertContractResult('ugt_draft_space',result,{spaceKind:'park'})).toThrow(/Wrong design goal/);
        expect(()=>assertContractResult('ugt_modify_design',result,{changes:[{type:'retitle',value:'Requested title'}]})).toThrow(/title edit/);
        expect(()=>assertContractResult('ugt_list_sources',{items:[{}],total:1})).toThrow(/typed source/);
    });
    it('executes all fourteen acceptance constructor fixtures against real generators and source-qualified refs without publication',async()=>{
        const site={type:'Polygon',coordinates:[[[15,45],[15.002,45],[15.002,45.002],[15,45.002],[15,45]]]};
        const sourceId='eval-parcels',parcel={type:'Feature',id:'A',properties:{parcelId:'A'},geometry:site};
        const existingDesign=builder.build({kind:'space',spaceKind:'park',site,city:'london',authoredAt:'2026-10-25T00:00:00.000Z'},{turf});
        const agreement=agreementObject({title:'Existing',city:'london',createdAt:'2026-10-25T00:00:00.000Z',designs:[{cid:cidOfObject(existingDesign),goal:'park'}],
            parcels:[{parcelId:'A',parcelSourceId:sourceId,areaM2:turf.area(parcel),holders:[]}],outputs:parcelOutputs([{parcelId:'A',geometry:site,areaM2:turf.area(parcel)}]),rule:communityRule([]),money:noMoney('GBP')});
        const paths=[];
        const fetchImpl=async(url,init={})=>{
            const path=new URL(url).pathname;paths.push(path);
            if(path.startsWith('/agreements/'))return Response.json({cid:agreement.cid,content:agreement.content,parcelSourceId:sourceId,onchain:{account:'fixture-account'}});
            if(path===`/plans/${agreement.content.planCid}`)return Response.json(agreement.plan);
            if(path===`/parcel-sources/${sourceId}`)return Response.json({complete:true,features:[parcel]});
            if(path==='/designs/binding')return Response.json({parcelSourceId:sourceId,binding:{coverage:'complete',parcels:[{parcelId:'A'}],unknownM2:0,unsurveyedM2:0}});
            throw new Error(`Unexpected source or publication request ${init.method||'GET'} ${path}`);
        };
        const fixtures=await acceptanceFixtures({apiBase:'https://api.example',appOrigin:'https://app.example',agreementCid:agreement.cid,fetchImpl});
        expect(fixtures.constructionCases).toHaveLength(14);
        const tools=createUrbanGameTheoryTools({mode:'hosted',env:{UGT_API_BASE:'https://api.example',UGT_APP_ORIGIN:'https://app.example'},fetchImpl});
        const previews=createTestPreviewLinks({origin:'https://mcp.example',appOrigin:'https://app.example'});
        const methods={ugt_draft_building:'draftBuilding',ugt_draft_road:'draftRoad',ugt_draft_track:'draftTrack',ugt_draft_station:'draftStation',ugt_draft_space:'draftSpace',ugt_draft_parcel_layout:'draftParcelLayout'};
        for(const test of fixtures.constructionCases){
            const result=previews.decorate(await tools[methods[test.tool]](test.arguments));
            expect(assertContractResult(test.tool,result,test.arguments),test.id).toBe(true);
        }
        expect(paths).toContain(`/plans/${agreement.content.planCid}`);expect(paths).not.toContain('/pins');expect(paths).not.toContain('/designs');
    });
    it('scores verified published design receipts from their canonical index row',()=>{
        const design=builder.build({kind:'road',points:[[0,0],[.001,0]]},{turf}),cid=cidOfObject(design);
        const result={cid,row:{untrusted:{content:design},binding:{parcels:[{parcelId:'A'}]}},publication:'published',url:`https://staging.example/designs/${cid}`};
        expect(scoreArtifact({expected:{goal:'road-track',publication:true,parcelIds:['A']}},[result]).passed).toBe(true);
        expect(scoreArtifact({expected:{goal:'road-track',publication:true}},[{...result,url:'https://staging.example/designs/wrong'}]).passed).toBe(false);
    });
    it('scores the actual approval target, amount and side', () => {
        const task = { expected: { action: 'bet', target: 'account', amount: '0.05', side: 'yes' } };
        expect(scoreArtifact(task, [{ approvalUrl: 'https://app.example/bets/account?act=bet&amount=0.05&side=yes' }]).passed).toBe(true);
        expect(scoreArtifact(task, [{ approvalUrl: 'https://app.example/bets/account?act=bet&amount=5&side=yes' }]).passed).toBe(false);
    });
});

describe('paid evaluation orchestration without a paid API', () => {
    async function fixture() {
        const args = { city: 'london', points: [[0, 0], [0.001, 0]], preset: '1+1' };
        const design = builder.build({ ...args, kind: 'road' }, { turf });
        const directory = mkdtempSync(join(tmpdir(), 'ugt-mcp-eval-'));
        const service = createMcpHttpService({ env: {}, storeDirectory: join(directory, 'drafts'), factory: () => createUrbanGameTheoryMcpServer({ mode: 'hosted', env: {}, tools: {
            draftRoad: () => ({ design, cid: cidOfObject(design), takes: ['A'], previewUrl: 'https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', previewStatus: 'private-link' })
        } }) });
        service.http.listen(0, '127.0.0.1'); await once(service.http, 'listening');
        const requests = [];
        const anthropic = { messages: { batches: {
            create: vi.fn(async request => { requests.push(request); return { id: `batch-${requests.length}` }; }),
            retrieve: vi.fn(async () => ({ processing_status: 'ended' })),
            async *results(id) { yield { result: { type: 'succeeded', message: { model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 50 },
                content: id === 'batch-1' ? [{ type: 'tool_use', id: 'draft-1', name: 'ugt_draft_road', input: args }]
                    : [{ type: 'text', text: 'The returned preview is ready: https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] } } }; }
        } } };
        const options = { origin: `http://127.0.0.1:${service.http.address().port}`, model: 'fixture-model', budgetUsd: 1,
            inputUsdPerMillion: 1, outputUsdPerMillion: 5, output: join(directory, 'checkpoint.json'),
            tasks: [{ id: 'street', request: 'Draft a road.', expected: { goal: 'road-track', drivingLanes: 2 } }], anthropic, recordUsage: vi.fn() };
        return { service, options, requests, args };
    }
    it('records two rounds, excludes publication, scores the actual draft and resumes without another submission', async () => {
        const { service, options, requests } = await fixture();
        try {
            const state = await runEval(options);
            expect(state.tasks[0].score.passed).toBe(true);
            expect(requests[0].requests[0].params.system).toContain('Inspect ugt_capabilities first');
            expect(requests[0].requests[0].params.system).toContain('ugt_list_sources');
            expect(state.tasks[0].calls[0].tool).toBe('ugt_draft_road');
            expect(state.spentUsd).toBeCloseTo(0.0007);
            expect(options.recordUsage).toHaveBeenCalledTimes(2);
            expect(requests[0].requests[0].params.tools.some(t => /publish|propose_agreement/.test(t.name))).toBe(false);
            expect((await runEval(options)).spentUsd).toBeCloseTo(state.spentUsd);
            expect(options.anthropic.messages.batches.create).toHaveBeenCalledTimes(2);
        } finally { await service.close(); }
    });
    it('refuses a request whose reserved cost exceeds the cap before submitting anything', async () => {
        const { service, options } = await fixture();
        try {
            await expect(runEval({ ...options, budgetUsd: 0.00001 })).rejects.toThrow(/Budget exhausted/);
            expect(options.anthropic.messages.batches.create).not.toHaveBeenCalled();
        } finally { await service.close(); }
    });
    it('does not submit again after an uncertain submission outcome', async () => {
        const { service, options } = await fixture();
        options.anthropic.messages.batches.create.mockRejectedValue(new Error('Connection lost after submission'));
        try {
            await expect(runEval(options)).rejects.toThrow(/Connection lost/);
            await expect(runEval(options)).rejects.toThrow(/outcome is uncertain/);
            expect(options.anthropic.messages.batches.create).toHaveBeenCalledTimes(1);
        } finally { await service.close(); }
    });
    it('continues the same failed task with its accumulated spend and remaining round budget', async () => {
        const { service, options, args } = await fixture();
        options.anthropic.messages.batches.results = async function * (id) {
            yield { result: { type: 'succeeded', message: { model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 50 },
                content: id === 'batch-2' ? [{ type: 'tool_use', id: 'retry-draft', name: 'ugt_draft_road', input: args }]
                    : [{ type: 'text', text: id === 'batch-1' ? 'The server was unavailable.' : 'The draft is ready: https://app.example/designs?draft=https%3A%2F%2Fmcp.example%2Fmcp%2Fpreviews%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] } } };
        };
        try {
            expect((await runEval(options)).tasks[0].score.passed).toBe(false);
            const result = await runEval({ ...options, retryFailed: true });
            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0].score.passed).toBe(true);
            expect(result.tasks[0].rounds).toHaveLength(3);
            expect(result.spentUsd).toBeCloseTo(0.00105);
        } finally { await service.close(); }
    });
});
