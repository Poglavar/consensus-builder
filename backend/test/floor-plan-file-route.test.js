import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash,writeSourceFile } from '../floor-plans/blob-store.js';
import { setupFloorPlanArchiveRoute } from '../routes/floor-plan-archive.js';

let archiveDir;
beforeEach(async()=>{
 archiveDir=await mkdtemp(join(tmpdir(),'floor-plan-route-'));
 vi.stubEnv('FLOOR_PLAN_ARCHIVE_DIR',archiveDir);
});
afterEach(async()=>{
 vi.unstubAllEnvs();
 if(archiveDir) await rm(archiveDir,{recursive:true,force:true});
});

function setup(row) {
 const routes=new Map(),app={get:(path,handler)=>routes.set(path,handler)};
 const pool={query:vi.fn(async sql=>({rows:sql.includes('FROM floor_plan.blob b JOIN floor_plan.extraction')?[row]:[]}))};
 setupFloorPlanArchiveRoute(app,pool);
 return {handler:routes.get('/floor-plan-archive/asset/:sha256'),pool};
}
function response() {
 return {set:vi.fn().mockReturnThis(),status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis(),send:vi.fn().mockReturnThis()};
}
function metadata(bytes,mediaType='image/png',overrides={}) {
 const sha256=contentHash(bytes);
 return {sha256,media_type:mediaType,storage_path:`images/${sha256.slice(0,2)}/${sha256}.png`,
  byte_count:bytes.length,bytes_available:true,...overrides};
}

describe('floor-plan asset file route',()=>{
 it('serves verified bytes from the local archive using metadata only',async()=>{
  const bytes=Buffer.from('fixture image'),row=metadata(bytes),{handler,pool}=setup(row),res=response(),next=vi.fn();
  await writeSourceFile(bytes,row.sha256,row.media_type,{root:archiveDir});
  await handler({params:{sha256:row.sha256}},res,next);
  expect(next).not.toHaveBeenCalled();
  expect(res.set).toHaveBeenCalledWith('Content-Type','image/png');
  expect(res.set).toHaveBeenCalledWith('X-Content-Type-Options','nosniff');
  expect(res.send).toHaveBeenCalledWith(bytes);
  expect(pool.query.mock.calls[0][0]).not.toMatch(/\bdata\b/i);
 });

 it('returns 410 for discarded bytes',async()=>{
  const bytes=Buffer.from('discarded'),row=metadata(bytes,'image/png',{bytes_available:false,storage_path:null}),{handler}=setup(row),res=response();
  await handler({params:{sha256:row.sha256}},res,vi.fn());
  expect(res.status).toHaveBeenCalledWith(410);
  expect(res.json).toHaveBeenCalledWith({error:'Source bytes were discarded after non-plan classification.'});
 });

 it('passes a missing retained file to the route error handler',async()=>{
  const bytes=Buffer.from('missing'),row=metadata(bytes),{handler}=setup(row),res=response(),next=vi.fn();
  await handler({params:{sha256:row.sha256}},res,next);
  expect(res.status).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  expect(next.mock.calls[0][0]).toMatchObject({code:'ARCHIVE_SOURCE_MISSING'});
 });

 it('rejects unsupported MIME types before reading storage',async()=>{
  const bytes=Buffer.from('json'),row=metadata(bytes,'application/json'),{handler}=setup(row),res=response(),next=vi.fn();
  await handler({params:{sha256:row.sha256}},res,next);
  expect(res.status).toHaveBeenCalledWith(415);
  expect(res.json).toHaveBeenCalledWith({error:'Source is not a displayable plan image or PDF.'});
  expect(next).not.toHaveBeenCalled();
 });

 it('rejects malformed hashes without querying the database',async()=>{
  const {handler,pool}=setup(null),res=response();
  await handler({params:{sha256:'../secret'}},res,vi.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(pool.query).not.toHaveBeenCalled();
 });
});
