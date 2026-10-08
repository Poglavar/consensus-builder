// Checkpoint OCR and source linework for current, optionally building-matched assets.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../buildings/floor-models.js';
import { MATCHED_ASSET_SQL } from './crawl-queue.js';

const exec=promisify(execFile);
const MATCHED_ASSET_EXISTS=`EXISTS (SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=e.sha256
 AND t.kind='asset' AND ${MATCHED_ASSET_SQL})`;

export async function processAssets(db,{maxAssets=100,maxMinutes=45,matchedOnly=false,
 python=process.env.FLOOR_PLAN_PYTHON || 'python3',log=console.log,now=Date.now,
 extractor=({python,path,mediaType,timeout})=>exec(python,[fileURLToPath(new URL('../scripts/extract-floor-plan-draft.py',import.meta.url)),path,'--media-type',mediaType],{timeout,maxBuffer:16*1024*1024})}={}) {
 if(!Number.isInteger(maxAssets)||maxAssets<1) throw new Error('maxAssets must be a positive integer.');
 if(!Number.isFinite(maxMinutes)||maxMinutes<=0) throw new Error('maxMinutes must be positive.');
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-extraction')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Another floor-plan extraction is running.');
 const started=now(),deadline=started+maxMinutes*60000;
 const result={selected:0,processed:0,needsReview:0,notPlan:0,failed:0,unprocessed:0,pending:0,deferredUnmatched:0};
 try {
  const rows=(await db.query(`SELECT e.sha256,b.media_type,b.data FROM floor_plan.extraction e JOIN floor_plan.blob b USING(sha256)
   WHERE e.status='pending' AND (NOT $2::boolean OR ${MATCHED_ASSET_EXISTS}) ORDER BY e.created_at,e.sha256 LIMIT $1`,[maxAssets,matchedOnly])).rows;
  result.selected=rows.length;
  for(const row of rows) {
   if(now()>=deadline) {result.unprocessed=rows.length-result.processed;break;}
   let directory;
   try {
    directory=await mkdtemp(join(tmpdir(),'floor-plan-asset-'));
    const path=join(directory,'source');await writeFile(path,row.data);
    const remaining=Math.max(1000,Math.min(600000,deadline-now()));
    const {stdout}=await extractor({python,path,mediaType:row.media_type.split(';')[0],timeout:remaining});
    const model=JSON.parse(stdout);model.source={sha256:row.sha256};
    if(model.schema!=='consensus-builder.floor-plan-draft.v1'||!['needs_review','not_plan'].includes(model.status)) throw new Error('Invalid draft extractor output');
    await db.query('BEGIN');
    try {
     await db.query(`INSERT INTO floor_plan.model_revision(source_sha256,model_sha256,model) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[row.sha256,fingerprint(model),JSON.stringify(model)]);
     await db.query(`UPDATE floor_plan.extraction SET status=$2,model=$3,error=NULL,updated_at=now() WHERE sha256=$1 AND status='pending'`,[row.sha256,model.status,JSON.stringify(model)]);
     await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK');throw error;}
    result[model.status==='not_plan'?'notPlan':'needsReview']++;
   } catch(error) {
    result.failed++;
    await db.query(`UPDATE floor_plan.extraction SET status='error',error=$2,updated_at=now() WHERE sha256=$1`,[row.sha256,String(error.stderr || error.message).trim().split('\n').at(-1).slice(0,2000)]);
   } finally {if(directory) await rm(directory,{recursive:true,force:true});}
   result.processed++;log(JSON.stringify({at:new Date().toISOString(),stage:'extract',...result,total:rows.length,sha256:row.sha256}));
  }
  if(!result.unprocessed) result.unprocessed=rows.length-result.processed;
  result.pending=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.extraction e WHERE e.status='pending'
   AND (NOT $1::boolean OR ${MATCHED_ASSET_EXISTS})`,[matchedOnly])).rows[0].n);
  if(matchedOnly) result.deferredUnmatched=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.extraction e
   WHERE e.status='pending' AND NOT ${MATCHED_ASSET_EXISTS}`)).rows[0].n);
  result.elapsedMs=now()-started;
  result.status=result.failed||result.pending||result.unprocessed?'partial':'complete';return result;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-extraction'))`);}
}
