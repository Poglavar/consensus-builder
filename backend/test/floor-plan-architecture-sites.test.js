import {describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {importArchitectureSites} from '../floor-plans/architecture-sites.js';
import {seedKnownSites} from '../floor-plans/agency-sites.js';

const row={id:'test-studio',name:'Test Studio',registered_address:'Ilica 12, Zagreb',
 registry_evidence_url:'https://www.arhitekti-hka.hr/hr/imenik/imenik-ovlastenih-arhitekata/?poc=T',
 website:'https://studio.test/',website_evidence_url:'https://studio.test/contact/',
 verification_basis:'The official website company name and seat match the HKA employer entry.',
 seed_project_urls:['https://studio.test/project/one/']};
const db=()=>({query:vi.fn(async()=>({rows:[],rowCount:1}))});

describe('architecture studio source import',()=>{
 it('keeps HKA company provenance and seeds the portfolio parser on the shared queue',async()=>{
  const client=db();
  expect(await importArchitectureSites(client,{records:[row],scope_complete:false,observedAt:'2026-10-11'}))
   .toEqual({studios:1,sites:1,queued:3,scopeComplete:false});
  const site=client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.site'));
  expect(JSON.parse(site[1][3])).toMatchObject({sourceKind:'architecture',studioId:'test-studio',registryEvidenceUrl:row.registry_evidence_url,scopeComplete:false});
  const targets=client.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO floor_plan.target'));
  expect(targets.map(([,args])=>[args[0],args[2],args[6]])).toEqual([
   ['https://studio.test/','home','architecture'],['https://studio.test/sitemap.xml','sitemap','architecture'],
   ['https://studio.test/project/one/','page','architecture']]);
  expect(targets.every(([sql])=>sql.includes('floor_plan.exclusion'))).toBe(true);
 });
 it.each([
  {registry_evidence_url:'https://directory.test/studio'},
  {website_evidence_url:'https://unrelated.test/studio'},
  {verification_basis:''},
 ])('rejects an unsupported website identity before writing anything: %j',async change=>{
  const client=db();
  await expect(importArchitectureSites(client,{records:[{...row,...change}]})).rejects.toThrow('official registry source');
  expect(client.query).not.toHaveBeenCalled();
 });
 it('accepts the official ministry consent list with its distinct provenance',async()=>{
  const client=db();
  const registry='https://mpgi.gov.hr/UserDocsImages/dokumenti/Prostorno/Popisi/Popis_SP_UPU_20_03_2026.pdf';
  expect((await importArchitectureSites(client,{records:[{...row,registry_evidence_url:registry}]})).studios).toBe(1);
  const site=client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.site'));
  expect(JSON.parse(site[1][3])).toMatchObject({authority:'MPGI spatial-planning consent list',registryEvidenceUrl:registry});
 });
 it('rejects an unrelated ministry page as proof of studio registration',async()=>{
  const client=db();
  await expect(importArchitectureSites(client,{records:[{...row,registry_evidence_url:'https://mpgi.gov.hr/'}]}))
   .rejects.toThrow('published spatial-planning consent list');
  expect(client.query).not.toHaveBeenCalled();
 });
 it('validates the whole studio document before importing a partial roster',async()=>{
  const client=db();
  await expect(importArchitectureSites(client,{records:[row,{...row,id:'bad-studio',
   seed_project_urls:['https://unrelated.test/project/one/']}]})).rejects.toThrow('verified website');
  expect(client.query).not.toHaveBeenCalled();
 });
 it('keeps architecture type on later periodic homepage and sitemap checks',async()=>{
  const client={query:vi.fn(async sql=>sql.startsWith('SELECT url,agency_id')?{rows:[{url:row.website,agency_id:null,source_kind:'architecture'}]}:{rows:[],rowCount:1})};
  expect(await seedKnownSites(client)).toEqual({sites:1});
  const writes=client.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO floor_plan.target'));
  expect(writes).toHaveLength(2);
  expect(writes.every(([sql,args])=>args[2]==='architecture'&&sql.includes('WHERE t.exclusion_reason IS NULL'))).toBe(true);
 });
 it('ships a distinct, explicitly partial studio seed set with independent website evidence',async()=>{
  const document=JSON.parse(await readFile(new URL('../floor-plans/architecture-studios.json',import.meta.url),'utf8'));
  expect(document.scope_complete).toBe(false);
  expect(document.records.length).toBeGreaterThan(0);
  expect(new Set(document.records.map(row=>row.id)).size).toBe(document.records.length);
  expect(new Set(document.records.map(row=>row.website)).size).toBe(document.records.length);
  expect((await importArchitectureSites(db(),document)).studios).toBe(document.records.length);
 });
});
