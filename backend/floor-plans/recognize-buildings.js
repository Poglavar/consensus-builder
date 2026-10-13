// Queue source-cited ad identity readings without promoting LLM suggestions to verified buildings.
import { fingerprint } from '../buildings/floor-models.js';
import { normalizeUrl } from './page-evidence.js';
import { addressKey, addressedBuildings, sourceLocality } from './building-resolution.js';
import { eligibleListingSql } from './source-policy.js';
import { BUILDING_PROCESSOR,buildBuildingRequest,parseBuildingReading } from './building-reading.js';
import { BUILDING_SCHEMA } from './building-reading-schema.js';
import { runBatchStage } from './batch-worker.js';
import { buildingEvidenceWithCandidates,readSourceEvidence } from './compact-sources.js';

export function buildingTaskId(context,candidateMap) {return fingerprint([BUILDING_PROCESSOR,context,candidateMap]);}

function explicitAddress(facts={}) {
    const location=facts.explicitLocation;
    if(location?.schema!=='explicit-listing-location.v1'
        ||typeof location.street!=='string'||typeof location.houseNumber!=='string') return null;
    return addressKey(`${location.street} ${location.houseNumber}`);
}

// Only source-asserted street and house number claims can supply recognition candidates.
export async function buildingCandidates(_db,listing,{bindings=[],addressRows=new Map()}={}) {
    const candidates=[],seen=new Set();
    const add=candidate=>{
        const key=JSON.stringify([candidate.city,candidate.source,candidate.ownerId||'',candidate.buildingId]);
        if(!seen.has(key)) {seen.add(key);candidates.push(candidate);}
    };
    const address=explicitAddress(listing.facts);
    const locality=sourceLocality(listing.facts);
    if(!address||!locality) return [];
    for(const binding of bindings) {
        if(binding.match_kind==='address'&&binding.match_value===address
            &&sourceLocality({locality:binding.city})===locality) {
            add({city:binding.city,source:binding.source,ownerId:binding.owner_id||'',buildingId:binding.building_id,
                address:binding.match_value,name:binding.name,distanceM:null,
                evidence:binding.evidence?.basis||'Reviewed exact-address source binding',bindingId:binding.id});
        }
    }
    if(locality==='zagreb') {
        const matchingRows=addressRows instanceof Map
            ? addressRows.get(address)||[]
            : (addressRows||[]).filter(row=>addressKey(row.address)===address);
        for(const row of matchingRows) {
            add({city:'zagreb',source:'zagreb-3d',ownerId:'',buildingId:row.building_id,
                address:row.address,name:row.address,distanceM:null,
                evidence:'Exact street and house number in the address inventory; cadastral/survey overlap >=90% in both directions.',
                addressRecordId:row.id,footprint:row.footprint});
        }
    }
    return candidates.slice(0,40);
}

export async function enqueueBuildingTasks(db,{limit=100,listingUrl=null,deadline=Infinity}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>5000)throw new Error('Building queue limit must be 1..5000.');
    if(listingUrl&&!normalizeUrl(listingUrl))throw new Error('Invalid listing URL.');
    const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-building-enqueue')) AS locked`)).rows[0].locked;
    if(!locked)throw new Error('Another building recognition queue builder is running.');
    try {
        const rows=(await db.query(`SELECT l.*,t.current_sha256,b.sha256,b.storage_path,b.byte_count,b.bytes_available,b.media_type FROM floor_plan.listing l
            JOIN floor_plan.target t ON t.url=l.url JOIN floor_plan.blob b ON b.sha256=t.current_sha256
            LEFT JOIN floor_plan.observation o ON o.url=l.url AND o.sha256=t.current_sha256
            WHERE l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
            AND ${eligibleListingSql('l')}
            AND (b.bytes_available OR (o.evidence->'sourcePacket'->>'schema'='processed-source-evidence.v1'
              AND o.evidence->'sourcePacket'->'source'->>'sha256'=t.current_sha256
              AND o.evidence->'sourcePacket'->'source'->>'url'=l.url))
            AND lower(b.media_type) LIKE '%html%' AND ($1::text IS NULL OR l.url=$1)
            AND (l.match_status<>'verified' OR $1::text IS NOT NULL)
            ORDER BY EXISTS(SELECT 1 FROM floor_plan.building_task bt WHERE bt.listing_url=l.url
                AND bt.source_sha256=t.current_sha256 AND bt.processor=$3),l.created_at,l.url LIMIT $2`,
        [listingUrl?normalizeUrl(listingUrl):null,limit,BUILDING_PROCESSOR])).rows;
        const bindings=(await db.query('SELECT * FROM floor_plan.building_binding ORDER BY id')).rows;
        const hasZagrebListings=rows.some(row=>sourceLocality(row.facts)==='zagreb');
        const addressRows=hasZagrebListings?await addressedBuildings(db):new Map();
        const result={selected:rows.length,enqueued:0,existing:0,deferred:0};
        for(const row of rows) {
            if(Date.now()>=deadline) {result.deferred++;continue;}
            const candidates=await buildingCandidates(db,row,{bindings,addressRows});
            const source=await readSourceEvidence(db,{url:row.url,sha256:row.current_sha256,facts:row.facts||{}});
            if(!source) throw new Error(`Archived listing source evidence is unavailable: ${row.current_sha256}`);
            const context=buildingEvidenceWithCandidates(source,candidates);
            const candidateMap=candidates.map((candidate,index)=>({id:`C${index+1}`,city:candidate.city,source:candidate.source,
                ownerId:candidate.ownerId||'',buildingId:candidate.buildingId,bindingId:candidate.bindingId||null}));
            const id=buildingTaskId(context,candidateMap);
            const saved=await db.query(`INSERT INTO floor_plan.building_task(id,source_sha256,listing_url,processor,context,candidate_map)
                VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[id,row.current_sha256,row.url,BUILDING_PROCESSOR,JSON.stringify(context),JSON.stringify(candidateMap)]);
            result[saved.rowCount?'enqueued':'existing']++;
        }
        return result;
    } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-building-enqueue'))`);}
}

export async function currentBuildingTask(db,task) {
    const row=(await db.query(`SELECT t.current_sha256 FROM floor_plan.target t JOIN floor_plan.listing l ON l.url=t.url
        WHERE l.url=$1 AND l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
        AND ${eligibleListingSql('l')}`,[task.listing_url])).rows[0];
    return row?.current_sha256===task.source_sha256;
}

export async function storeBuildingReading(db,task,reading,{sourceCurrent=true}={}) {
    const candidate=reading.candidateId?(task.candidate_map||[]).find(item=>item.id===reading.candidateId):null;
    if(reading.candidateId&&!candidate)throw new Error('Selected candidate has no canonical source mapping.');
    const result={reading,candidate:candidate||null,sourceCurrent};
    await db.query(`UPDATE floor_plan.building_task SET status=$2,result=result||$3::jsonb,error=NULL,updated_at=now() WHERE id=$1`,
        [task.id,reading.status,JSON.stringify(result)]);
    const saved=(await db.query('SELECT status,result FROM floor_plan.building_task WHERE id=$1',[task.id])).rows[0];
    if(saved?.status!==reading.status||fingerprint(saved.result.reading)!==fingerprint(reading)
        ||fingerprint(saved.result.candidate)!==fingerprint(result.candidate))throw new Error('Building reading read-back mismatch.');
    // Nothing writes listing.match_status or building_binding here; an LLM suggestion is not a verified link.
    return {candidates:reading.status==='candidate'?1:0,unresolved:reading.status==='unresolved'?1:0,
        notListing:reading.status==='not_listing'?1:0,stale:sourceCurrent?0:1};
}

export async function recognizeBuildings(db,options={}) {
    return runBatchStage(db,{stage:'buildings',processor:BUILDING_PROCESSOR,schema:BUILDING_SCHEMA,
        counters:{candidates:0,unresolved:0,notListing:0,stale:0},
        prepare:async(db,task,llm,limits)=>{
            if(task.processor!==BUILDING_PROCESSOR) throw new Error('Historical building task needs its original reader.');
            if(!await currentBuildingTask(db,task))throw new Error('Listing source changed before building recognition.');
            return {request:buildBuildingRequest(llm,task,limits),evidence:{}};
        },
        taskFilterSql:`EXISTS(SELECT 1 FROM floor_plan.listing l
            WHERE l.url=floor_plan.building_task.listing_url AND ${eligibleListingSql('l')})`,
        apply:async(db,task,item)=>{
            if(task.processor!==BUILDING_PROCESSOR) throw new Error('Historical building task needs its original reader.');
            const reading=parseBuildingReading(item.data,task,{model:item.model});
            return storeBuildingReading(db,task,reading,{sourceCurrent:await currentBuildingTask(db,task)});
        }
    },options);
}

export async function recognitionStatus(db,{limit=20,listingUrl=null}={}) {
    const queues=(await db.query(`SELECT 'plans' AS stage,processor,status,count(*)::int AS count,COALESCE(sum(cost_usd),0)::float AS cost_usd
        FROM floor_plan.plan_task GROUP BY processor,status UNION ALL
        SELECT 'buildings',processor,status,count(*)::int,COALESCE(sum(cost_usd),0)::float
        FROM floor_plan.building_task GROUP BY processor,status ORDER BY stage,processor,status`)).rows;
    const batches=(await db.query(`SELECT id,provider_id,stage,model,status,reserved_usd,created_at,error FROM floor_plan.ai_batch
        WHERE status<>'complete' ORDER BY created_at`)).rows;
    const readings=(await db.query(`SELECT bt.id,bt.listing_url,bt.source_sha256,bt.processor,bt.status,bt.result,bt.cost_usd,bt.usage,bt.error,
        bt.created_at,bt.updated_at,(t.current_sha256=bt.source_sha256) AS source_current
        FROM floor_plan.building_task bt JOIN floor_plan.target t ON t.url=bt.listing_url
        WHERE ($1::text IS NULL OR bt.listing_url=$1) ORDER BY bt.updated_at DESC,bt.id LIMIT $2`,[listingUrl,limit])).rows;
    return {queues,batches,buildingReadings:readings};
}
