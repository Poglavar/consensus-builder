// Export and verify every retained database source before removing the raw-byte column.
import { mkdir,statfs,writeFile,rename } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { archiveRoot,readBlobRow,writeSourceFile } from './blob-store.js';

const LOCKS=['floor-plan-crawl','floor-plan-daily','floor-plan-extraction','floor-plan-ai','floor-plan-building-enqueue'];
const metadataDDL=`ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS storage_path text;
 ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS bytes_available boolean NOT NULL DEFAULT false;
 ALTER TABLE floor_plan.blob ADD COLUMN IF NOT EXISTS stored_at timestamptz;`;

async function columns(db) {
 return new Map((await db.query(`SELECT column_name,is_nullable FROM information_schema.columns
  WHERE table_schema='floor_plan' AND table_name='blob'`)).rows.map(row=>[row.column_name,row.is_nullable]));
}

async function retainedCounts(db,legacy) {
 return (await db.query(`SELECT count(*)::int AS blobs,COALESCE(sum(byte_count),0)::text AS bytes
  FROM floor_plan.blob WHERE ${legacy?'data IS NOT NULL':'bytes_available'}`)).rows[0];
}

// Caller may provide another ignored report path. The report contains metadata, never source bytes.
export async function migrateArchiveStorage(db,{apply=false,root=archiveRoot(),reportFile=null,
 reclaimSpace=false,dropDatabaseBytes=false,log=console.log}={}) {
 const held=[],startedAt=new Date().toISOString();
 const result={version:1,startedAt,apply,storageRoot:root,status:'ready',exportedBlobs:0,exportedBytes:0,
  verifiedBlobs:0,verifiedBytes:0,legacyColumnRemoved:false,reclaimedSpace:false};
 if(dropDatabaseBytes&&!apply) throw new Error('--drop-database-bytes requires --apply.');
 if(reclaimSpace&&!dropDatabaseBytes) throw new Error('--reclaim-space requires --drop-database-bytes.');
 async function checkpoint(stage) {
  result.stage=stage;result.updatedAt=new Date().toISOString();
  if(reportFile) {
   await mkdir(dirname(reportFile),{recursive:true});
   await writeFile(reportFile+'.tmp',JSON.stringify(result,null,2)+'\n',{mode:0o600});
   await rename(reportFile+'.tmp',reportFile);
  }
  log(JSON.stringify({at:result.updatedAt,stage,...Object.fromEntries(
   ['exportedBlobs','exportedBytes','verifiedBlobs','verifiedBytes'].map(key=>[key,result[key]]))}));
 }
 try {
  for(const name of LOCKS) {
   const locked=(await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[name])).rows[0]?.locked;
   if(!locked) throw new Error(`Stop the active archive worker before migrating storage: ${name}`);
   held.push(name);
  }
  const initialColumns=await columns(db);
  if(!initialColumns.size) throw new Error('Initialize the archive schema before migrating storage.');
  result.legacyColumnPresent=initialColumns.has('data');
  result.legacyColumnNullable=initialColumns.get('data')==='YES';
  result.legacyColumnStatus=result.legacyColumnPresent?'preserved':'absent';
  result.before=await retainedCounts(db,result.legacyColumnPresent);
  if(!apply) {await checkpoint('audit');return result;}
  await db.query(metadataDDL);
  await mkdir(root,{recursive:true,mode:0o700});
  if(!reportFile) reportFile=join(root,'migrations',`${startedAt.replace(/[:.]/g,'-')}.json`);
  if(result.legacyColumnPresent) {
   // Metadata-only updates preserve the existing bytea copy until the complete export is verified.
   const pending=(await db.query(`SELECT count(*)::int AS blobs,COALESCE(sum(byte_count),0)::text AS bytes
    FROM floor_plan.blob WHERE data IS NOT NULL AND stored_at IS NULL AND NOT bytes_available`)).rows[0];
   const filesystem=await statfs(root,{bigint:true});
   const free=filesystem.bavail*filesystem.bsize,required=BigInt(pending.bytes);
   const reserve=required>0n?268435456n:0n;
   if(free<required+required/10n+reserve) throw new Error('Not enough free space for a verified archive export.');
   let cursor='';
   for(;;) {
    const rows=(await db.query(`SELECT sha256,media_type,byte_count,data FROM floor_plan.blob
     WHERE data IS NOT NULL AND stored_at IS NULL AND NOT bytes_available AND sha256>$1 ORDER BY sha256 LIMIT 10`,[cursor])).rows;
    if(!rows.length) break;
    for(const row of rows) {
     if(row.data.length!==Number(row.byte_count)) throw new Error(`Database source size mismatch: ${row.sha256}`);
     const storagePath=await writeSourceFile(row.data,row.sha256,row.media_type,{root});
     await db.query(`UPDATE floor_plan.blob SET storage_path=$2,bytes_available=true,
      stored_at=COALESCE(stored_at,now()),updated_at=now() WHERE sha256=$1 AND data IS NOT NULL`,[row.sha256,storagePath]);
     result.exportedBlobs++;result.exportedBytes+=row.data.length;cursor=row.sha256;
    }
    await checkpoint('exporting');
   }
  }
  let cursor='';
  for(;;) {
   const rows=(await db.query(`SELECT sha256,media_type,byte_count,storage_path,bytes_available
    FROM floor_plan.blob WHERE bytes_available AND sha256>$1 ORDER BY sha256 LIMIT 50`,[cursor])).rows;
   if(!rows.length) break;
   for(const row of rows) {
    const bytes=await readBlobRow(row,{root});
    if(!bytes) throw new Error(`Retained archive source is unavailable: ${row.sha256}`);
    result.verifiedBlobs++;result.verifiedBytes+=bytes.length;cursor=row.sha256;
   }
   await checkpoint('verifying');
  }
  if(result.legacyColumnPresent) {
   // A set stored_at marks data that has already passed the export phase, even if
   // retention later removed the file and cleared bytes_available/storage_path.
   await db.query(`UPDATE floor_plan.blob SET stored_at=COALESCE(stored_at,now())
    WHERE data IS NOT NULL AND bytes_available`);
   const uncovered=(await db.query(`SELECT count(*)::int AS n FROM floor_plan.blob
    WHERE data IS NOT NULL AND stored_at IS NULL AND (NOT bytes_available OR storage_path IS NULL)`)).rows[0].n;
   const retained=await retainedCounts(db,true);
   if(uncovered || retained.blobs!==result.before.blobs || retained.bytes!==result.before.bytes)
    throw new Error('Retained database sources changed during the export; raw bytes were not removed.');
   if(dropDatabaseBytes) {
    await checkpoint('removing-database-bytes');
    // RESTRICT keeps an unknown dependent reader/view from being silently removed.
    await db.query('ALTER TABLE floor_plan.blob DROP COLUMN data RESTRICT');
    result.legacyColumnRemoved=true;result.legacyColumnStatus='removed';
   } else if(!result.legacyColumnNullable) {
    // Future metadata-only inserts need a nullable legacy field until a later drop.
    await db.query('ALTER TABLE floor_plan.blob ALTER COLUMN data DROP NOT NULL');
    result.legacyColumnNullable=true;
   }
  }
  if(reclaimSpace && result.legacyColumnRemoved) {
   await checkpoint('reclaiming-database-space');
   await db.query('VACUUM (FULL, ANALYZE) floor_plan.blob');
   result.reclaimedSpace=true;
  }
  result.after=await retainedCounts(db,false);
  if(result.after.blobs!==result.verifiedBlobs || Number(result.after.bytes)!==result.verifiedBytes)
   throw new Error('Filesystem metadata readback changed after migration.');
  const finalColumns=await columns(db);
  result.legacyColumnPresentAfter=finalColumns.has('data');
  if(dropDatabaseBytes&&result.legacyColumnPresentAfter) throw new Error('The raw source column still exists.');
  if(!dropDatabaseBytes&&result.legacyColumnPresent&&!finalColumns.has('data'))
   throw new Error('The raw source column was unexpectedly removed.');
  result.status='complete';result.finishedAt=new Date().toISOString();
  await checkpoint('complete');
  return result;
 } catch(error) {
  result.status='failed';result.error=String(error.message || error);
  await checkpoint('failed');
  throw error;
 } finally {
  for(const name of held.reverse()) await db.query('SELECT pg_advisory_unlock(hashtext($1))',[name]);
 }
}
