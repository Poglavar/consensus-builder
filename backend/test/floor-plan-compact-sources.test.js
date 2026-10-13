import { createHash } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactSources,prepareSourceEvidence,readSourceEvidence,sourceEvidenceMatches } from '../floor-plans/compact-sources.js';
import { writeSourceFile } from '../floor-plans/blob-store.js';
import { crawl } from '../floor-plans/crawler.js';
import { createTargetSelector } from '../floor-plans/crawl-queue.js';

const sha = value => createHash('sha256').update(value).digest('hex');

describe('processed source evidence',()=>{
 it('binds a bounded evidence packet to the exact page URL and source hash',()=>{
  const packet=prepareSourceEvidence({url:'https://agency.test/listing/1',sha256:'a'.repeat(64),
   html:'<html><title>Example</title><body><main><h1>Ilica 12</h1></main><p>OIB: 12345678901</p></body></html>',facts:{title:'Example'}});
  expect(sourceEvidenceMatches(packet,'https://agency.test/listing/1','a'.repeat(64))).toBe(true);
  expect(sourceEvidenceMatches(packet,'https://agency.test/listing/1','b'.repeat(64))).toBe(false);
  expect(packet.agencyIdentity.matches[0]).toMatchObject({oib:'12345678901'});
  expect(packet.building.text).toContain('Ilica 12');
 });

 it('uses the exact observation snapshot after source bytes are discarded',async()=>{
  const packet=prepareSourceEvidence({url:'https://agency.test/listing/2',sha256:'c'.repeat(64),html:'<main>Vukovarska 8</main>'});
  const db={query:vi.fn(async sql=>sql.includes('sourcePacket')?{rows:[{packet}]}:{rows:[]})};
  const evidence=await readSourceEvidence(db,{url:'https://agency.test/listing/2',sha256:'c'.repeat(64)});
  expect(evidence.from).toBe('snapshot');
  expect(evidence.building.text).toContain('Vukovarska 8');
  expect(db.query).toHaveBeenCalledTimes(1);
 });
});

describe('source compaction',()=>{
 let root,previous;
 beforeEach(async()=>{previous=process.env.FLOOR_PLAN_ARCHIVE_DIR;root=await mkdtemp(join(tmpdir(),'floor-plan-compact-test-'));process.env.FLOOR_PLAN_ARCHIVE_DIR=root;});
 afterEach(async()=>{if(previous===undefined)delete process.env.FLOOR_PLAN_ARCHIVE_DIR;else process.env.FLOOR_PLAN_ARCHIVE_DIR=previous;await rm(root,{recursive:true,force:true});});

 it('is a read-only audit by default',async()=>{
  const body=Buffer.from('<html><body>complete</body></html>'),hash=sha(body);
  const path=await writeSourceFile(body,hash,'text/html');
  const db={query:vi.fn(async sql=>{
   if(sql.includes('WITH candidate_hashes'))return {rows:[{url:'https://agency.test/x',kind:'page',sha256:hash,media_type:'text/html',byte_count:body.length,storage_path:path,bytes_available:true,facts:{}}]};
   if(sql.includes('SELECT DISTINCT t.url'))return {rows:[]};
   if(sql.includes('AS n FROM floor_plan.target'))return {rows:[{n:0}]};
   if(sql.includes('AS n FROM floor_plan.blob'))return {rows:[{n:0}]};
   return {rows:[],rowCount:0};
  })};
  const result=await compactSources(db);
  expect(result).toMatchObject({apply:false,htmlSources:1,htmlBlobs:1,htmlBytes:body.length,filesDeleted:0});
  expect(db.query.mock.calls.some(([sql])=>/UPDATE floor_plan\.(blob|observation|target)/.test(sql))).toBe(false);
 });

 it('writes and verifies snapshots before commit, then prunes files',async()=>{
  const body=Buffer.from('<html><body><main>Example Street 12</main></body></html>'),hash=sha(body);
  const path=await writeSourceFile(body,hash,'text/html');
  let committed=false,snapshot=null;
  const db={query:vi.fn(async(sql,params=[])=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('WITH candidate_hashes'))return {rows:[{url:'https://agency.test/listing',kind:'page',sha256:hash,media_type:'text/html',byte_count:body.length,storage_path:path,bytes_available:true,facts:{}}]};
   if(sql.includes('SELECT DISTINCT t.url'))return {rows:[]};
   if(sql.includes('AS n FROM floor_plan.target')||sql.includes('AS n FROM floor_plan.blob'))return {rows:[{n:0}]};
   if(sql.startsWith('UPDATE floor_plan.observation')){snapshot=JSON.parse(params[2]).sourcePacket;return {rowCount:1,rows:[]};}
   if(sql.includes("evidence->'sourcePacket' AS packet"))return {rows:[{packet:snapshot}]};
   if(sql==='COMMIT'){committed=true;return {rows:[]};}
   return {rows:[],rowCount:1};
  })};
  const prune=vi.fn(async()=>{expect(committed).toBe(true);return {filesDeleted:1,bytesDeleted:body.length};});
  const result=await compactSources(db,{apply:true,prune});
  expect(result).toMatchObject({apply:true,htmlBlobs:1,filesDeleted:1,bytesDeleted:body.length});
  expect(snapshot.source.sha256).toBe(hash);
  expect(db.query.mock.calls.some(([sql])=>sql.includes("discard_reason=$2"))).toBe(true);
  expect(prune).toHaveBeenCalledOnce();
 });

 it('does not prune if the metadata transaction fails before commit',async()=>{
  const body=Buffer.from('<html><body>rollback</body></html>'),hash=sha(body),path=await writeSourceFile(body,hash,'text/html');
  let snapshot=null;
  const db={query:vi.fn(async(sql,params=[])=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('WITH candidate_hashes'))return {rows:[{url:'https://agency.test/listing',kind:'page',sha256:hash,media_type:'text/html',byte_count:body.length,storage_path:path,bytes_available:true,facts:{}}]};
   if(sql.includes('SELECT DISTINCT t.url'))return {rows:[]};
   if(sql.includes('AS n FROM floor_plan.target')||sql.includes('AS n FROM floor_plan.blob'))return {rows:[{n:0}]};
   if(sql.startsWith('UPDATE floor_plan.observation')){snapshot=JSON.parse(params[2]).sourcePacket;return {rowCount:1,rows:[]};}
   if(sql.includes("evidence->'sourcePacket' AS packet"))return {rows:[{packet:snapshot}]};
   if(sql==='COMMIT')throw new Error('commit failed');
   return {rows:[],rowCount:1};
  })};
  const prune=vi.fn();
  await expect(compactSources(db,{apply:true,prune})).rejects.toThrow('commit failed');
  expect(db.query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(true);
  expect(prune).not.toHaveBeenCalled();
 });

 it('packs every current alias for a hash even when the hash limit is one',async()=>{
  const body=Buffer.from('<html><body>shared source</body></html>'),hash=sha(body),path=await writeSourceFile(body,hash,'text/html');
  const urls=['https://agency.test/old','https://agency.test/canonical'];
  const snapshots=new Map(),discard=[];
  const aliases=urls.map(url=>({url,kind:'page',sha256:hash,media_type:'text/html',byte_count:body.length,storage_path:path,bytes_available:true,facts:{}}));
  const db={query:vi.fn(async(sql,params=[])=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('WITH candidate_hashes'))return {rows:aliases};
   if(sql.includes('SELECT DISTINCT t.url'))return {rows:[]};
   if(sql.includes('AS n FROM floor_plan.target')||sql.includes('AS n FROM floor_plan.blob'))return {rows:[{n:0}]};
   if(sql.startsWith('UPDATE floor_plan.observation')){snapshots.set(params[0],JSON.parse(params[2]).sourcePacket);return {rowCount:1,rows:[]};}
   if(sql.includes("evidence->'sourcePacket' AS packet"))return {rows:[{packet:snapshots.get(params[0])}]};
   if(sql.includes('UPDATE floor_plan.blob SET bytes_available=false')){discard.push(...params[0]);return {rowCount:1,rows:[]};}
   return {rows:[],rowCount:1};
  })};
  const prune=vi.fn(async()=>({filesDeleted:1,bytesDeleted:body.length}));
  const result=await compactSources(db,{apply:true,limit:1,prune});
  expect(result).toMatchObject({htmlSources:2,htmlBlobs:1,htmlBytes:body.length});
  expect([...snapshots.keys()]).toEqual(urls);
  expect(urls.every(url=>sourceEvidenceMatches(snapshots.get(url),url,hash))).toBe(true);
  expect(discard).toEqual([hash]);
  expect(prune).toHaveBeenCalledOnce();
 });

 it('retains shared bytes when any current alias cannot be parsed into a valid packet',async()=>{
  const body=Buffer.from('<html><body>shared source</body></html>'),hash=sha(body),path=await writeSourceFile(body,hash,'text/html');
  const aliases=['https://agency.test/good','data:text/html,bad-url'].map(url=>({url,kind:'page',sha256:hash,
   media_type:'text/html',byte_count:body.length,storage_path:path,bytes_available:true,facts:{}}));
  const db={query:vi.fn(async sql=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('WITH candidate_hashes'))return {rows:aliases};
   if(sql.includes('SELECT DISTINCT t.url'))return {rows:[]};
   if(sql.includes('AS n FROM floor_plan.target')||sql.includes('AS n FROM floor_plan.blob'))return {rows:[{n:0}]};
   return {rows:[],rowCount:1};
  })};
  const prune=vi.fn();
  const result=await compactSources(db,{apply:true,prune});
  expect(result).toMatchObject({htmlSources:0,htmlBlobs:0,sourceReadErrors:1});
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE floor_plan.observation'))).toBe(false);
  expect(db.query.mock.calls.some(([sql])=>sql.includes("discard_reason=$2"))).toBe(false);
  expect(prune).not.toHaveBeenCalled();
 });

 it('checks plan labels across every URL alias before compacting an envelope hash',async()=>{
  let envelopeSql='';
  const db={query:vi.fn(async sql=>{
   if(sql.includes('WITH candidate_hashes'))return {rows:[]};
   if(sql.includes('SELECT DISTINCT t.url')){envelopeSql=sql;return {rows:[]};}
   if(sql.includes('AS n FROM floor_plan.target')||sql.includes('AS n FROM floor_plan.blob'))return {rows:[{n:0}]};
   return {rows:[],rowCount:1};
  })};
  const result=await compactSources(db);
  expect(result.envelopeBlobs).toBe(0);
  expect(envelopeSql).toContain("plan_alias.kind='asset'");
  expect(envelopeSql).toContain('plan_observation.sha256=t.current_sha256');
  expect(envelopeSql).toContain("a->>'kind'='floor-plan'");
  expect(envelopeSql).toContain('alias.current_sha256=t.current_sha256');
  expect(envelopeSql).toContain('pt.source_sha256=alias.current_sha256');
  expect(envelopeSql).toContain('it.source_sha256=alias.current_sha256');
 });

 it('retries pruning committed tombstones after a previous prune interruption',async()=>{
  const body=Buffer.from('<html><body>retry source</body></html>'),hash=sha(body),path=await writeSourceFile(body,hash,'text/html');
  let discarded=false,snapshot=null;
  const row={url:'https://agency.test/retry',kind:'page',sha256:hash,media_type:'text/html',byte_count:body.length,
   storage_path:path,bytes_available:true,facts:{}};
  const db={query:vi.fn(async(sql,params=[])=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('WITH candidate_hashes'))return {rows:discarded?[]:[row]};
   if(sql.includes('SELECT DISTINCT t.url'))return {rows:[]};
   if(sql.includes('SELECT sha256 FROM floor_plan.blob'))return {rows:discarded?[{sha256:hash}]:[]};
   if(sql.includes('discard_reason IN'))return {rows:[{n:discarded?1:0}]};
   if(sql.includes('AS n FROM floor_plan.target')||sql.includes('AS n FROM floor_plan.blob'))return {rows:[{n:0}]};
   if(sql.startsWith('UPDATE floor_plan.observation')){snapshot=JSON.parse(params[2]).sourcePacket;return {rowCount:1,rows:[]};}
   if(sql.includes("evidence->'sourcePacket' AS packet"))return {rows:[{packet:snapshot}]};
   if(sql.startsWith('UPDATE floor_plan.blob SET bytes_available=false')){discarded=true;return {rowCount:1,rows:[]};}
   return {rows:[],rowCount:1};
  })};
  const prune=vi.fn(async(_db,{hashes})=>{
   expect(hashes).toContain(hash);
   if(prune.mock.calls.length===1)throw new Error('unlink interrupted');
   return {filesDeleted:1,bytesDeleted:body.length};
  });
  await expect(compactSources(db,{apply:true,prune})).rejects.toThrow('unlink interrupted');
  expect(discarded).toBe(true);
  const resumed=await compactSources(db,{apply:true,prune});
  expect(resumed).toMatchObject({htmlBlobs:0,filesDeleted:1,bytesDeleted:body.length});
  expect(prune).toHaveBeenCalledTimes(2);
 });

 it('preserves bytes and reports deferred work when the deadline is already reached',async()=>{
  const body=Buffer.from('<html><body>deferred source</body></html>'),hash=sha(body),path=await writeSourceFile(body,hash,'text/html');
  const row={url:'https://agency.test/deferred',kind:'page',sha256:hash,media_type:'text/html',byte_count:body.length,
   storage_path:path,bytes_available:true,facts:{}};
  const db={query:vi.fn(async(sql)=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('WITH candidate_hashes'))return {rows:[row]};
   if(sql.includes('SELECT DISTINCT t.url'))return {rows:[]};
   if(sql.includes('SELECT sha256 FROM floor_plan.blob'))return {rows:[]};
   if(sql.includes('AS n FROM floor_plan.target')||sql.includes('AS n FROM floor_plan.blob')||sql.includes('discard_reason IN'))return {rows:[{n:0}]};
   return {rows:[],rowCount:1};
  })};
  const prune=vi.fn();
  const result=await compactSources(db,{apply:true,deadline:Date.now()-1,prune});
  expect(result.deferred).toBe(1);
  expect(result.htmlBlobs).toBe(0);
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE floor_plan.observation'))).toBe(false);
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE floor_plan.blob SET bytes_available=false'))).toBe(false);
  expect(prune).not.toHaveBeenCalled();
 });
});

describe('conditional crawl of compacted pages',()=>{
 const dbForCrawl=()=>({query:vi.fn(async sql=>{
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
  if(sql.includes('AS allowed FROM floor_plan.target'))return {rows:[{allowed:true}]};
  if(sql.includes('AS total,count(website)'))return {rows:[{total:0,websites:0}]};
  if(sql.includes('SELECT count(*) AS n'))return {rows:[{n:'0'}]};
  return {rows:[],rowCount:1};
 })});

 it('accepts 304 only when the completed evidence packet remains available',async()=>{
  const db=dbForCrawl(),target={kind:'page',url:'https://agency.test/listing',current_sha256:'d'.repeat(64),
   cached_bytes_available:false,cached_processed:true,etag:'"v1"',last_modified:'yesterday'};
  const fetcher=vi.fn(async()=>({status:304,notModified:true,body:null,headers:{}}));
  const result=await crawl(db,{maxPages:1,log:()=>{},selectTarget:async()=>target,fetcher});
  expect(fetcher).toHaveBeenCalledWith(target.url,{etag:target.etag,lastModified:target.last_modified});
  expect(result.counters).toMatchObject({unchanged:1,notModified:1,changed:0});
  expect(db.query.mock.calls.some(([sql])=>/INSERT INTO floor_plan\.(blob|observation|listing)/.test(sql))).toBe(false);
 });

 it('processes changed bytes at the same compacted URL',async()=>{
  const db=dbForCrawl(),body=Buffer.from('<html><body><main>Changed source</main></body></html>');
  const target={kind:'page',url:'https://agency.test/listing',current_sha256:'e'.repeat(64),
   cached_bytes_available:false,cached_processed:true,etag:'"v1"'};
  const fetcher=vi.fn(async()=>({status:200,body,headers:{contentType:'text/html',etag:'"v2"'},finalUrl:target.url}));
  const result=await crawl(db,{maxPages:1,log:()=>{},selectTarget:async()=>target,fetcher});
  expect(result.counters.changed).toBe(1);
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO floor_plan.observation'))).toBe(true);
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO floor_plan.blob'))).toBe(true);
 });

 it('requires a schema and exact source and building URL/hash binding for cached processed bytes',async()=>{
  const target={kind:'page',url:'https://agency.test/listing',current_sha256:'f'.repeat(64),cached_processed:false};
  const db={query:vi.fn(async sql=>sql.includes('SELECT t.*')?{rows:[target]}:{rows:[]})};
  await createTargetSelector({discoveryOnly:true})(db);
  const sql=db.query.mock.calls.find(([query])=>query.includes('SELECT t.*'))[0];
  expect(sql).toContain("o.evidence->'sourcePacket'->>'schema'='processed-source-evidence.v1'");
  expect(sql).toContain("o.evidence->'sourcePacket'->'source'->>'url'=t.url");
  expect(sql).toContain("o.evidence->'sourcePacket'->'source'->>'sha256'=t.current_sha256");
  expect(sql).toContain("o.evidence->'sourcePacket'->'building'->'source'->>'url'=t.url");
  expect(sql).toContain("o.evidence->'sourcePacket'->'building'->'source'->>'sha256'=t.current_sha256");
  expect(sql).not.toContain("b.media_type ~* 'xml' OR");
 });
});
