// Verify located-building extraction and honest pending/unprocessed accounting.
import {describe,expect,it,vi} from 'vitest';
import {processAssets} from '../floor-plans/process-assets.js';
import {readBlobRow} from '../floor-plans/blob-store.js';
vi.mock('../floor-plans/blob-store.js',()=>({readBlobRow:vi.fn(async()=>Buffer.from('fixture'))}));

const hash=n=>String(n).repeat(64);
const extracted={schema:'consensus-builder.floor-plan-draft.v1',status:'needs_review',pages:[],totalPages:1};
function mockDb(rows,{pending=0,deferred=0,awaiting=0}={}) {
 const calls=[];
 return {calls,query:vi.fn(async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
  if(sql.includes('SELECT e.sha256,b.media_type,b.storage_path')) return {rows};
  if(sql.includes('count(*) AS n')&&sql.includes('floor_plan.extraction')) return {rows:[{n:
   sql.includes('AND NOT EXISTS (SELECT 1 FROM floor_plan.target location_asset')?deferred:
   sql.includes('AND NOT (lower(b.media_type)')?awaiting:pending}]};
  if(sql.startsWith('UPDATE floor_plan.extraction')) return {rows:[],rowCount:1};
  return {rows:[],rowCount:1};
 })};
}
const extractor=vi.fn(async()=>({stdout:JSON.stringify(extracted)}));

describe('building-located floor-plan extraction',()=>{
 it('limits selection to sources with a located owner before invoking the extractor',async()=>{
  const db=mockDb([{sha256:hash(1),media_type:'application/pdf',storage_path:'blob.pdf',byte_count:3,bytes_available:true}]);
  const result=await processAssets(db,{maxAssets:1,maxMinutes:2,extractor,log:()=>{}});
  expect(result).toMatchObject({status:'complete',selected:1,processed:1,needsReview:1,failed:0,pending:0});
  const selection=db.calls.find(call=>call.sql.includes('SELECT e.sha256,b.media_type,b.storage_path'));
  expect(selection.sql).toContain('b.bytes_available');
  expect(selection.args).toEqual([1,null]);
  expect(selection.sql).toContain('location_asset.current_sha256=e.sha256');
  expect(selection.sql).toContain('location_asset.kind=\'asset\'');
  expect(extractor).toHaveBeenCalledOnce();
 });

 it('applies the listing cohort alongside ownership and location gates to selection and all pending counts',async()=>{
  const urls=['https://agency.test/new/1','https://agency.test/new/2'];
  const db=mockDb([],{pending:2,deferred:3,awaiting:4}),runExtractor=vi.fn();
  const result=await processAssets(db,{listingUrls:urls,extractor:runExtractor,log:()=>{}});
  expect(result).toMatchObject({selected:0,pending:2,awaitingImageClassification:4,deferredUnmatched:3});
  const selection=db.calls.find(call=>call.sql.includes('SELECT e.sha256,b.media_type,b.storage_path'));
  expect(selection.args).toEqual([100,urls]);
  expect(selection.sql).toContain('location_asset.current_sha256=e.sha256');
  expect(selection.sql).toContain('cohort_listing.asset_urls @>');
  const scopedCounts=db.calls.filter(call=>call.sql.includes('count(*) AS n')&&call.sql.includes('floor_plan.extraction'));
  expect(scopedCounts).toHaveLength(3);
  for(const call of scopedCounts) {
   expect(call.args).toEqual([urls]);
   expect(call.sql).toContain('cohort_listing.url=ANY($1::text[])');
   expect(call.sql).toContain('cohort_listing.asset_urls @>');
  }
  expect(runExtractor).not.toHaveBeenCalled();
 });

 it('rejects empty, duplicate, or non-HTTP listing cohorts before querying',async()=>{
  for(const listingUrls of [[],['https://agency.test/1','https://agency.test/1'],['file:///tmp/listing']]) {
   const db=mockDb([]);
   await expect(processAssets(db,{listingUrls})).rejects.toThrow(/listingUrls must be a nonempty array/);
   expect(db.query).not.toHaveBeenCalled();
  }
 });

 it('records remaining located work and defers unlocated sources when time runs out',async()=>{
  let clock=1000;const db=mockDb([1,2].map(n=>({sha256:hash(n),media_type:'image/png',storage_path:`${n}.png`,byte_count:5,bytes_available:true})),{pending:1,deferred:3});
  const runExtractor=vi.fn(async()=>{clock=62000;return {stdout:JSON.stringify(extracted)};});
  const result=await processAssets(db,{maxAssets:2,maxMinutes:1,now:()=>clock,extractor:runExtractor,log:()=>{}});
  expect(result).toMatchObject({status:'partial',selected:2,processed:1,unprocessed:1,pending:1,deferredUnmatched:3});
  expect(runExtractor).toHaveBeenCalledOnce();
 });

 it('does not extract unlocated sources and reports their backlog as partial',async()=>{
  const db=mockDb([],{deferred:2});
  const runExtractor=vi.fn();
  const result=await processAssets(db,{extractor:runExtractor,log:()=>{}});
  expect(result).toMatchObject({status:'partial',selected:0,pending:0,deferredUnmatched:2});
  expect(runExtractor).not.toHaveBeenCalled();
  expect(db.calls.find(({sql})=>sql.includes('AND NOT EXISTS (SELECT 1 FROM floor_plan.target location_asset'))).toBeTruthy();
 });

 it('marks extractor failures and does not report a successful empty extraction',async()=>{
  const db=mockDb([{sha256:hash(3),media_type:'application/pdf',storage_path:'bad.pdf',byte_count:3,bytes_available:true}]);
  const result=await processAssets(db,{maxAssets:1,maxMinutes:2,extractor:async()=>{throw new Error('OpenCV unavailable');},log:()=>{}});
  expect(result).toMatchObject({status:'partial',selected:1,processed:1,failed:1,pending:0});
  expect(db.calls.some(({sql,args})=>sql.includes("SET status='error'")&&args[0]===hash(3))).toBe(true);
 });

 it('surfaces missing retained files as extraction errors',async()=>{
  const sha=hash(4),db=mockDb([{sha256:sha,media_type:'application/pdf',storage_path:'missing.pdf',byte_count:3,bytes_available:true}]);
  readBlobRow.mockResolvedValueOnce(null);
  const runExtractor=vi.fn();
  const result=await processAssets(db,{maxAssets:1,maxMinutes:2,extractor:runExtractor,log:()=>{}});
  expect(result).toMatchObject({status:'partial',selected:1,processed:1,failed:1});
  expect(runExtractor).not.toHaveBeenCalled();
  expect(db.calls.some(({sql,args})=>sql.includes("SET status='error'")&&args[0]===sha&&/Archived source bytes are missing/.test(args[1]))).toBe(true);
 });
});
