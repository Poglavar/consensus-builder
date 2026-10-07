// Checkpoint OCR and source linework per immutable asset, with explicit review gates.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../buildings/floor-models.js';
const exec=promisify(execFile);
export async function processAssets(db,{maxAssets=100,python=process.env.FLOOR_PLAN_PYTHON || 'python3',log=console.log}={}) {
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-extraction')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Another floor-plan extraction is running.');
 const result={processed:0,needsReview:0,notPlan:0,failed:0,pending:0};
 try {
  const rows=(await db.query(`SELECT e.sha256,b.media_type,b.data FROM floor_plan.extraction e JOIN floor_plan.blob b USING(sha256) WHERE e.status='pending' ORDER BY e.created_at LIMIT $1`,[maxAssets])).rows;
  for(const row of rows) {
   let directory;
   try {
    directory=await mkdtemp(join(tmpdir(),'floor-plan-asset-'));
    const path=join(directory,'source');await writeFile(path,row.data);
    const {stdout}=await exec(python,[fileURLToPath(new URL('../scripts/extract-floor-plan-draft.py',import.meta.url)),path,'--media-type',row.media_type.split(';')[0]],{timeout:600000,maxBuffer:16*1024*1024});
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
  result.pending=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.extraction WHERE status='pending'`)).rows[0].n);
  result.status=result.failed || result.pending?'partial':'complete';return result;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-extraction'))`);}
}
