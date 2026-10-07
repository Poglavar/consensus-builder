// Legal-identity matching uses visible evidence; candidate URLs are not licenses.
import { describe,it,expect,vi } from 'vitest';
import { agencyIdentityEvidence,verifySiteFromPage } from '../floor-plans/agency-sites.js';
describe('agency identity evidence',()=>{
 it('reads split HTML labels and ignores scripted identifiers',()=>{
  const result=agencyIdentityEvidence('<body>Example d.o.o. <b>OIB:</b> <span>12345678901</span><script>OIB: 99999999999</script></body>');
  expect(result.matches.map(m=>m.oib)).toEqual(['12345678901']);
 });
 it('links an adjacent short company name and exact OIB without requiring a marketing suffix',async()=>{
  const db={query:vi.fn(async sql=>({rows:sql.startsWith('SELECT registry_id')?[{registry_id:'42',legal_name:'EXAMPLE AGENCY d.o.o. za poslovanje nekretninama',oib:'12345678901'}]:[]}))};
  const result=await verifySiteFromPage(db,{kind:'home',url:'https://agency.test/'},'<body>Example Agency d.o.o. OIB: 12345678901</body>','https://agency.test/');
  expect(result.registry_id).toBe('42');expect(result.status).toBe('verified_oib');
  expect(db.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE floor_plan.agency'))).toBe(true);
 });
 it('does not link a tax number with no corresponding company identity',async()=>{
  const db={query:vi.fn(async()=>({rows:[{registry_id:'42',legal_name:'EXAMPLE AGENCY d.o.o.',oib:'12345678901'}]}))};
  expect(await verifySiteFromPage(db,{kind:'home',url:'https://agency.test/'},'<body>Another provider OIB: 12345678901</body>')).toBeNull();
  expect(db.query).toHaveBeenCalledTimes(1);
 });
});
