import { afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtemp,readFile,readdir,rm,stat,lstat,statfs,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertArchiveCapacity,ArchiveCapacityError } from '../floor-plans/storage-budget.js';
import { contentHash,sourceFilePath,writeSourceFile,writeBlob } from '../floor-plans/blob-store.js';

let root;
afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root=null;});

function injectedFs(availableBytes=1000){
 return {stat,lstat,readdir,statfs:vi.fn(async()=>({bavail:availableBytes,bsize:1}))};
}

describe('floor-plan archive capacity',()=>{
 it('rejects an allocation before writing when the physical archive cap would be exceeded',async()=>{
  root=await mkdtemp(join(tmpdir(),'floor-plan-budget-'));
  const body=Buffer.from('sixteen bytes??');
  const env={FLOOR_PLAN_MAX_ARCHIVE_BYTES:'8',FLOOR_PLAN_MIN_FREE_BYTES:'1'};
  await expect(writeSourceFile(body,contentHash(body),'text/html',{root,capacityOptions:{env,fsImpl:injectedFs()}}))
   .rejects.toMatchObject({name:'ArchiveCapacityError',code:'ARCHIVE_CAPACITY',reason:'archive-limit'});
  expect(await readdir(root)).toEqual([]);
 });

 it('counts orphaned and temporary files in physical archive usage',async()=>{
  root=await mkdtemp(join(tmpdir(),'floor-plan-budget-'));
  const orphan=join(root,'orphan.tmp');
  await writeFile(orphan,Buffer.alloc(7));
  const physicalBytes=Math.max(7,(await stat(orphan)).blocks*512);
  await expect(assertArchiveCapacity({root,additionalBytes:4,
   env:{FLOOR_PLAN_MAX_ARCHIVE_BYTES:String(physicalBytes+3),FLOOR_PLAN_MIN_FREE_BYTES:'1'},fsImpl:injectedFs()}))
   .rejects.toMatchObject({code:'ARCHIVE_CAPACITY',reason:'archive-limit',details:{physicalBytes}});
 });

 it('requires the reserve plus requested allocation on every monitored filesystem',async()=>{
  root=await mkdtemp(join(tmpdir(),'floor-plan-budget-'));
  const fsImpl=injectedFs(10);
  await expect(assertArchiveCapacity({root,additionalBytes:1,env:{FLOOR_PLAN_MAX_ARCHIVE_BYTES:'100',FLOOR_PLAN_MIN_FREE_BYTES:'10'},fsImpl}))
   .rejects.toMatchObject({code:'ARCHIVE_CAPACITY',reason:'free-space',details:{availableBytes:10}});
  expect(fsImpl.statfs).toHaveBeenCalled();
 });

 it.each(['0','-1','Infinity','',String(Number.MAX_SAFE_INTEGER+1)])('rejects invalid byte configuration %s',async value=>{
  root=await mkdtemp(join(tmpdir(),'floor-plan-budget-'));
  await expect(assertArchiveCapacity({root,env:{FLOOR_PLAN_MAX_ARCHIVE_BYTES:value,FLOOR_PLAN_MIN_FREE_BYTES:'1'},fsImpl:injectedFs()}))
   .rejects.toBeInstanceOf(ArchiveCapacityError);
 });

 it('checks extra monitored paths even when the prefetch scan skips archive bytes',async()=>{
  root=await mkdtemp(join(tmpdir(),'floor-plan-budget-'));
  const dbRoot=await mkdtemp(join(tmpdir(),'floor-plan-db-budget-'));
  const fsImpl=injectedFs(20);
  await expect(assertArchiveCapacity({root,additionalBytes:5,checkArchiveBytes:false,
   env:{FLOOR_PLAN_MIN_FREE_BYTES:'10',FLOOR_PLAN_STORAGE_PATHS:JSON.stringify([dbRoot])},fsImpl}))
   .resolves.toBe(true);
  expect(fsImpl.statfs).toHaveBeenCalledTimes(2);
  await rm(dbRoot,{recursive:true,force:true});
 });

 it('allows a verified existing file at the hard cap without double-counting it',async()=>{
  root=await mkdtemp(join(tmpdir(),'floor-plan-budget-'));
  const body=Buffer.from('already stored');
  const hash=contentHash(body);
  const path=await writeSourceFile(body,hash,'text/html',{root,capacityOptions:{env:{FLOOR_PLAN_MAX_ARCHIVE_BYTES:'100',FLOOR_PLAN_MIN_FREE_BYTES:'1'}}});
  expect(await writeSourceFile(body,hash,'text/html',{root,capacityOptions:{env:{FLOOR_PLAN_MAX_ARCHIVE_BYTES:String(body.length),FLOOR_PLAN_MIN_FREE_BYTES:'1'}}})).toBe(path);
  expect(await readFile(sourceFilePath(path,hash,{root}))).toEqual(body);
 });

 it('serializes writeBlob capacity checks with the global advisory lock',async()=>{
  root=await mkdtemp(join(tmpdir(),'floor-plan-budget-'));
  const body=Buffer.from('capacity lock');
  const calls=[];
  const db={query:vi.fn(async(sql)=>{calls.push(sql);return {rows:sql.includes('FOR UPDATE')?[]:[],rowCount:1};})};
  const env={FLOOR_PLAN_MAX_ARCHIVE_BYTES:'100',FLOOR_PLAN_MIN_FREE_BYTES:'1'};
  await writeBlob(db,body,'text/html',{root,capacityOptions:{env}});
  const take=calls.findIndex(sql=>sql.includes("pg_advisory_lock(hashtext('floor-plan-files-capacity')"));
  const insert=calls.findIndex(sql=>sql.includes('INSERT INTO floor_plan.blob'));
  const release=calls.findIndex(sql=>sql.includes("pg_advisory_unlock(hashtext('floor-plan-files-capacity')"));
  expect(take).toBeGreaterThan(-1);
  expect(take).toBeLessThan(insert);
  expect(release).toBeGreaterThan(insert);
 });
});
