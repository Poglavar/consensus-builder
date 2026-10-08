// Checkpointed, budgeted vision batches: retain raw responses and persist validated vector plans.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { computeCost,record } from '../../../agents/lib/llm-cost/index.mjs';
import { submitBatch,pollBatch } from '../../../agents/lib/llm-cost/batch.mjs';
import { fingerprint } from '../buildings/floor-models.js';
import { buildReadingRequest,parseReading,PROCESSOR,DEFAULT_MODEL,MAX_OUTPUT_TOKENS } from './plan-reading.js';

const exec=promisify(execFile);
const PROVIDER='anthropic';
export function taskContext(row) {
    return {building:{city:row.building_city,source:row.building_source,ownerId:row.building_owner_id||'',
        buildingId:row.building_id,name:row.building_evidence?.name||row.building_id,footprint:row.building_evidence?.footprint||null},
        facts:row.facts,matchEvidence:row.building_evidence};
}
function contextIdentity(context) {
    const b=context.building,f=context.facts;
    return [b.city,b.source,b.ownerId,b.buildingId,b.footprint,f.sourceId,f.address,f.coordinates,f.floor,f.unitId,f.areaM2,f.projectUrl];
}
export function taskId(hash,page,context) { return fingerprint([PROCESSOR,hash,page,contextIdentity(context)]); }

export async function enqueuePlanTasks(db,{limit=100,sourceHash=null,deadline=Infinity}={}) {
    const rows=(await db.query(`SELECT e.sha256,e.model,t.url AS source_url,l.url AS listing_url,l.facts,
        l.building_city,l.building_source,l.building_owner_id,l.building_id,l.building_evidence
        FROM floor_plan.extraction e JOIN floor_plan.target t ON t.current_sha256=e.sha256 AND t.kind='asset'
        JOIN floor_plan.listing l ON l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
        WHERE l.match_status='verified' AND l.building_id IS NOT NULL AND l.building_city IS NOT NULL
        AND (($1::text IS NULL AND e.status='needs_review' AND e.model->>'schema'='consensus-builder.floor-plan-draft.v1') OR e.sha256=$1)
        ORDER BY e.vision_checked_at NULLS FIRST,e.created_at,t.url,l.url LIMIT $2`,[sourceHash,limit])).rows;
    let enqueued=0,ambiguous=0,deferred=0;
    const sources=new Set();
    for(const row of rows) {
        if(Date.now()>=deadline) {deferred++;break;}
        if(sources.has(row.sha256)) continue;sources.add(row.sha256);
        const identities=(await db.query(`SELECT DISTINCT l.building_city,l.building_source,l.building_owner_id,l.building_id
            FROM floor_plan.target t JOIN floor_plan.listing l ON l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
            WHERE t.current_sha256=$1 AND l.match_status='verified' AND l.building_city IS NOT NULL AND l.building_id IS NOT NULL`,[row.sha256])).rows;
        await db.query('UPDATE floor_plan.extraction SET vision_checked_at=now() WHERE sha256=$1',[row.sha256]);
        if(identities.length!==1) {ambiguous++;continue;}
        const context=taskContext(row),pages=row.model?.totalPages||1;
        if(!Number.isInteger(pages)||pages<1||pages>1000) throw new Error('Invalid or oversized source page count.');
        for(let page=1;page<=pages;page++) {
            if(Date.now()>=deadline) {deferred++;break;}
            const id=taskId(row.sha256,page,context);
            const saved=await db.query(`INSERT INTO floor_plan.plan_task(id,source_sha256,source_url,page,listing_url,context,processor)
                VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
            [id,row.sha256,row.source_url,page,row.listing_url,JSON.stringify(context),PROCESSOR]);
            enqueued+=saved.rowCount;
        }
    }
    return {sources:sources.size,enqueued,ambiguous,deferred};
}

export async function renderTask(db,task,{python=process.env.FLOOR_PLAN_PYTHON||'python3',deadline=Infinity}={}) {
    const row=(await db.query('SELECT data FROM floor_plan.blob WHERE sha256=$1',[task.source_sha256])).rows[0];
    if(!row) throw new Error('Archived source bytes are missing.');
    const directory=await mkdtemp(join(tmpdir(),'floor-plan-vision-'));
    try {
        const source=join(directory,'source'),output=join(directory,'page.png');await writeFile(source,row.data);
        const {stdout}=await exec(python,[fileURLToPath(new URL('../scripts/render-floor-plan-page.py',import.meta.url)),source,output,'--page',String(task.page),'--grid'],{timeout:Math.max(1,Math.min(120000,deadline-Date.now())),maxBuffer:1024*1024});
        return {...JSON.parse(stdout),data:await readFile(output)};
    } finally {await rm(directory,{recursive:true,force:true});}
}

export async function currentTaskContext(db,task,{lock=false}={}) {
    const row=(await db.query(`SELECT l.* FROM floor_plan.listing l JOIN floor_plan.target t ON t.url=$2
        WHERE l.url=$1 AND l.match_status='verified' AND t.current_sha256=$3
        AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true)) ${lock?'FOR SHARE OF l,t':''}`,
    [task.listing_url,task.source_url,task.source_sha256])).rows[0];
    return Boolean(row) && fingerprint(contextIdentity(taskContext(row)))===fingerprint(contextIdentity(task.context));
}

export function reservationUsd(model,inputTokens,price=computeCost) {
    if(!Number.isInteger(inputTokens)||inputTokens<1) throw new Error('Token count required before submission.');
    // Count endpoint is an estimate; reserve 20% input headroom plus the full output allowance.
    return price(model,{input_tokens:Math.ceil(inputTokens*1.2)+1024,output_tokens:MAX_OUTPUT_TOKENS},{batch:true});
}

export async function budgetUsed(db) {
    const row=(await db.query(`SELECT COALESCE(sum(CASE WHEN b.status='complete' THEN
        COALESCE((SELECT sum(t.cost_usd) FROM floor_plan.plan_task t WHERE t.batch_id=b.id),0)
        ELSE b.reserved_usd END),0)::float AS usd FROM floor_plan.ai_batch b
        WHERE b.status<>'error' AND (b.status<>'complete' OR b.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`)).rows[0];
    return row.usd;
}

export async function storeReading(db,task,reading,{associationCurrent=true}={}) {
    let ready=0,needsReview=0;
    await db.query('BEGIN');
    try {
        for(const model of reading.plans) {
            if(!associationCurrent) model.quality.issues.push('Listing or source association changed after submission.');
            const status=model.quality.issues.length?'needs_review':'ready',b=task.context.building;
            const id=fingerprint([task.id,model.unitId]),hash=fingerprint(model);
            await db.query(`INSERT INTO floor_plan.processed_plan(id,task_id,region_id,city,source,owner_id,building_id,source_sha256,model,model_hash,status)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(task_id,region_id) DO NOTHING`,
            [id,task.id,model.unitId,b.city,b.source,b.ownerId,b.buildingId,task.source_sha256,JSON.stringify(model),hash,status]);
            const saved=(await db.query('SELECT model_hash,status FROM floor_plan.processed_plan WHERE id=$1',[id])).rows[0];
            if(saved?.model_hash!==hash) throw new Error('Processed vector plan read-back mismatch.');
            if(saved.status==='ready'||saved.status==='published')ready++;else needsReview++;
        }
        const status=reading.notPlan?'not_plan':needsReview||!reading.plans.length?'needs_review':'complete';
        await db.query(`UPDATE floor_plan.plan_task SET status=$2,result=result||$3::jsonb,error=NULL,updated_at=now() WHERE id=$1`,
            [task.id,status,JSON.stringify({reading})]);
        await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK');throw error;}
    return {ready,needsReview,notPlan:reading.notPlan?1:0};
}

export async function interpretPlans(db,{dailyBudgetUsd=0,chunkSize=1,model=DEFAULT_MODEL,submit=true,
    client,price=computeCost,ledger=record,render=renderTask,log=console.log,deadline=Infinity}={}) {
    if(!Number.isFinite(dailyBudgetUsd)||dailyBudgetUsd<0||!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>20) throw new Error('Invalid AI budget or chunk size (1..20).');
    const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-ai')) AS locked`)).rows[0].locked;
    if(!locked) throw new Error('Another floor-plan AI worker is running.');
    const result={submitted:0,collected:0,ready:0,needsReview:0,notPlan:0,failed:0,awaitingBatch:0,costUsd:0,budgetDeferred:0};
    try {
        // Never retry an ambiguous HTTP submission after a crash: it may already be billed.
        await db.query(`UPDATE floor_plan.ai_batch SET status='unknown',error='Submission interrupted; reconcile provider batch ID before retrying',updated_at=now() WHERE status='submitting'`);
        const pending=(await db.query(`SELECT * FROM floor_plan.ai_batch WHERE status='submitted' ORDER BY created_at`)).rows;
        if(pending.length || (submit&&dailyBudgetUsd>0)) client ||= new Anthropic({maxRetries:0,timeout:60000});
        const timeout=()=>Math.max(1,Math.min(60000,deadline-Date.now()));
        const timedClient=()=>client.withOptions?client.withOptions({timeout:timeout(),maxRetries:0}):client;
        for(const batch of pending) {
            if(Date.now()>=deadline) {result.awaitingBatch++;break;}
            const state=await pollBatch({client:timedClient(),provider:PROVIDER,batchId:batch.provider_id});
            if(!state.done) {
                result.awaitingBatch++;
                if(Date.now()-new Date(batch.created_at).getTime()>26*3600000) result.failed++;
                continue;
            }
            let collectionDeferred=false;
            for await(const entry of await timedClient().messages.batches.results(batch.provider_id)) {
                if(Date.now()>=deadline) {collectionDeferred=true;break;}
                const task=(await db.query('SELECT * FROM floor_plan.plan_task WHERE id=$1 AND batch_id=$2',[entry.custom_id,batch.id])).rows[0];
                if(!task) throw new Error('Batch returned an unknown task.');
                if(task.status!=='submitted') continue;
                if(entry.result?.type!=='succeeded') {
                    await db.query(`UPDATE floor_plan.plan_task SET status='error',error=$2,updated_at=now() WHERE id=$1`,[task.id,JSON.stringify(entry.result)]);
                    result.failed++;continue;
                }
                const message=entry.result.message,cost=price(message.model||batch.model,message.usage,{batch:true});
                if(!Number.isFinite(cost)||cost<0) throw new Error('Unpriced paid response; cannot continue without cost accounting.');
                const firstReceipt=task.cost_usd===null;
                await db.query(`UPDATE floor_plan.plan_task SET usage=$2,cost_usd=$3,result=result||$4::jsonb,updated_at=now() WHERE id=$1`,
                    [task.id,JSON.stringify(message.usage),cost,JSON.stringify({message})]);
                if(firstReceipt) ledger({repo:'consensus-builder',script:'floor-plan-vision',model:message.model||batch.model,
                    usage:message.usage,cost_usd:cost,batch:true,meta:{taskId:task.id,batchId:batch.provider_id,sourceSha256:task.source_sha256,page:task.page}});
                result.costUsd+=cost;
                try {
                    if(message.stop_reason!=='end_turn') throw new Error(`Incomplete model response: ${message.stop_reason}`);
                    const text=message.content.filter(p=>p.type==='text').map(p=>p.text).join('');
                    const reading=parseReading(text,task,{...task.result.image,model:message.model||batch.model});
                    const saved=await storeReading(db,task,reading,{associationCurrent:await currentTaskContext(db,task)});
                    for(const key of ['ready','needsReview','notPlan']) result[key]+=saved[key];
                } catch(error) {
                    await db.query(`UPDATE floor_plan.plan_task SET status='error',error=$2,updated_at=now() WHERE id=$1`,[task.id,error.message]);result.failed++;
                }
                result.collected++;log(JSON.stringify({at:new Date().toISOString(),stage:'vision-result',task:task.id,page:task.page,costUsd:cost,...result}));
            }
            const incomplete=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.plan_task WHERE batch_id=$1 AND status='submitted'`,[batch.id])).rows[0].n);
            if(collectionDeferred) {result.awaitingBatch++;break;}
            if(incomplete) throw new Error(`Completed batch omitted ${incomplete} task results.`);
            await db.query(`UPDATE floor_plan.ai_batch SET status='complete',updated_at=now() WHERE id=$1`,[batch.id]);
        }
        const unresolved=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.ai_batch WHERE status IN ('submitted','unknown')`)).rows[0].n);
        if(submit&&dailyBudgetUsd>0&&!unresolved&&Date.now()<deadline) {
            const tasks=(await db.query(`SELECT * FROM floor_plan.plan_task WHERE status='queued' AND processor=$2 ORDER BY created_at,id LIMIT $1`,[chunkSize,PROCESSOR])).rows;
            const requests=[],accepted=[];let reserve=0,used=await budgetUsed(db);
            for(const task of tasks) {
                if(Date.now()>=deadline) break;
                try {
                    if(!await currentTaskContext(db,task)) throw new Error('Source or building association changed before processing.');
                    const image=await render(db,task,{deadline}),request=buildReadingRequest(task,image,model);
                    if(Date.now()>=deadline) break;
                    const tokens=await client.messages.countTokens({model,system:request.params.system,messages:request.params.messages,output_config:request.params.output_config},{timeout:timeout()});
                    const maximum=reservationUsd(model,tokens.input_tokens,price);
                    if(used+reserve+maximum>dailyBudgetUsd) {result.budgetDeferred++;break;}
                    await db.query(`UPDATE floor_plan.plan_task SET result=$2,updated_at=now() WHERE id=$1`,[task.id,JSON.stringify({image:{width:image.width,height:image.height},reservedUsd:maximum})]);
                    requests.push(request);accepted.push(task);reserve+=maximum;
                } catch(error) {
                    await db.query(`UPDATE floor_plan.plan_task SET status='error',error=$2,updated_at=now() WHERE id=$1`,[task.id,error.message]);result.failed++;
                }
            }
            if(requests.length&&Date.now()<deadline) {
                const id=randomUUID();
                await db.query('BEGIN');
                try {
                    await db.query(`INSERT INTO floor_plan.ai_batch(id,model,status,reserved_usd) VALUES($1,$2,'submitting',$3)`,[id,model,reserve]);
                    await db.query(`UPDATE floor_plan.plan_task SET batch_id=$1,status='submitted',updated_at=now() WHERE id=ANY($2::text[])`,[id,accepted.map(task=>task.id)]);
                    await db.query('COMMIT');
                } catch(error) {await db.query('ROLLBACK');throw error;}
                try {
                    const providerId=await submitBatch({client:timedClient(),provider:PROVIDER,requests});
                    await db.query(`UPDATE floor_plan.ai_batch SET provider_id=$2,status='submitted',updated_at=now() WHERE id=$1`,[id,providerId]);
                    result.submitted=requests.length;result.awaitingBatch++;result.reservedUsd=reserve;
                    log(JSON.stringify({at:new Date().toISOString(),stage:'vision-submitted',batchId:providerId,items:requests.length,reservedUsd:reserve}));
                } catch(error) {
                    await db.query(`UPDATE floor_plan.ai_batch SET status='unknown',error=$2,updated_at=now() WHERE id=$1`,[id,error.message]);
                    throw error;
                }
            }
        }
        result.queued=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.plan_task WHERE status='queued' AND processor=$1`,[PROCESSOR])).rows[0].n);
        result.errors=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.plan_task WHERE status='error' AND processor=$1`,[PROCESSOR])).rows[0].n);
        result.unknownBatches=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.ai_batch WHERE status='unknown'`)).rows[0].n);
        result.status=result.failed||result.errors||result.unknownBatches||result.budgetDeferred?'partial':'complete';
        return result;
    } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-ai'))`);}
}
