// Persist and account for small, independently runnable image, plan, and building recognition batches.
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { computeCost } from '../../../agents/lib/llm-cost/index.mjs';
import { createLlm,DEFAULT_MAX_TOKENS } from '../../../agents/lib/llm-cost/llm.mjs';

const STAGES={images:{table:'image_task',script:'listing-image-classification'},plans:{table:'plan_task',script:'floor-plan-vision'},buildings:{table:'building_task',script:'ad-building-recognition'}};

export function reservationUsd(model,inputTokens,price=computeCost,maxOutputTokens=DEFAULT_MAX_TOKENS) {
    if(!Number.isInteger(inputTokens)||inputTokens<1) throw new Error('Token count required before submission.');
    if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<256||maxOutputTokens>DEFAULT_MAX_TOKENS) throw new Error('Invalid output token allowance.');
    return price(model,{input_tokens:Math.ceil(inputTokens*1.2)+1024,output_tokens:maxOutputTokens},{batch:true});
}

// The stages share one spend calculation and submission lock, while their queues and batches stay separate.
export async function budgetUsed(db) {
    const row=(await db.query(`SELECT COALESCE(sum(CASE WHEN b.status='complete' THEN
        COALESCE((SELECT sum(t.cost_usd) FROM floor_plan.plan_task t WHERE t.batch_id=b.id),0)
        +COALESCE((SELECT sum(t.cost_usd) FROM floor_plan.building_task t WHERE t.batch_id=b.id),0)
        +COALESCE((SELECT sum(t.cost_usd) FROM floor_plan.image_task t WHERE t.batch_id=b.id),0)
        ELSE b.reserved_usd END),0)::float AS usd FROM floor_plan.ai_batch b
        WHERE b.status<>'error' AND (b.status<>'complete' OR b.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`)).rows[0];
    return row.usd;
}

export function validBudget(value) {return value===Infinity||(Number.isFinite(value)&&value>=0);}

// An adapter supplies only domain preparation/validation/storage. Provider state, limits and costs live here.
export async function runBatchStage(db,adapter,{dailyBudgetUsd=0,chunkSize=1,submit=true,
    maxOutputTokens=DEFAULT_MAX_TOKENS,maxPayloadBytes=200000000,allowLargeImageBatch=false,taskIds=null,
    client,price=computeCost,log=console.log,deadline=Infinity}={}) {
    const stage=STAGES[adapter.stage];
    if(!stage) throw new Error('Unknown recognition stage.');
    const maxChunk=adapter.stage==='images'&&allowLargeImageBatch===true?500:20;
    if(!validBudget(dailyBudgetUsd)||!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>maxChunk)
        throw new Error(`Invalid AI budget or chunk size (1..${maxChunk}).`);
    if(taskIds!==null&&(!Array.isArray(taskIds)||taskIds.length<1||taskIds.length>500||
        taskIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||new Set(taskIds).size!==taskIds.length))
        throw new Error('taskIds must be a nonempty list of up to 500 unique SHA-256 task IDs.');
    if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<256||maxOutputTokens>DEFAULT_MAX_TOKENS) throw new Error('Invalid output token allowance.');
    if(!Number.isSafeInteger(maxPayloadBytes)||maxPayloadBytes<1||maxPayloadBytes>200000000)
        throw new Error('Invalid batch payload byte limit (1..200000000).');
    const table=`floor_plan.${stage.table}`;
    const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-ai')) AS locked`)).rows[0].locked;
    if(!locked) throw new Error('Another floor-plan recognition worker is running.');
    const result={stage:adapter.stage,submitted:0,collected:0,failed:0,awaitingBatch:0,costUsd:0,budgetDeferred:0,
        payloadDeferred:0,payloadBytes:0,...adapter.counters};
    const add=saved=>{for(const [key,value] of Object.entries(saved||{})) if(typeof value==='number')result[key]=(result[key]||0)+value;};
    const saveFailure=async(task,error)=>{
        await db.query(`UPDATE ${table} SET status='error',error=$2,updated_at=now() WHERE id=$1`,[task.id,error.message||String(error)]);
        result.failed++;
    };
    const apply=async(task,item)=>{
        try {
            if(item.error) throw new Error(`Incomplete structured response: ${item.error}`);
            add(await adapter.apply(db,task,item,{deadline}));
        } catch(error) {await saveFailure(task,error);}
        result.collected++;
        log(JSON.stringify({at:new Date().toISOString(),stage:`${adapter.stage}-result`,task:task.id,model:item.model,costUsd:item.costUsd,...result}));
    };
    try {
        // The shared lock proves no live worker owns these submitting rows. Never retry ambiguous submissions.
        await db.query(`UPDATE floor_plan.ai_batch SET status='unknown',error='Submission interrupted; reconcile provider batch ID before retrying',updated_at=now() WHERE status='submitting'`);
        const pending=(await db.query(`SELECT * FROM floor_plan.ai_batch WHERE status='submitted' AND stage=$1 ORDER BY created_at`,[adapter.stage])).rows;
        if(pending.length||(submit&&dailyBudgetUsd>0))client ||= new Anthropic({maxRetries:0,timeout:60000});
        const timeout=()=>Math.max(1,Math.min(60000,deadline-Date.now()));
        const timedClient=()=>client.withOptions?client.withOptions({timeout:timeout(),maxRetries:0}):client;
        const llm=()=>createLlm({client:timedClient(),repo:'consensus-builder',script:stage.script});
        for(const batch of pending) {
            if(Date.now()>=deadline) {result.awaitingBatch++;continue;}
            // A paid response is checkpointed before domain processing. Recover a crash there without another API/ledger read.
            const cached=(await db.query(`SELECT * FROM ${table} WHERE batch_id=$1 AND status='submitted' AND result ? 'paidResponse'`,[batch.id])).rows;
            for(const task of cached) await apply(task,task.result.paidResponse);
            const state=await llm().pollBatch(batch.provider_id);
            if(!state.done) {
                result.awaitingBatch++;
                if(Date.now()-new Date(batch.created_at).getTime()>26*3600000)result.failed++;
                continue;
            }
            const finished=(await db.query(`SELECT id FROM ${table} WHERE batch_id=$1 AND status<>'submitted'`,[batch.id])).rows;
            let collectionDeferred=false;
            for await(const item of llm().collectBatch(batch.provider_id,{schema:adapter.schema,skipCustomIds:finished.map(task=>task.id)})) {
                const task=(await db.query(`SELECT * FROM ${table} WHERE id=$1 AND batch_id=$2`,[item.customId,batch.id])).rows[0];
                if(!task) throw new Error('Batch returned an unknown task.');
                if(task.status!=='submitted')continue;
                if(item.reason==='errored') {
                    await saveFailure(task,new Error(item.error));
                } else {
                    if(!Number.isFinite(item.costUsd)||item.costUsd<0) throw new Error('Unpriced paid response; cannot continue without cost accounting.');
                    const response={model:item.model,stopReason:item.stopReason??null,error:item.error??null,text:item.text??null};
                    const paidResponse={...response,data:item.data??null,usage:item.usage,costUsd:item.costUsd};
                    await db.query(`UPDATE ${table} SET usage=$2,cost_usd=$3,result=result||$4::jsonb,updated_at=now() WHERE id=$1`,
                        [task.id,JSON.stringify(item.usage),item.costUsd,JSON.stringify({response,paidResponse})]);
                    result.costUsd+=item.costUsd;
                    await apply(task,item);
                }
                if(Date.now()>=deadline) {collectionDeferred=true;break;}
            }
            const incomplete=Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE batch_id=$1 AND status='submitted'`,[batch.id])).rows[0].n);
            if(incomplete&&collectionDeferred) {result.awaitingBatch++;break;}
            if(incomplete) throw new Error(`Completed batch omitted ${incomplete} task results.`);
            await db.query(`UPDATE floor_plan.ai_batch SET status='complete',updated_at=now() WHERE id=$1`,[batch.id]);
        }
        const unknown=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.ai_batch WHERE status='unknown'`)).rows[0].n);
        const ownPending=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.ai_batch WHERE status='submitted' AND stage=$1`,[adapter.stage])).rows[0].n);
        if(submit&&dailyBudgetUsd>0&&!unknown&&!ownPending&&Date.now()<deadline) {
            const tasks=(await db.query(`SELECT * FROM ${table} WHERE status='queued' AND processor=$2${taskIds===null?'':' AND id=ANY($3::text[])'}${adapter.taskFilterSql?` AND ${adapter.taskFilterSql}`:''} ORDER BY created_at,id LIMIT $1`,
                taskIds===null?[chunkSize,adapter.processor]:[chunkSize,adapter.processor,taskIds])).rows;
            const reader=llm(),requests=[],accepted=[];let reserve=0,used=await budgetUsed(db);
            let payloadBytes=Buffer.byteLength('{"requests":[]}');
            for(const task of tasks) {
                if(Date.now()>=deadline)break;
                try {
                    const prepared=await adapter.prepare(db,task,reader,{deadline,maxOutputTokens});
                    if(prepared.localResult) {
                        add(prepared.localResult);
                        log(JSON.stringify({at:new Date().toISOString(),stage:`${adapter.stage}-local-review`,task:task.id,...prepared.localResult}));
                        continue;
                    }
                    if(Date.now()>=deadline)break;
                    const {request}=prepared,{model,system,messages,output_config}=request.params;
                    const nextPayloadBytes=payloadBytes+Buffer.byteLength(JSON.stringify(request))+(requests.length?1:0);
                    if(nextPayloadBytes>maxPayloadBytes) {result.payloadDeferred++;break;}
                    const tokens=await timedClient().messages.countTokens({model,system,messages,...(output_config?{output_config}:{})},{timeout:timeout()});
                    const maximum=reservationUsd(model,tokens.input_tokens,price,request.params.max_tokens);
                    if(!Number.isFinite(maximum)||maximum<0)throw new Error('Invalid batch price reservation.');
                    if(used+reserve+maximum>dailyBudgetUsd) {result.budgetDeferred++;break;}
                    await db.query(`UPDATE ${table} SET result=result||$2::jsonb,updated_at=now() WHERE id=$1`,
                        [task.id,JSON.stringify({...prepared.evidence,reservedUsd:maximum})]);
                    requests.push(request);accepted.push(task);reserve+=maximum;payloadBytes=nextPayloadBytes;
                    result.payloadBytes=payloadBytes;
                } catch(error) {await saveFailure(task,error);}
            }
            if(requests.length&&Date.now()<deadline) {
                const id=randomUUID();
                await db.query('BEGIN');
                try {
                    await db.query(`INSERT INTO floor_plan.ai_batch(id,model,status,reserved_usd,stage) VALUES($1,$2,'submitting',$3,$4)`,[id,requests[0].params.model,reserve,adapter.stage]);
                    await db.query(`UPDATE ${table} SET batch_id=$1,status='submitted',updated_at=now() WHERE id=ANY($2::text[])`,[id,accepted.map(task=>task.id)]);
                    await db.query('COMMIT');
                } catch(error) {await db.query('ROLLBACK');throw error;}
                try {
                    const providerId=await reader.submitBatch(requests);
                    await db.query(`UPDATE floor_plan.ai_batch SET provider_id=$2,status='submitted',updated_at=now() WHERE id=$1`,[id,providerId]);
                    result.submitted=requests.length;result.awaitingBatch++;result.reservedUsd=reserve;
                    log(JSON.stringify({at:new Date().toISOString(),stage:`${adapter.stage}-submitted`,batchId:providerId,model:requests[0].params.model,
                        effort:requests[0].params.output_config?.effort??null,items:requests.length,reservedUsd:reserve}));
                } catch(error) {
                    await db.query(`UPDATE floor_plan.ai_batch SET status='unknown',error=$2,updated_at=now() WHERE id=$1`,[id,error.message]);
                    throw error;
                }
            }
        }
        result.queued=Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE status='queued' AND processor=$1`,[adapter.processor])).rows[0].n);
        result.errors=Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE status='error' AND processor=$1`,[adapter.processor])).rows[0].n);
        result.unknownBatches=unknown;
        result.status=result.failed||result.errors||unknown||result.budgetDeferred||result.payloadDeferred?'partial':'complete';
        return result;
    } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-ai'))`);}
}
