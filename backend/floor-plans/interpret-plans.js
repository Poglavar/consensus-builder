// Source-plan geometry requires a current source and owner; the shared worker owns provider state and spend.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCost } from '../../../agents/lib/llm-cost/index.mjs';
import { fingerprint } from '../buildings/floor-models.js';
import { buildReadingRequest,parseReading,PROCESSOR,MAX_OUTPUT_TOKENS } from './plan-reading.js';
import { READING_SCHEMA } from './reading-schema.js';
import { verifyRasterEvidence } from './raster-evidence.js';
import { sourceGeometry } from './source-geometry.js';
import {runBatchStage,reservationUsd,budgetUsed} from './batch-worker.js';
import {locatedListingSql,PROCESSABLE_PLAN_TASK_SQL} from './building-location.js';
import { sourcePlanAssetSql } from './source-policy.js';
import { readBlob } from './blob-store.js';
import { listingUnitId, selectListingUnitReading, sourceUnitMatches } from './original-plan-sources.js';

const exec=promisify(execFile);
export function taskContext(row) {
    const facts=row.facts||{};
    const listingUrl=row.listing_url||row.url;
    return {listingUrl,facts:{floor:facts.floor??null,unitId:listingUnitId(facts,listingUrl),areaM2:facts.areaM2??null}};
}
class PaidGeometryValidationError extends Error {
    constructor(cause) {
        super(`Paid model geometry failed validation: ${cause.message}`,{cause});
        this.name='PaidGeometryValidationError';
    }
}
function isPaidGeometryValidationError(error) {
    return error instanceof Error&&(
        error.message==='Geometry exceeds the measured source frame.'
        ||error.message==='Slab boundary contains a point that is not a measured source anchor.'
        ||error.message==='Selected geometry is outside the source image.'
        ||/^architecture\.[a-z][a-zA-Z]*:/.test(error.message));
}
function parsePaidReading(item,task,image) {
    try {
        const raw=typeof item.data==='string'?JSON.parse(item.data):item.data??JSON.parse(item.text);
        return parseReading(JSON.stringify(selectListingUnitReading(raw,task.context.facts?.unitId)),task,
            {...image,model:item.model});
    } catch(error) {
        if(!isPaidGeometryValidationError(error))throw error;
        throw new PaidGeometryValidationError(error);
    }
}
// A drawing is read once per page and per stated facts. The same project published under several
// URLs (hosts, languages) states the same facts and shares one reading; units that reuse one sheet
// with different floors or areas still get their own.
function contextIdentity(context) {
    const f=context.facts||{};
    return [f.floor??null,f.unitId??null,f.areaM2??null];
}
export function taskId(hash,page,context) { return fingerprint([PROCESSOR,hash,page,contextIdentity(context)]); }

export async function enqueuePlanTasks(db,{limit=100,sourceHash=null,urls=null,pages=null,deadline=Infinity}={}) {
    if(sourceHash!==null&&!/^[a-f0-9]{64}$/i.test(sourceHash))throw new Error('Invalid source SHA-256.');
    if(urls!==null&&(!Array.isArray(urls)||urls.some(url=>typeof url!=='string'||!/^https?:\/\//.test(url))))throw new Error('Invalid source URL filter.');
    if(pages!==null&&(!Array.isArray(pages)||!pages.length||new Set(pages).size!==pages.length
        ||pages.some(page=>!Number.isInteger(page)||page<1||page>1000)))throw new Error('Pages must be a nonempty unique array of integers from 1 to 1000.');
    const rows=(await db.query(`SELECT e.sha256,e.model,t.url AS source_url,l.url AS listing_url,l.facts,
        (l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))) AS listing_owns_asset
        FROM floor_plan.extraction e JOIN floor_plan.target t ON t.current_sha256=e.sha256 AND t.kind='asset'
        JOIN floor_plan.listing l ON l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
        WHERE (($1::text IS NULL AND e.status='needs_review' AND e.model->>'schema'='consensus-builder.floor-plan-draft.v1') OR e.sha256=$1)
        AND l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
        AND t.exclusion_reason IS NULL AND ${sourcePlanAssetSql()}
        AND ($3::text[] IS NULL OR t.url=ANY($3::text[]) OR l.url=ANY($3::text[]))
        ORDER BY e.vision_checked_at NULLS FIRST,e.created_at,t.url,l.url LIMIT $2`,[sourceHash,limit,urls])).rows;
    let enqueued=0,ambiguous=0,deferred=0,sharedSources=0;
    const sources=new Set(),seenContexts=new Set();
    for(const row of rows) {
        if(Date.now()>=deadline) {deferred++;break;}
        if(row.listing_owns_asset!==true||!row.listing_url||!row.source_url) {ambiguous++;continue;}
        if(!sourceUnitMatches(row.facts,row.listing_url,row.source_url)) {ambiguous++;continue;}
        const context=taskContext(row),totalPages=row.model?.totalPages??1;
        if(!Number.isInteger(totalPages)||totalPages<1||totalPages>1000) throw new Error('Invalid or oversized source page count.');
        if(pages?.some(page=>page>totalPages))throw new Error(`Requested page exceeds source page count (${totalPages}).`);
        const selectedPages=pages?[...pages].sort((a,b)=>a-b):Array.from({length:totalPages},(_,index)=>index+1);
        const contextKey=fingerprint([row.sha256,contextIdentity(context)]);
        if(seenContexts.has(contextKey))continue;
        seenContexts.add(contextKey);
        if(sources.has(row.sha256))sharedSources++;else {
            sources.add(row.sha256);
            await db.query('UPDATE floor_plan.extraction SET vision_checked_at=now() WHERE sha256=$1',[row.sha256]);
        }
        for(const page of selectedPages) {
            if(Date.now()>=deadline) {deferred++;break;}
            const id=taskId(row.sha256,page,context);
            const saved=await db.query(`INSERT INTO floor_plan.plan_task(id,source_sha256,source_url,page,listing_url,context,processor)
                VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
            [id,row.sha256,row.source_url,page,row.listing_url,JSON.stringify(context),PROCESSOR]);
            enqueued+=saved.rowCount;
        }
    }
    return {sources:sources.size,enqueued,ambiguous,sharedSources,deferred};
}

export async function renderTask(db,task,{python=process.env.FLOOR_PLAN_PYTHON||'python3',deadline=Infinity,includeEvidence=true}={}) {
    const bytes=await readBlob(db,task.source_sha256);
    if(!bytes) throw new Error('Archived source bytes are missing.');
    const directory=await mkdtemp(join(tmpdir(),'floor-plan-vision-'));
    try {
        const source=join(directory,'source'),output=join(directory,'page.png');await writeFile(source,bytes);
        const timeout=()=>Math.max(1,Math.min(120000,deadline-Date.now()));
        const {stdout}=await exec(python,[fileURLToPath(new URL('../scripts/render-floor-plan-page.py',import.meta.url)),source,output,'--page',String(task.page)],{timeout:timeout(),maxBuffer:1024*1024});
        const image={...JSON.parse(stdout),data:await readFile(output)};
        if(includeEvidence) {
            const evidence=join(directory,'evidence.json'),annotation=join(directory,'candidates.png'),scaleAnnotation=join(directory,'scales.png');
            await exec(python,[fileURLToPath(new URL('../scripts/extract-floor-plan-evidence.py',import.meta.url)),output,'--evidence',evidence,'--annotation',annotation],{timeout:timeout(),maxBuffer:1024*1024});
            image.evidence=sourceGeometry(JSON.parse(await readFile(evidence,'utf8')));
            await writeFile(evidence,JSON.stringify(image.evidence));
            const {stdout:annotationOutput}=await exec(python,[fileURLToPath(new URL('../scripts/extract-floor-plan-evidence.py',import.meta.url)),output,'--annotate-evidence',evidence,'--annotation',annotation,'--scale-annotation',scaleAnnotation],{timeout:timeout(),maxBuffer:1024*1024});
            const annotationEvidence=JSON.parse(annotationOutput);
            image.evidence.issues.push(...(annotationEvidence.issues||[]));
            image.evidence.scaleStrips=annotationEvidence.scaleStrips;
            image.annotation=await readFile(annotation);
            image.scaleAnnotation=await readFile(scaleAnnotation);
        }
        return image;
    } finally {await rm(directory,{recursive:true,force:true});}
}

function historicalIdentity(context) {
    const b=context.building||{},f=context.facts||{};
    return [b.city,b.source,b.ownerId,b.buildingId,b.footprint,f.sourceId,f.address,f.coordinates,f.floor,f.unitId,f.areaM2,f.projectUrl];
}
export async function currentTaskListing(db,task,{lock=false,requireLocation=false}={}) {
    const row=(await db.query(`SELECT l.*,${locatedListingSql()} AS building_located FROM floor_plan.listing l JOIN floor_plan.target t ON t.url=$2
        WHERE l.url=$1 AND t.kind='asset' AND t.current_sha256=$3
        AND t.exclusion_reason IS NULL AND ${sourcePlanAssetSql()}
        AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true)) ${lock?'FOR SHARE OF l,t':''}`,
    [task.listing_url,task.source_url,task.source_sha256])).rows[0];
    if(!row||row.facts?.sourceEvidenceStatus==='not-a-listing')return null;
    if(!sourceUnitMatches(row.facts,row.url,task.source_url))return null;
    if(requireLocation&&row.building_located!==true)return null;
    if(task.context?.building) {
        if(row.match_status!=='verified')return null;
        const old={building:{city:row.building_city,source:row.building_source,ownerId:row.building_owner_id||'',
            buildingId:row.building_id,footprint:row.building_evidence?.footprint||null},facts:row.facts};
        return fingerprint(historicalIdentity(old))===fingerprint(historicalIdentity(task.context))?row:null;
    }
    return task.context?.listingUrl===task.listing_url
        &&fingerprint(contextIdentity(taskContext(row)))===fingerprint(contextIdentity(task.context))?row:null;
}
export async function currentTaskContext(db,task,options={}) {return Boolean(await currentTaskListing(db,task,options));}
export {reservationUsd,budgetUsed};

export async function storeReading(db,task,reading,{associationCurrent=true}={}) {
    let ready=0,needsReview=0;
    await db.query('BEGIN');
    try {
        for(const model of reading.plans) {
            if(!associationCurrent) model.quality.issues.push('Listing or source association changed after submission.');
            if(model.quality.rasterEvidence?.checked!==true) model.quality.issues.push('Wall positions have not been checked against the source image.');
            const status=model.quality.issues.length?'needs_review':'ready';
            const id=fingerprint([task.id,model.unitId]),hash=fingerprint(model);
            await db.query(`INSERT INTO floor_plan.processed_plan(id,task_id,region_id,city,source,owner_id,building_id,source_sha256,model,model_hash,status)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(task_id,region_id) DO NOTHING`,
            [id,task.id,model.unitId,null,null,'',null,task.source_sha256,JSON.stringify(model),hash,status]);
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

// The shared batch worker owns provider submission, polling, replay and accounting.
export function planStageAdapter({render=renderTask,verifyRaster=verifyRasterEvidence}={}) {
    return {
        stage:'plans',processor:PROCESSOR,schema:READING_SCHEMA,
        taskFilterSql:PROCESSABLE_PLAN_TASK_SQL,
        counters:{ready:0,needsReview:0,notPlan:0,preflightNeedsReview:0,associationReview:0},
        async prepare(db,task,llm,{deadline,maxOutputTokens}) {
            if(task.processor!==PROCESSOR)throw new Error('Historical plan task needs its original reader.');
            if(!await currentTaskContext(db,task))throw new Error('Source or listing association changed before processing.');
            const image=await render(db,task,{deadline});
            // A model cannot select geometry or a scale reference that the detector did not supply.
            // Keep the source for review without paying for a request forced to return no model.
            // A missing scale bar is no longer a stop: dimensions, doors or listing area can estimate scale.
            const missing=[];
            if(!image.evidence.wallCandidates?.length)missing.push('No supported wall candidates were detected.');
            if(missing.length) {
                const saved=await storeReading(db,task,{method:'local-evidence-check',notPlan:false,plans:[],issues:missing});
                return {localResult:{...saved,preflightNeedsReview:1}};
            }
            return {request:buildReadingRequest(llm,task,image,{maxOutputTokens}),
                evidence:{image:{width:image.width,height:image.height,evidence:image.evidence}}};
        },
        async apply(db,task,item,{deadline}) {
            if(task.processor!==PROCESSOR)throw new Error('Historical plan task needs its original reader.');
            if(!await currentTaskContext(db,task)) {
                // Retain an accounted response without generating geometry for a stale source/owner.
                await storeReading(db,task,{method:'association-gate',notPlan:false,plans:[],
                    issues:['The source drawing does not match this listing unit, or its association changed after submission.']});
                return {needsReview:1,associationReview:1};
            }
            let reading;
            try {
                reading=parsePaidReading(item,task,task.result.image);
            } catch(error) {
                if(!(error instanceof PaidGeometryValidationError))throw error;
                const saved=await storeReading(db,task,{method:'model-validation-review',notPlan:false,plans:[],
                    issues:[error.message]},{associationCurrent:await currentTaskContext(db,task)});
                return {...saved,needsReview:1,modelValidationReview:1};
            }
            if(reading.plans.length) {
                try {
                    const cleanImage=await render(db,task,{deadline,includeEvidence:false});
                    await verifyRaster(reading,cleanImage,{deadline});
                } catch(error) {
                    for(const plan of reading.plans)plan.quality.issues.push(`Source-raster verification unavailable: ${error.message}`);
                }
            }
            return storeReading(db,task,reading,{associationCurrent:await currentTaskContext(db,task)});
        }
    };
}

export async function interpretPlans(db,{render=renderTask,verifyRaster=verifyRasterEvidence,...options}={}) {
    const result=await runBatchStage(db,planStageAdapter({render,verifyRaster}),options);
    result.deferredSource=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.plan_task
        WHERE status='queued' AND processor=$1 AND NOT ${PROCESSABLE_PLAN_TASK_SQL}`,[PROCESSOR])).rows[0].n);
    if(result.deferredSource||result.associationReview)result.status='partial';
    return result;
}
