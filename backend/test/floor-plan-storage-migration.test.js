// Migration must preserve bytea until every source file passes a complete size/hash verification.
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash,readBlobRow,sourceFilePath } from '../floor-plans/blob-store.js';
import { migrateArchiveStorage } from '../floor-plans/storage-migration.js';

let root;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'floor-plan-migration-test-'));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});

function database({corrupt=false,blocked=null,notNull=true}={}) {
 let legacy=true,nullable=!notNull;
 const data=Buffer.from('<html>Original source</html>');
 const rows=[{sha256:contentHash(data),media_type:'text/html',byte_count:data.length,data,
  bytes_available:false,storage_path:null},
 {sha256:'f'.repeat(64),media_type:'image/jpeg',byte_count:99,data:null,bytes_available:false,storage_path:null}];
 if(corrupt) rows[0].sha256='a'.repeat(64);
 const db={rows,query:vi.fn(async(sql,args=[])=>{
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:args[0]!==blocked}]};
  if(sql.includes('information_schema.columns')) return {rows:(legacy?[['sha256','YES'],['data',nullable?'YES':'NO']]:[['sha256','YES'],['storage_path','YES'],['bytes_available','NO']]).map(([column_name,is_nullable])=>({column_name,is_nullable}))};
  if(sql.includes('AS blobs')) {
   const retained=rows.filter(row=>sql.includes('WHERE data IS NOT NULL')?row.data:row.bytes_available);
   return {rows:[{blobs:retained.length,bytes:String(retained.reduce((sum,row)=>sum+row.byte_count,0))}]};
  }
  if(sql.includes('SELECT sha256,media_type,byte_count,data')) return {rows:rows.filter(row=>row.data&&row.stored_at==null&&!row.bytes_available&&row.sha256>args[0]).sort((a,b)=>a.sha256.localeCompare(b.sha256))};
  if(sql.startsWith('UPDATE floor_plan.blob SET storage_path')) {
   Object.assign(rows.find(row=>row.sha256===args[0]),{storage_path:args[1],bytes_available:true,stored_at:new Date()});
  }
  if(sql.includes('FROM floor_plan.blob WHERE bytes_available AND sha256>')) return {rows:rows.filter(row=>row.bytes_available&&row.sha256>args[0])};
  if(sql.includes('SET stored_at=COALESCE(stored_at,now())')) {
   for(const row of rows) if(row.data&&row.bytes_available&&row.stored_at==null) row.stored_at=new Date();
  }
  if(sql.includes('AS n FROM floor_plan.blob')) return {rows:[{n:rows.filter(row=>row.data&&row.stored_at==null&&(!row.bytes_available||!row.storage_path)).length}]};
  if(sql.includes('ALTER COLUMN data DROP NOT NULL')) nullable=true;
  if(sql.includes('DROP COLUMN data')) {legacy=false;for(const row of rows)delete row.data;}
  return {rows:[],rowCount:1};
 })};
 return db;
}

describe('source storage migration',()=>{
 it('defaults to a read-only audit, without exporting or changing schema',async()=>{
  const db=database();
  const result=await migrateArchiveStorage(db,{root,log:()=>{}});
  expect(result).toMatchObject({apply:false,status:'ready',exportedBlobs:0,legacyColumnPresent:true});
  expect(db.query.mock.calls.some(([sql])=>/^(ALTER|UPDATE|VACUUM)/.test(sql))).toBe(false);
  expect(db.rows[0].data).toEqual(Buffer.from('<html>Original source</html>'));
 });
 it('exports and verifies every retained source while preserving bytea by default',async()=>{
  const db=database(),original=Buffer.from(db.rows[0].data),reportFile=join(root,'migration-result.json');
  const result=await migrateArchiveStorage(db,{apply:true,root,reportFile,log:()=>{}});
  expect(result).toMatchObject({status:'complete',exportedBlobs:1,verifiedBlobs:1,legacyColumnPresent:true,
   legacyColumnRemoved:false,legacyColumnStatus:'preserved',legacyColumnPresentAfter:true,after:{blobs:1,bytes:String(original.length)}});
  expect(await readBlobRow(db.rows[0],{root})).toEqual(original);
  expect(db.rows[1]).toMatchObject({bytes_available:false,storage_path:null});
  expect(db.rows[0].data).toEqual(original);
  expect(db.rows[1].data).toBeNull();
  expect(db.query.mock.calls.some(([sql])=>sql.includes('DROP COLUMN data'))).toBe(false);
  expect(JSON.parse(await readFile(reportFile,'utf8')).status).toBe('complete');
  const repeat=await migrateArchiveStorage(db,{apply:true,root,log:()=>{}});
  expect(repeat).toMatchObject({status:'complete',exportedBlobs:0,verifiedBlobs:1,legacyColumnPresent:true,legacyColumnRemoved:false});
  expect(db.rows[0].data).toEqual(original);
 });
 it('does not resurrect a source discarded after export and still permits the explicit drop',async()=>{
  const db=database(),row=db.rows[0],original=Buffer.from(row.data);
  const first=await migrateArchiveStorage(db,{apply:true,root,log:()=>{}});
  expect(first).toMatchObject({exportedBlobs:1,verifiedBlobs:1,status:'complete'});
  const exportedPath=sourceFilePath(row.storage_path,row.sha256,{root});
  expect(row.stored_at).toBeInstanceOf(Date);
  await rm(exportedPath,{force:true});
  Object.assign(row,{bytes_available:false,storage_path:null,discarded_at:new Date()});

  const repeat=await migrateArchiveStorage(db,{apply:true,root,log:()=>{}});
  expect(repeat).toMatchObject({exportedBlobs:0,verifiedBlobs:0,legacyColumnPresent:true,
   legacyColumnRemoved:false,status:'complete'});
  expect(row).toMatchObject({data:original,bytes_available:false,storage_path:null});
  expect(row.stored_at).toBeInstanceOf(Date);

  const drop=await migrateArchiveStorage(db,{apply:true,dropDatabaseBytes:true,root,log:()=>{}});
  expect(drop).toMatchObject({status:'complete',legacyColumnRemoved:true,verifiedBlobs:0});
  expect(row).toMatchObject({bytes_available:false,storage_path:null});
  expect(row).not.toHaveProperty('data');
 });
 it('relaxes an old NOT NULL byte column only after verified export',async()=>{
  const db=database({notNull:true});
  const result=await migrateArchiveStorage(db,{apply:true,root,log:()=>{}});
  const queries=db.query.mock.calls.map(([sql])=>sql);
  const verifiedAt=queries.findIndex(query=>query.includes('FROM floor_plan.blob WHERE bytes_available AND sha256>'));
  const relaxAt=queries.findIndex(query=>query.includes('ALTER COLUMN data DROP NOT NULL'));
  expect(relaxAt).toBeGreaterThan(verifiedAt);
  expect(result).toMatchObject({status:'complete',legacyColumnPresent:true,legacyColumnRemoved:false});
  expect(db.rows[0].data).toEqual(Buffer.from('<html>Original source</html>'));
 });
 it('drops database bytes only after explicit opt-in and permits an idempotent rerun',async()=>{
  const db=database(),original=Buffer.from(db.rows[0].data);
  await expect(migrateArchiveStorage(db,{apply:true,dropDatabaseBytes:true,root,log:()=>{}}))
   .resolves.toMatchObject({status:'complete',legacyColumnRemoved:true,legacyColumnStatus:'removed',legacyColumnPresentAfter:false});
  expect(db.rows.every(row=>!('data' in row))).toBe(true);
  const repeat=await migrateArchiveStorage(db,{apply:true,dropDatabaseBytes:true,root,log:()=>{}});
  expect(repeat).toMatchObject({status:'complete',legacyColumnPresent:false,legacyColumnRemoved:false,legacyColumnPresentAfter:false,verifiedBlobs:1});
  expect(await readBlobRow({sha256:db.rows[0].sha256,media_type:'text/html',byte_count:original.length,
   storage_path:db.rows[0].storage_path,bytes_available:true},{root})).toEqual(original);
 });
 it('requires apply for database-byte deletion and explicit deletion for vacuum',async()=>{
  const db=database();
  await expect(migrateArchiveStorage(db,{root,dropDatabaseBytes:true,log:()=>{}})).rejects.toThrow(/requires --apply/);
  await expect(migrateArchiveStorage(db,{apply:true,root,reclaimSpace:true,log:()=>{}})).rejects.toThrow(/requires --drop-database-bytes/);
  expect(db.query.mock.calls.some(([sql])=>/^(ALTER|UPDATE|VACUUM)/.test(sql))).toBe(false);
 });
 it('keeps all database bytes when the source hash is invalid',async()=>{
  const db=database({corrupt:true}),original=db.rows[0].data;
  await expect(migrateArchiveStorage(db,{apply:true,root,log:()=>{}})).rejects.toThrow(/size\/hash check/);
  expect(db.rows[0].data).toBe(original);
  expect(db.query.mock.calls.some(([sql])=>sql.includes('DROP COLUMN'))).toBe(false);
 });
 it('refuses to migrate while another archive worker holds its lock',async()=>{
  const db=database({blocked:'floor-plan-ai'});
  await expect(migrateArchiveStorage(db,{apply:true,root,log:()=>{}})).rejects.toThrow(/Stop the active archive worker/);
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('ALTER'))).toBe(false);
  expect(db.query.mock.calls.filter(([sql])=>sql.includes('pg_advisory_unlock'))).toHaveLength(3);
 });
});
