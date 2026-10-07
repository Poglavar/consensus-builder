// Coordinates the daily registry, crawl, source-extraction and building-candidate stages.
import { randomUUID } from 'node:crypto';
import { fetchHgkRegistry,selectZagrebRecords } from './registry.js';
import { importAgencies,putBlob,coverage } from './archive.js';
import { crawl } from './crawler.js';
import { processAssets } from './process-assets.js';
import { matchBuildingCandidates } from './building-links.js';
export async function daily(db,options={}) {
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-daily')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Daily floor-plan pipeline already running.');
 const id=randomUUID(),result={id,status:'running',stages:{},errors:[]};
 try {
  await db.query(`UPDATE floor_plan.pipeline_run SET status='interrupted',finished_at=now(),updated_at=now() WHERE status='running'`);
  await db.query(`INSERT INTO floor_plan.pipeline_run(id,status) VALUES($1,'running')`,[id]);
  const stage=async(name,fn)=>{
   try {result.stages[name]=await fn();} catch(error) {result.errors.push({stage:name,error:error.message});}
   await db.query(`UPDATE floor_plan.pipeline_run SET result=$2,updated_at=now() WHERE id=$1`,[id,JSON.stringify(result)]);
  };
  await stage('registry',async()=>{
   const snapshot=await fetchHgkRegistry({onPage:async({response})=>putBlob(db,response.body,'application/json')});
   snapshot.records=selectZagrebRecords(snapshot.records);snapshot.scope_complete=true;
   return importAgencies(db,snapshot);
  });
  await stage('crawl',()=>crawl(db,options));
  await stage('extraction',()=>processAssets(db,{maxAssets:options.maxAssets || 500}));
  await stage('buildingCandidates',()=>matchBuildingCandidates(db));
  result.coverage=await coverage(db);
  result.status=result.errors.length || Object.values(result.stages).some(s=>s.status==='partial' || s.status==='failed')?'partial':'complete';
  await db.query(`UPDATE floor_plan.pipeline_run SET status=$2,result=$3,finished_at=now(),updated_at=now() WHERE id=$1`,[id,result.status,JSON.stringify(result)]);
  return result;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-daily'))`);}
}
