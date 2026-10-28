// Real derivation plus ballot-state checks: private assignments, fixed eligibility, history and concurrent votes.
import {describe,it,expect,beforeAll} from 'vitest';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createVotingService} from '../agreements/voting.js';
import {createMcpVotingTools} from '../agents/mcp-voting.js';
import {cidOfObject} from '../cid.js';
const require=createRequire(import.meta.url),V=require('../../frontend/js/community/voting.js'),Record=require('../../frontend/js/agreement-record.js');
const ID=randomUUID(),CODE='KRM-TAV-DBN-WEX-HPS';let hash,config;
beforeAll(async()=>{hash=await V.codeHash(ID,CODE);config=V.configuration({schema:'community-voting/v1',id:ID,codeHashes:[hash]});});
function memoryStore(){const polls=new Map();let queue=Promise.resolve();return {transaction(cid,work){const task=queue.then(async()=>{
 if(!polls.has(cid))polls.set(cid,{ballots:new Map(),history:new Map(),limits:new Map()});const s=polls.get(cid);
 return work({counts:async()=>V.CHOICES.map(choice=>({choice,count:[...s.ballots.values()].filter(b=>b.choice===choice).length})),
 ballot:async h=>structuredClone(s.ballots.get(h)||{version:0,choice:null}),update:async(h,b)=>s.ballots.set(h,structuredClone(b)),
 history:async h=>structuredClone(s.history.get(h)||[]),append:async(h,e)=>s.history.set(h,[...(s.history.get(h)||[]),structuredClone(e)]),
 throttle:async(scope,now,limit,delayed,consume=true)=>{let r=s.limits.get(scope);if(!r||now-r.at>=300000)r={at:now,attempts:0,until:0};
 if(r.until>now)return Math.ceil((r.until-now)/1000);if(!consume)return 0;r.attempts++;
 const delay=r.attempts>=limit?Math.max(1000,300000-(now-r.at)):delayed?Math.min(60000,1000*2**Math.min(6,r.attempts-1)):0;
 r.until=now+delay;s.limits.set(scope,r);return Math.ceil(delay/1000);}});
 });queue=task.catch(()=>{});return task;}};}
function fixture({deadline=null}={}){let time=Date.parse('2026-10-27T12:00:00Z');const content={rule:{electorate:'community',binding:false},consultation:{organiser:null,participationUrl:null,voting:config},deadline};
 const cid=cidOfObject(content),agreement={cid,content},store=memoryStore(),deps={store,loadAgreement:async key=>key===cid?agreement:null,now:()=>time};
 return {cid,agreement,store,service:createVotingService(deps),second:createVotingService(deps),advance:ms=>time+=ms};}
const ballot=(choice,version,requestId=randomUUID())=>({code:CODE,choice,expectedVersion:version,requestId});
describe('local codes and immutable eligibility',()=>{
 it('accepts lowercase, spaces and dashes and excludes ambiguous characters',()=>{expect(V.formatCode('krm tav dbn wex hps')).toBe(CODE);expect(()=>V.normalizeCode('III-LLL-OOO-AAA-BBB')).toThrow();for(let i=0;i<30;i++)expect(V.generateCode()).toMatch(/^[A-HJKMNP-Z]{3}(?:-[A-HJKMNP-Z]{3}){4}$/);expect(V.CODE_LENGTH*Math.log2(V.ALPHABET.length)).toBeGreaterThan(66);});
 it('derives verifiers for one list, restores local files, and keeps names and codes out of metadata',async()=>{
 expect(await V.codeHash(ID,'krm tav dbn wex hps')).toBe(hash);expect(await V.codeHash(randomUUID(),CODE)).not.toBe(hash);
 const [row]=await V.generateEntries(ID,['Resident A']);expect((await V.importLocalFile(V.localFile(ID,[row]))).entries).toEqual([row]);
 const published=Record.consultationOf({organiser:null,participationUrl:null,voting:V.configuration({schema:'community-voting/v1',id:ID,codeHashes:[row.codeHash]})},'community');
 expect(JSON.stringify(published)).not.toContain('Resident A');expect(JSON.stringify(published)).not.toContain(row.code);expect(V.distributionCsv([{label:'=SUM(1,2)',code:CODE}])).toContain("\"'=SUM(1,2)\"");});
 it('rejects raw codes, names and duplicates; different eligibility changes the content commitment',()=>{
 expect(()=>V.configuration({...config,names:['Person']})).toThrow();expect(()=>V.configuration({...config,codeHashes:[CODE]})).toThrow();expect(()=>V.configuration({...config,codeHashes:[hash,hash]})).toThrow();expect(()=>Record.consultationOf({voting:config},'owners')).toThrow();
 expect(cidOfObject({voting:config})).not.toBe(cidOfObject({voting:{...config,codeHashes:[hash,'0'.repeat(64)].sort()}}));});
});
describe('ballots and their private history',()=>{
 it('counts one latest choice and shows every change to its code holder',async()=>{const f=fixture();expect((await f.service.access(f.cid,{code:CODE},'a')).body.entry).toMatchObject({version:0,choice:null,history:[]});
 const first=await f.service.access(f.cid,ballot('support',0),'a',true);expect(first.body).toMatchObject({votes:1,eligible:1,counts:{support:1,oppose:0,abstain:0}});f.advance(2000);
 const second=await f.service.access(f.cid,ballot('oppose',1),'a',true);expect(second.body.entry.history.map(e=>e.choice)).toEqual(['support','oppose']);expect(second.body.counts).toEqual({support:0,oppose:1,abstain:0});expect((await f.service.summary(f.cid)).body.entry).toBeUndefined();expect(second.body.entry.history[0].occurredAt).toBe('2026-10-27T12:00:00.000Z');});
 it('deduplicates retries and refuses changed reuse of a request ID',async()=>{const f=fixture(),r=ballot('support',0);await f.service.access(f.cid,r,'a',true);const retry=await f.service.access(f.cid,r,'a',true);expect(retry.body.duplicate).toBe(true);expect(retry.body.entry.history).toHaveLength(1);expect((await f.service.access(f.cid,{...r,choice:'oppose'},'a',true)).body.code).toBe('request-conflict');});
 it('serializes concurrent votes and refuses a stale version',async()=>{const f=fixture();const r=await Promise.all([f.service.access(f.cid,ballot('support',0),'a',true),f.second.access(f.cid,ballot('oppose',0),'b',true)]);expect(r.map(v=>v.status).sort()).toEqual([200,409]);expect((await f.service.access(f.cid,{code:CODE},'c')).body.entry.history).toHaveLength(1);});
 it('keeps history after closing and never transfers votes into a new agreement',async()=>{const f=fixture({deadline:'2026-10-27T12:00:10.000Z'});await f.service.access(f.cid,ballot('support',0),'a',true);f.advance(11000);expect((await f.service.access(f.cid,ballot('oppose',1),'a',true)).body.code).toBe('voting-closed');expect((await f.service.access(f.cid,{code:CODE},'a')).body.entry.history).toHaveLength(1);const other=fixture({deadline:'2026-10-28T12:00:00.000Z'});expect((await other.service.access(other.cid,{code:CODE},'a')).body.entry.choice).toBeNull();});
 it('increases delays across API workers, including malformed codes',async()=>{const f=fixture();const bad=await f.service.access(f.cid,{code:'ABC'},'a');expect(bad.status).toBe(401);expect(bad.body.retryAfter).toBe(1);expect(bad.body.entry).toBeUndefined();expect((await f.second.access(f.cid,{code:'ABC'},'a')).status).toBe(429);f.advance(1000);expect((await f.second.access(f.cid,{code:'ABC'},'a')).body.retryAfter).toBe(2);f.advance(2000);expect((await f.service.access(f.cid,{code:'ABC'},'a')).body.retryAfter).toBe(4);f.advance(300000);expect((await f.service.access(f.cid,{code:CODE},'a')).status).toBe(200);});
 it('MCP uses the same endpoints and requires explicit authorization to vote',async()=>{const calls=[],tools=createMcpVotingTools({read:{request:async(...args)=>{calls.push(args);return {};}}});await tools.votingStatus({agreementCid:'cid',code:CODE});expect(calls[0]).toEqual(['/agreements/cid/voting/access',{}, {code:CODE}]);expect(()=>tools.castCommunityVote({agreementCid:'cid',...ballot('support',0)})).toThrow(/Confirm/);const r=ballot('support',0);await tools.castCommunityVote({agreementCid:'cid',...r,confirm:true});expect(calls[1]).toEqual(['/agreements/cid/voting/ballot',{},r]);});
});

describe('MCP voting contract',()=>{
 it('exposes fixed eligibility through agreement editing and validates ballot authorization',async()=>{
  const {registerMcpCompanion}=await import('../agents/mcp-companion.mjs');
  const tools=new Map();registerMcpCompanion({registerTool:(name,definition)=>tools.set(name,definition),registerResource(){},registerPrompt(){}},
    {actions:{},handler:fn=>fn,readOnly:{readOnlyHint:true},discovery:{}});
  const cast=tools.get('ugt_cast_community_vote');
  const args={agreementCid:fixture().cid,...ballot('support',0),confirm:true};
  expect(cast.inputSchema.safeParse(args).success).toBe(true);
  expect(cast.inputSchema.safeParse({...args,confirm:false}).success).toBe(false);
  expect(cast.inputSchema.safeParse({...args,phone:'private'}).success).toBe(false);
  expect(cast.annotations.readOnlyHint).toBe(false);
  const edit=tools.get('ugt_edit_agreement').inputSchema;
  expect(edit.safeParse({plan:fixture().cid,expectedCid:fixture().cid,terms:{consultation:{organiser:null,participationUrl:null,voting:config}}}).success).toBe(true);
 });
});

it('caps a parallel guessing burst across workers before deriving further codes',async()=>{
 const f=fixture();
 const attempts=await Promise.all(Array.from({length:140},(_,index)=>(index%2?f.service:f.second).access(f.cid,{code:'ABC'},'shared-client')));
 expect(attempts.filter(result=>result.status===401).length).toBeLessThanOrEqual(119);
 expect(attempts.filter(result=>result.status===429).length).toBeGreaterThanOrEqual(21);
 expect((await f.second.access(f.cid,{code:CODE},'shared-client')).status).toBe(429);
 expect((await f.second.access(f.cid,{code:CODE},'another-client')).status).toBe(200);
});
