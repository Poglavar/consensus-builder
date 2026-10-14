import { describe,expect,it,vi } from 'vitest';
import { recordImageDisposition,NEGATIVE_IMAGE_CACHE_SQL } from '../floor-plans/image-retention.js';
import { putBlob,sha256 as hashBytes } from '../floor-plans/archive.js';
import { setupFloorPlanArchiveRoute } from '../routes/floor-plan-archive.js';
import { readFile } from 'node:fs/promises';
import { sourceFilePath } from '../floor-plans/blob-store.js';
import { useTestArchive } from './helpers/floor-plan-file-store.js';

useTestArchive();

const sourceUrl='https://cdn.example/photo.jpg';
const bytes=Buffer.from('image bytes');
const sha256=hashBytes(bytes);

function fakeDb({urls=[sourceUrl],protectedBy={}}={}) {
 const queries=[];
 const db={query:vi.fn(async(sql,params=[])=>{
  queries.push([sql,params]);
  if(sql.includes('FROM floor_plan.blob WHERE sha256=$1 FOR UPDATE'))
   return {rows:[{sha256,media_type:'image/jpeg',retained:true}]};
  if(sql.includes("FROM floor_plan.target WHERE current_sha256=$1 AND kind='asset'"))
   return {rows:urls.map(url=>({url}))};
  if(sql.includes('AS registered_model')) return {rows:[{registered_model:Boolean(protectedBy.registered_model)}]};
  if(sql.includes('AS nonasset_target')) return {rows:[protectedBy]};
  return {rows:[],rowCount:1};
 })};
 return {db,queries};
}

describe('confirmed image retention',()=>{
 it('keeps a URL-and-current-hash negative cache while discarding only bytes',async()=>{
  const {db,queries}=fakeDb({urls:[sourceUrl,'https://other.example/same.jpg']});
  const result=await recordImageDisposition(db,{sourceUrl,sha256,kind:'photo',classificationId:'screen-1',confirmed:true,confidence:'high'});
  expect(result).toMatchObject({status:'discarded',targets:2});
  const target=queries.find(([sql])=>sql.includes('UPDATE floor_plan.target SET image_kind'));
  const blob=queries.find(([sql])=>sql.includes('UPDATE floor_plan.blob SET bytes_available=false'));
  expect(target[1]).toEqual([sha256,'photo']);
  expect(blob[1][0]).toBe(sha256);
  expect(JSON.parse(blob[1][1])).toMatchObject({kind:'photo',classificationId:'screen-1',confidence:'high'});
  expect(queries.map(([sql])=>sql)).toContain('COMMIT');
  expect(queries.some(([sql])=>/DELETE FROM floor_plan/.test(sql))).toBe(false);
  expect(NEGATIVE_IMAGE_CACHE_SQL).toContain('t.image_classified_sha256=t.current_sha256');
  expect(NEGATIVE_IMAGE_CACHE_SQL).toContain("t.image_kind IN ('photo','render')");
  expect(NEGATIVE_IMAGE_CACHE_SQL).toMatch(/^COALESCE\(.*false\)$/s);
 });

 it('checks registered models on the supplied references DB and prunes only after archive commit',async()=>{
  const {db,queries}=fakeDb();
  const referencesDb={query:vi.fn(async(sql,params)=>({rows:[{registered_model:false}]}))};
  const prune=vi.fn(async()=>{expect(queries.at(-1)[0]).toBe('COMMIT');});
  expect(await recordImageDisposition(db,{sourceUrl,sha256,kind:'photo',classificationId:'screen-ref',confirmed:true,
   referencesDb,prune})).toMatchObject({status:'discarded'});
  expect(referencesDb.query).toHaveBeenCalledOnce();
  expect(referencesDb.query.mock.calls[0][0]).toContain('consensus.building_floor_model');
  expect(referencesDb.query.mock.calls[0][1]).toEqual([sha256]);
  expect(queries.find(([sql])=>sql.includes('AS nonasset_target'))[0]).not.toContain('consensus.building_floor_model');
  expect(prune).toHaveBeenCalledWith(db,{hashes:[sha256]});
 });

 it('keeps protection queries on the archive DB by default',async()=>{
  const {db,queries}=fakeDb({protectedBy:{registered_model:true}});
  expect(await recordImageDisposition(db,{sourceUrl,sha256,kind:'photo',classificationId:'screen-default',confirmed:true}))
   .toMatchObject({status:'protected',reasons:['registered_model']});
  expect(queries.some(([sql])=>sql.includes('AS registered_model')&&sql.includes('consensus.building_floor_model'))).toBe(true);
 });

 it.each(['labelled_plan','plan_task','building_task','processed_plan','reviewed_extraction','reviewed_revision','registered_model','nonasset_target','nonasset_observation'])
 ('retains shared or protected source bytes when %s uses the hash',async reason=>{
  const {db,queries}=fakeDb({protectedBy:{[reason]:true}});
  expect(await recordImageDisposition(db,{sourceUrl,sha256,kind:'render',classificationId:'screen-2',confirmed:true}))
   .toMatchObject({status:'protected',reasons:[reason]});
  expect(queries.some(([sql])=>sql.includes('UPDATE floor_plan.blob SET bytes_available=false'))).toBe(false);
  expect(queries.some(([sql])=>sql.includes('UPDATE floor_plan.target SET image_kind'))).toBe(false);
 });

 it('retains uncertain images and unconfirmed non-plan classifications',async()=>{
  const uncertain=fakeDb();
  expect(await recordImageDisposition(uncertain.db,{sourceUrl,sha256,kind:'uncertain',classificationId:'screen-3'}))
   .toMatchObject({status:'retained'});
  expect(uncertain.queries.some(([sql])=>sql.includes('UPDATE floor_plan.target SET image_kind'))).toBe(true);
  expect(uncertain.queries.some(([sql])=>sql.includes('UPDATE floor_plan.blob SET bytes_available=false'))).toBe(false);
  const unconfirmed=fakeDb();
  expect(await recordImageDisposition(unconfirmed.db,{sourceUrl,sha256,kind:'photo',classificationId:'screen-4'}))
   .toMatchObject({status:'needs_review'});
  expect(unconfirmed.queries.some(([sql])=>sql.includes('UPDATE floor_plan.target SET image_kind'))).toBe(false);
 });

 it('retains envelope evidence (exterior views, sections, site plans) with its own kind, even when confirmed',async()=>{
  const {db,queries}=fakeDb();
  expect(await recordImageDisposition(db,{sourceUrl,sha256,kind:'envelope',classificationId:'screen-env',confirmed:true,confidence:'high'}))
   .toMatchObject({status:'retained'});
  expect(queries.find(([sql])=>sql.includes('UPDATE floor_plan.target SET image_kind'))[1]).toEqual([sha256,'envelope']);
  expect(queries.some(([sql])=>sql.includes('UPDATE floor_plan.blob SET bytes_available=false'))).toBe(false);
  expect(NEGATIVE_IMAGE_CACHE_SQL).not.toContain('envelope');
 });

 it('does not apply a classification after the source URL moves to another hash',async()=>{
  const {db,queries}=fakeDb({urls:['https://other.example/same.jpg']});
  expect(await recordImageDisposition(db,{sourceUrl,sha256,kind:'photo',classificationId:'screen-5',confirmed:true}))
   .toMatchObject({status:'stale'});
  expect(queries.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
 });

 it('writes an explicitly refetched source to a file and restores only its database metadata',async()=>{
  const db={query:vi.fn(async()=>({rowCount:1,rows:[]}))};
  expect(await putBlob(db,bytes,'image/jpeg')).toBe(sha256);
  const [sql,params]=db.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.blob'));
  expect(typeof params[3]).toBe('string');
  expect(await readFile(sourceFilePath(params[3],sha256))).toEqual(bytes);
  expect(sql).toContain('ON CONFLICT(sha256) DO UPDATE SET');
  expect(sql).toContain('bytes_available=true');
  expect(sql).not.toMatch(/\bdata\b/);
  expect(sql).toContain('discarded_at=NULL,discard_reason=NULL');
 });

 it('returns an unavailable response for a tombstoned asset byte route',async()=>{
  const routes=new Map(),app={get:(path,handler)=>routes.set(path,handler)};
  const pool={query:vi.fn(async()=>({rows:[{media_type:'image/jpeg',bytes_available:false}]}))};
  setupFloorPlanArchiveRoute(app,pool);
  const response={set:vi.fn().mockReturnThis(),status:vi.fn().mockReturnThis(),json:vi.fn().mockReturnThis()};
  await routes.get('/floor-plan-archive/asset/:sha256')({params:{sha256}},response,vi.fn());
  expect(response.status).toHaveBeenCalledWith(410);
  expect(response.json).toHaveBeenCalledWith({error:'Source bytes were discarded after non-plan classification.'});
 });
});
