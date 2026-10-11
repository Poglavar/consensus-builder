// Give each unit-test file a disposable archive directory instead of writing into real downloads.
import { beforeAll,afterAll } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function useTestArchive() {
 let root,previous;
 beforeAll(async()=>{
  previous=process.env.FLOOR_PLAN_ARCHIVE_DIR;
  root=await mkdtemp(join(tmpdir(),'floor-plan-store-test-'));
  process.env.FLOOR_PLAN_ARCHIVE_DIR=root;
 });
 afterAll(async()=>{
  if(previous===undefined) delete process.env.FLOOR_PLAN_ARCHIVE_DIR;
  else process.env.FLOOR_PLAN_ARCHIVE_DIR=previous;
  if(root) await rm(root,{recursive:true,force:true});
 });
}
