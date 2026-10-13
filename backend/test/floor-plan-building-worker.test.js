// Exercise both durable recognition queues through fake provider and database boundaries.
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
vi.mock('../floor-plans/blob-store.js',async importOriginal=>({
    ...await importOriginal(),readBlobRow:vi.fn(async row=>row.testBytes||null)
}));
const ledgerDir=vi.hoisted(()=>{
    const dir=`${(process.env.TMPDIR||'/tmp').replace(/\/$/,'')}/building-worker-${process.pid}-${Date.now()}`;
    process.env.LLM_COST_DIR=dir;return dir;
});
import {DEFAULTS} from '../../../agents/lib/llm-cost/llm.mjs';
import {LEDGER} from '../../../agents/lib/llm-cost/index.mjs';
import {validBudget,reservationUsd,budgetUsed,runBatchStage} from '../floor-plans/batch-worker.js';
import {buildingCandidates,enqueueBuildingTasks,recognizeBuildings,storeBuildingReading} from '../floor-plans/recognize-buildings.js';
import {addressedBuildings} from '../floor-plans/building-resolution.js';
import {prepareBuildingEvidence,parseBuildingReading,BUILDING_PROCESSOR} from '../floor-plans/building-reading.js';
import {BUILDING_SCHEMA} from '../floor-plans/building-reading-schema.js';

const model=DEFAULTS.providers.anthropic.model,hash='a'.repeat(64),url='https://agency.test/listing/1';
const raw=()=>({schema:'ad-building-reading.v1',isListing:true,
    address:{value:'Example Street 12',quote:'Example Street 12'},
    project:{name:'River House',quote:'River House',linkId:'L1'},
    candidateId:'C1',confidence:'medium',rationale:'Source address and project match C1.',issues:[]});
const packet=()=>prepareBuildingEvidence({url,sha256:hash,
    html:'<main>Apartment at Example Street 12 in River House <a href="/project/river-house">River House</a></main>',
    facts:{address:'Example Street 12'},candidates:[{address:'Example Street 12',name:'River House',distanceM:10,evidence:'Address inventory'}]});
const task=(id='t1',status='queued')=>({id,listing_url:url,source_sha256:hash,processor:BUILDING_PROCESSOR,
    context:packet(),candidate_map:[{id:'C1',city:'test-city',source:'survey',ownerId:'',buildingId:'42'}],
    status,batch_id:null,result:{},created_at:new Date().toISOString()});
const ledgerRows=()=>fs.existsSync(LEDGER)?fs.readFileSync(LEDGER,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];

function fakeDb({tasks=[],batches=[],budget=0,sourceHash=hash,readback=true}={}) {
    const state={tasks:structuredClone(tasks),batches:structuredClone(batches),calls:[]};
    const query=vi.fn(async(sql,args=[])=>{
        state.calls.push({sql,args});
        if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
        if(sql.includes('pg_advisory_unlock'))return {rows:[]};
        if(sql.startsWith("UPDATE floor_plan.ai_batch SET status='unknown'")){
            for(const batch of state.batches)if(batch.status==='submitting')batch.status='unknown';
            return {rows:[],rowCount:1};
        }
        if(sql.includes("FROM floor_plan.ai_batch WHERE status='submitted'")&&sql.includes('count(*)'))
            return {rows:[{n:state.batches.filter(batch=>batch.status==='submitted'&&batch.stage===args[0]).length}]};
        if(sql.includes("FROM floor_plan.ai_batch WHERE status='submitted'"))
            return {rows:state.batches.filter(batch=>batch.status==='submitted'&&batch.stage===args[0])};
        if(sql.includes("FROM floor_plan.ai_batch WHERE status='unknown'"))
            return {rows:[{n:state.batches.filter(batch=>batch.status==='unknown').length}]};
        if(sql.includes('COALESCE(sum(CASE WHEN b.status'))return {rows:[{usd:budget}]};
        if(sql.startsWith('SELECT * FROM floor_plan.building_task WHERE status=\'queued\''))
            return {rows:state.tasks.filter(task=>task.status==='queued'&&task.processor===args[1]).slice(0,args[0])};
        if(sql.includes("count(*) AS n FROM floor_plan.building_task WHERE status='queued'"))
            return {rows:[{n:state.tasks.filter(task=>task.status==='queued'&&task.processor===args[0]).length}]};
        if(sql.includes("count(*) AS n FROM floor_plan.building_task WHERE status='error'"))
            return {rows:[{n:state.tasks.filter(task=>task.status==='error'&&task.processor===args[0]).length}]};
        if(sql.startsWith('SELECT t.current_sha256 FROM floor_plan.target'))return {rows:[{current_sha256:sourceHash}]};
        if(sql.startsWith('UPDATE floor_plan.building_task SET result=result||$2')){
            const task=state.tasks.find(row=>row.id===args[0]);task.result={...task.result,...JSON.parse(args[1])};return {rows:[],rowCount:1};
        }
        if(sql.startsWith('INSERT INTO floor_plan.ai_batch')){
            state.batches.push({id:args[0],model:args[1],status:'submitting',reserved_usd:args[2],stage:args[3],created_at:new Date().toISOString()});
            return {rows:[],rowCount:1};
        }
        if(sql.startsWith("UPDATE floor_plan.building_task SET batch_id=$1,status='submitted'")){
            for(const task of state.tasks)if(args[1].includes(task.id)){task.batch_id=args[0];task.status='submitted';}
            return {rows:[],rowCount:args[1].length};
        }
        if(sql.startsWith("UPDATE floor_plan.ai_batch SET provider_id=$2,status='submitted'")){
            Object.assign(state.batches.find(batch=>batch.id===args[0]),{provider_id:args[1],status:'submitted'});
            return {rows:[],rowCount:1};
        }
        if(sql.includes("SELECT * FROM floor_plan.building_task WHERE batch_id=$1 AND status='submitted'"))
            return {rows:state.tasks.filter(task=>task.batch_id===args[0]&&task.status==='submitted'&&task.result.paidResponse)};
        if(sql.includes("SELECT id FROM floor_plan.building_task WHERE batch_id=$1 AND status<>'submitted'"))
            return {rows:state.tasks.filter(task=>task.batch_id===args[0]&&task.status!=='submitted').map(task=>({id:task.id}))};
        if(sql.includes('SELECT * FROM floor_plan.building_task WHERE id=$1 AND batch_id=$2'))
            return {rows:state.tasks.filter(task=>task.id===args[0]&&task.batch_id===args[1])};
        if(sql.includes('UPDATE floor_plan.building_task SET usage=$2,cost_usd=$3')){
            const task=state.tasks.find(row=>row.id===args[0]);Object.assign(task,{usage:JSON.parse(args[1]),cost_usd:args[2],result:{...task.result,...JSON.parse(args[3])}});
            return {rows:[],rowCount:1};
        }
        if(sql.startsWith('UPDATE floor_plan.building_task SET status=$2,result=result||$3')){
            const task=state.tasks.find(row=>row.id===args[0]);Object.assign(task,{status:args[1],result:{...task.result,...JSON.parse(args[2])}});
            return {rows:[],rowCount:1};
        }
        if(sql.startsWith('SELECT status,result FROM floor_plan.building_task')){
            const task=state.tasks.find(row=>row.id===args[0]);return {rows:[readback?{status:task.status,result:task.result}:{status:'error',result:{}}]};
        }
        if(sql.startsWith("UPDATE floor_plan.building_task SET status='error'")){
            Object.assign(state.tasks.find(row=>row.id===args[0]),{status:'error',error:args[1]});return {rows:[],rowCount:1};
        }
        if(sql.includes('count(*) AS n FROM floor_plan.building_task WHERE batch_id=$1'))
            return {rows:[{n:state.tasks.filter(task=>task.batch_id===args[0]&&task.status==='submitted').length}]};
        if(sql.startsWith("UPDATE floor_plan.ai_batch SET status='complete'")){
            state.batches.find(batch=>batch.id===args[0]).status='complete';return {rows:[],rowCount:1};
        }
        return {rows:[],rowCount:1};
    });
    return {state,query};
}

function fakeClient(entries=[]) {
    const create=vi.fn(async()=>({id:'provider-batch'}));
    const retrieve=vi.fn(async()=>({processing_status:'ended',request_counts:{succeeded:entries.length}}));
    const results=vi.fn(async()=>({async *[Symbol.asyncIterator](){for(const entry of entries)yield {custom_id:entry.id,
        result:{type:'succeeded',message:{model,stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:40},
            content:[{type:'text',text:JSON.stringify(entry.data||raw())}]}}};}}));
    const countTokens=vi.fn(async()=>({input_tokens:100}));
    const online=vi.fn(async()=>{throw new Error('No online completion is allowed.');});
    return {client:{withOptions(){return this;},messages:{create:online,countTokens,batches:{create,retrieve,results}}},
        create,retrieve,results,countTokens,online};
}

describe('building batch worker',()=>{
    it('requires the explicit street-and-house-number evidence schema',async()=>{
        const db={query:vi.fn(()=>{throw new Error('No address lookup is expected without an explicit location.');})};
        const facts={address:'Example Street 12',coordinates:{lat:45.8,lng:16.0},title:'River House'};
        expect(await buildingCandidates(db,{url,facts},{hasAddresses:true})).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });
    it('loads the address inventory once and reuses only exact-address rows for Zagreb listings',async()=>{
        const db={query:vi.fn(async()=>({rows:[
            {id:1,address:'Example Street 12, Zagreb',building_id:'42',footprint:{type:'Polygon'}},
            {id:2,address:'Example Street 12',building_id:'43',footprint:{type:'Polygon'}},
            {id:3,address:'Nearby Street 12',building_id:'99',footprint:{type:'Polygon'}},
        ]}))};
        const listing={url,facts:{explicitLocation:{schema:'explicit-listing-location.v1',street:'Example Street',houseNumber:'12'},
            locality:'Zagreb',address:'Nearby Street 12',coordinates:{lat:45.8,lng:16.0},title:'Apartment in River House'}};
        db.query.mockImplementationOnce(async()=>({rows:[{addresses:'buildings.dating_building',matches:'public.dgu_gdi_building_match',buildings:'public.gdi_building_3d'}]}));
        const addressRows=await addressedBuildings(db);
        const candidates=await buildingCandidates(db,listing,{addressRows});
        await buildingCandidates(db,{...listing,url:'https://agency.test/listing/2'},{addressRows});
        expect(candidates.map(candidate=>candidate.buildingId)).toEqual(['42','43']);
        expect(candidates.every(candidate=>candidate.address.includes('Example Street 12'))).toBe(true);
        expect(db.query).toHaveBeenCalledTimes(2);
        const sql=db.query.mock.calls[1][0];
        expect(sql).toContain('JOIN public.dgu_gdi_building_match');
        expect(sql).toContain('JOIN public.gdi_building_3d');
        expect(sql).toContain('m.building_overlap_ratio>=0.9');
        expect(sql).not.toContain('ST_DWithin');
    });
    it('does not query the Zagreb inventory for a different or unknown source city',async()=>{
        const db={query:vi.fn(()=>{throw new Error('No Zagreb inventory query is allowed for this listing.');})};
        const bindings=[{match_kind:'address',match_value:'example street 12',city:'zagreb',source:'zagreb-3d',building_id:'42'}];
        const explicitLocation={schema:'explicit-listing-location.v1',street:'Example Street',houseNumber:'12'};
        expect(await buildingCandidates(db,{url,facts:{explicitLocation,locality:'Split'}},{bindings,addressRows:new Map([['example street 12',[{address:'Example Street 12',building_id:'42'}]]])})).toEqual([]);
        expect(await buildingCandidates(db,{url,facts:{explicitLocation}},{bindings})).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });
    it('keeps enqueue off the Zagreb address inventory when selected listings are in another city',async()=>{
        const row={url,current_sha256:hash,sha256:hash,storage_path:'raw/aa/hash',byte_count:35,bytes_available:true,
            testBytes:Buffer.from('<main><p>Example Street 12</p></main>'),
            facts:{explicitLocation:{schema:'explicit-listing-location.v1',street:'Example Street',houseNumber:'12'},locality:'Split'}};
        const calls=[];
        const db={query:vi.fn(async(sql,args=[])=>{
            calls.push({sql,args});
            if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
            if(sql.startsWith('SELECT l.*,t.current_sha256,b.sha256'))return {rows:[row]};
            if(sql==='SELECT * FROM floor_plan.building_binding ORDER BY id')return {rows:[]};
            return {rows:[],rowCount:1};
        })};
        await enqueueBuildingTasks(db,{limit:1});
        const selection=calls.find(({sql})=>sql.startsWith('SELECT l.*,t.current_sha256,b.sha256'))?.sql;
        expect(selection).toContain('b.storage_path');
        expect(selection).toContain('b.bytes_available');
        expect(selection).not.toContain('b.data');
        expect(calls.some(({sql})=>sql.includes('to_regclass')||sql.includes('FROM buildings.dating_building'))).toBe(false);
        expect(calls.some(({sql})=>sql.includes('INSERT INTO floor_plan.building_task'))).toBe(true);
        const candidateMap=JSON.parse(calls.find(({sql})=>sql.includes('INSERT INTO floor_plan.building_task')).args[5]);
        expect(candidateMap).toEqual([]);
    });
    it('allows reviewed exact-address bindings, but ignores listing or project bindings',async()=>{
        const db={query:vi.fn(()=>{throw new Error('No address inventory configured.');})};
        const facts={explicitLocation:{schema:'explicit-listing-location.v1',street:'Example Street',houseNumber:'12'},locality:'Test City'};
        const bindings=[
            {id:'address-binding',match_kind:'address',match_value:'example street 12',city:'test-city',source:'authored',building_id:'42',name:'Example Building'},
            {id:'listing-binding',match_kind:'listing',match_value:url,city:'test-city',source:'authored',building_id:'43',name:'Listing Building'},
            {id:'project-binding',match_kind:'project',match_value:'https://agency.test/project/river-house',city:'test-city',source:'authored',building_id:'44',name:'River House'},
        ];
        expect(await buildingCandidates(db,{url,facts},{bindings})).toMatchObject([
            {buildingId:'42',address:'example street 12',bindingId:'address-binding'},
        ]);
        expect(db.query).not.toHaveBeenCalled();
    });
    it('shares budget, accepts explicit unlimited allowance, and still bounds chunk size',async()=>{
        expect(validBudget(Infinity)).toBe(true);
        const price=vi.fn(()=>0.25);
        expect(reservationUsd(model,100,price)).toBe(0.25);
        const db=fakeDb({budget:0.75});expect(await budgetUsed(db)).toBe(0.75);
        const budgetSql=db.state.calls.find(call=>call.sql.includes('COALESCE(sum(CASE WHEN b.status'))?.sql;
        expect(budgetSql).toContain('floor_plan.plan_task');
        expect(budgetSql).toContain('floor_plan.building_task');
        const remote=fakeClient(),work=fakeDb({tasks:[task()],budget:999});
        expect((await recognizeBuildings(work,{dailyBudgetUsd:Infinity,chunkSize:1,client:remote.client,price,
            log:()=>{}})).submitted).toBe(1);
        expect(remote.create).toHaveBeenCalledOnce();
        await expect(recognizeBuildings(fakeDb(),{dailyBudgetUsd:Infinity,chunkSize:21,client:remote.client})).rejects.toThrow(/chunk size/);
        expect(ledgerRows()).toHaveLength(0);
        expect(LEDGER.startsWith(ledgerDir)).toBe(true);
    });
    it('lets a building submission proceed while a plan batch is pending, but global unknown blocks it',async()=>{
        const pending={id:'plan-batch',stage:'plans',status:'submitted',provider_id:'plan-provider',created_at:new Date().toISOString()};
        const remote=fakeClient(),db=fakeDb({tasks:[task()],batches:[pending]});
        expect((await recognizeBuildings(db,{dailyBudgetUsd:1,client:remote.client,price:()=>0.25,log:()=>{}})).submitted).toBe(1);
        expect(remote.retrieve).not.toHaveBeenCalled();
        const unknown=fakeDb({tasks:[task()],batches:[{...pending,status:'unknown'}]});
        expect((await recognizeBuildings(unknown,{dailyBudgetUsd:1,client:remote.client,price:()=>0.25,log:()=>{}})).submitted).toBe(0);
        expect(unknown.state.tasks[0].status).toBe('queued');
    });
    it('lets a plan submission proceed while a building batch is pending',async()=>{
        const queued={id:'plan-1',processor:'test-plan',status:'queued'};
        const calls=[];
        const db={query:vi.fn(async(sql,args=[])=>{
            calls.push({sql,args});
            if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
            if(sql.includes("FROM floor_plan.ai_batch WHERE status='submitted'")&&sql.includes('count(*)'))return {rows:[{n:0}]};
            if(sql.includes("FROM floor_plan.ai_batch WHERE status='submitted'"))return {rows:[]};
            if(sql.includes("FROM floor_plan.ai_batch WHERE status='unknown'"))return {rows:[{n:0}]};
            if(sql.includes('COALESCE(sum(CASE WHEN b.status'))return {rows:[{usd:0.25}]};
            if(sql.includes("SELECT * FROM floor_plan.plan_task WHERE status='queued'"))return {rows:[queued]};
            if(sql.includes("count(*) AS n FROM floor_plan.plan_task WHERE status='queued'"))return {rows:[{n:0}]};
            if(sql.includes("count(*) AS n FROM floor_plan.plan_task WHERE status='error'"))return {rows:[{n:0}]};
            return {rows:[],rowCount:1};
        })};
        const remote=fakeClient();
        const adapter={stage:'plans',processor:'test-plan',schema:BUILDING_SCHEMA,counters:{},
            prepare:async(_db,task,llm)=>({request:llm.batchRequest(task.id,{system:'Test plan stage isolation',
                content:['source'],schema:BUILDING_SCHEMA,maxTokens:256}),evidence:{}}),apply:async()=>({})};
        expect((await runBatchStage(db,adapter,{dailyBudgetUsd:1,client:remote.client,price:()=>0.25,
            maxOutputTokens:256,log:()=>{}})).submitted).toBe(1);
        expect(remote.retrieve).not.toHaveBeenCalled();
        expect(calls.find(call=>call.sql.includes("FROM floor_plan.ai_batch WHERE status='submitted'"))?.args).toEqual(['plans','test-plan']);
    });
    it('replays a checkpointed paid response without collecting or recording a second charge',async()=>{
        const paid={model,data:raw(),text:JSON.stringify(raw()),usage:{input_tokens:100,output_tokens:40},costUsd:0.01};
        const queued=task('replay','submitted');queued.batch_id='local-batch';queued.result={paidResponse:paid};
        const db=fakeDb({tasks:[queued],batches:[{id:'local-batch',stage:'buildings',status:'submitted',provider_id:'provider-batch',created_at:new Date().toISOString()}]});
        const remote=fakeClient(),before=ledgerRows().length;
        const result=await recognizeBuildings(db,{dailyBudgetUsd:0,client:remote.client,log:()=>{}});
        expect(result).toMatchObject({candidates:1,collected:1,costUsd:0});
        expect(db.state.tasks[0].status).toBe('candidate');
        expect(remote.results).toHaveBeenCalledOnce();
        expect(ledgerRows()).toHaveLength(before);
    });
    it('skips a terminal custom ID before the shared ledger and records only the unfinished item',async()=>{
        const done=task('done','candidate');done.batch_id='local-batch';
        const pending=task('pending','submitted');pending.batch_id='local-batch';
        const db=fakeDb({tasks:[done,pending],batches:[{id:'local-batch',stage:'buildings',status:'submitted',provider_id:'provider-batch',created_at:new Date().toISOString()}]});
        const remote=fakeClient([{id:'done'},{id:'pending'}]),before=ledgerRows().length;
        const result=await recognizeBuildings(db,{dailyBudgetUsd:0,client:remote.client,log:()=>{}});
        expect(result).toMatchObject({collected:1,candidates:1,failed:0});
        expect(ledgerRows().length-before).toBe(1);
        expect(db.state.tasks.find(row=>row.id==='done').status).toBe('candidate');
        expect(db.state.batches[0].status).toBe('complete');
    });
    it('rejects read-back mismatch and never verifies a listing',async()=>{
        const reading=parseBuildingReading(raw(),task(),{model});
        const db=fakeDb({tasks:[task()],readback:false});
        await expect(storeBuildingReading(db,db.state.tasks[0],reading)).rejects.toThrow(/read-back mismatch/);
        expect(db.state.calls.some(({sql})=>/UPDATE floor_plan.listing|INSERT INTO floor_plan.building_binding/.test(sql))).toBe(false);
        const remote=fakeClient(),stale=fakeDb({tasks:[task()],sourceHash:'b'.repeat(64)});
        expect((await recognizeBuildings(stale,{dailyBudgetUsd:1,client:remote.client,price:()=>0.25,log:()=>{}})).failed).toBe(1);
        expect(stale.state.tasks[0].status).toBe('error');
        expect(remote.create).not.toHaveBeenCalled();
    });
    it('marks a paid building task as error when its reading fails durable read-back',async()=>{
        const pending=task('bad-readback','submitted');pending.batch_id='local-batch';
        const db=fakeDb({tasks:[pending],readback:false,
            batches:[{id:'local-batch',stage:'buildings',status:'submitted',provider_id:'provider-batch',created_at:new Date().toISOString()}]});
        const remote=fakeClient([{id:'bad-readback'}]);
        const result=await recognizeBuildings(db,{dailyBudgetUsd:0,client:remote.client,log:()=>{}});
        expect(result).toMatchObject({failed:1,collected:1,candidates:0});
        expect(db.state.tasks[0]).toMatchObject({status:'error',error:expect.stringContaining('read-back mismatch')});
        expect(db.state.calls.some(({sql})=>/UPDATE floor_plan.listing|INSERT INTO floor_plan.building_binding/.test(sql))).toBe(false);
    });
});
