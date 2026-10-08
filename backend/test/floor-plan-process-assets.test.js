// Verify matched-only extraction and honest pending/unprocessed accounting.
import {describe,expect,it,vi} from 'vitest';
import {processAssets} from '../floor-plans/process-assets.js';

const hash=n=>String(n).repeat(64);
const extracted={schema:'consensus-builder.floor-plan-draft.v1',status:'needs_review',pages:[],totalPages:1};
function mockDb(rows,{pending=0,deferred=0}={}) {
 const calls=[];
 return {calls,query:vi.fn(async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
  if(sql.includes('SELECT e.sha256,b.media_type,b.data')) return {rows};
  if(sql.includes('count(*) AS n')&&sql.includes('floor_plan.extraction')) return {rows:[{n:sql.includes('NOT EXISTS')?deferred:pending}]};
  if(sql.startsWith('UPDATE floor_plan.extraction')) return {rows:[],rowCount:1};
  return {rows:[],rowCount:1};
 })};
}
const extractor=vi.fn(async()=>({stdout:JSON.stringify(extracted)}));

describe('matched floor-plan extraction',()=>{
 it('limits selection to matched assets and checks all extractor dependencies before status completion',async()=>{
  const db=mockDb([{sha256:hash(1),media_type:'application/pdf',data:Buffer.from('pdf')}]);
  const result=await processAssets(db,{maxAssets:1,maxMinutes:2,matchedOnly:true,extractor,log:()=>{}});
  expect(result).toMatchObject({status:'complete',selected:1,processed:1,needsReview:1,failed:0,pending:0});
  const selection=db.calls.find(call=>call.sql.includes('SELECT e.sha256,b.media_type,b.data'));
  expect(selection.args).toEqual([1,true]);
  expect(selection.sql).toContain("listingOwned");
  expect(extractor).toHaveBeenCalledOnce();
 });

 it('records remaining matched work when the shared deadline leaves selected rows unprocessed',async()=>{
  let clock=1000;const db=mockDb([1,2].map(n=>({sha256:hash(n),media_type:'image/png',data:Buffer.from('image')})),{pending:1,deferred:3});
  const runExtractor=vi.fn(async()=>{clock=62000;return {stdout:JSON.stringify(extracted)};});
  const result=await processAssets(db,{maxAssets:2,maxMinutes:1,matchedOnly:true,now:()=>clock,extractor:runExtractor,log:()=>{}});
  expect(result).toMatchObject({status:'partial',selected:2,processed:1,unprocessed:1,pending:1,deferredUnmatched:3});
  expect(runExtractor).toHaveBeenCalledOnce();
 });

 it('marks extractor failures and does not report a successful empty extraction',async()=>{
  const db=mockDb([{sha256:hash(3),media_type:'application/pdf',data:Buffer.from('bad')}]);
  const result=await processAssets(db,{maxAssets:1,maxMinutes:2,extractor:async()=>{throw new Error('OpenCV unavailable');},log:()=>{}});
  expect(result).toMatchObject({status:'partial',selected:1,processed:1,failed:1,pending:0});
  expect(db.calls.some(({sql,args})=>sql.includes("SET status='error'")&&args[0]===hash(3))).toBe(true);
 });
});
