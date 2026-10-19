import { describe,it,expect,vi } from 'vitest';
import { isHtmlPageResponse } from '../floor-plans/html-response.js';
import { saveObservation } from '../floor-plans/archive.js';
import { readFile } from 'node:fs/promises';
import { sourceFilePath } from '../floor-plans/blob-store.js';
import { useTestArchive } from './helpers/floor-plan-file-store.js';

useTestArchive();

const response=(body,type='text/plain')=>({headers:{contentType:type},body:Buffer.from(body),status:200});
describe('public portfolio HTML responses',()=>{
 it('recognizes text/plain HTML fragments while leaving plain data outside the HTML parser',()=>{
  expect(isHtmlPageResponse(response('<!-- project --><table><tr><td>Location</td></tr></table>'))).toBe(true);
  expect(isHtmlPageResponse(response('Location: Ilica 12, Zagreb'))).toBe(false);
  expect(isHtmlPageResponse(response('<div>inline HTML inside a data response</div>','application/json'))).toBe(false);
  expect(isHtmlPageResponse(response('<html><body>Page</body></html>','text/html; charset=utf-8'))).toBe(true);
 });
 it('excludes an addressless text/plain project fragment before storing any raw bytes',async()=>{
  const url='https://www.njiric.com/Handlers/Project.ashx?id=p143';
  const db={query:vi.fn(async()=>({rows:[{excluded:false}],rowCount:1}))};
  const fragment=response('<table><tr><td class="tdTekst"><div class="tekst"><p>location: Zadar, Zlatarska ulica</p></div></td></tr></table>');
  const result=await saveObservation(db,{url,kind:'page',source_kind:'architecture'},
   {...fragment,finalUrl:url},{listing:null,links:[],assets:[]},null);
  expect(result.excluded).toBe(true);
  expect(result.evidence.listing.sourceType).toBe('architecture-project');
  expect(db.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO floor_plan.exclusion'))).toBe(true);
  expect(db.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO floor_plan.blob'))).toBe(false);
 });
 it('stores an address-qualified text/plain project as HTML for later policy audits',async()=>{
  const url='https://www.njiric.com/Handlers/Project.ashx?id=p143';
  const db={query:vi.fn(async()=>({rows:[{excluded:false}],rowCount:1}))};
  const fragment=response('<div id="project_143_divSadrzajZaSkrivanje" class="tekst"><table><tr><td id="project_143_tdTekst"><a class="projectlinkclose" name="p143">Project</a><br>location: Ilica 12, Zagreb</td></tr></table></div>');
  const result=await saveObservation(db,{url,kind:'page',source_kind:'architecture'},
   {...fragment,finalUrl:url},{listing:null,links:[],assets:[]},null);
  expect(result.excluded).not.toBe(true);
  expect(result.evidence.listing.explicitLocation.address).toBe('Ilica 12');
  const blob=db.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.blob'));
  expect(blob[1][1]).toBe('text/html');
  expect(await readFile(sourceFilePath(blob[1][3],result.hash))).toEqual(fragment.body);
  expect(blob[1].some(Buffer.isBuffer)).toBe(false);
 });
});
