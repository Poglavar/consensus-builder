// Plan links name an immutable plan CID; opening one restores its captured map view.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),NamedPlans=require('../../frontend/js/named-plans.js');
const MapShare=require('../../frontend/js/map-share.js');
describe('saved plan map links',()=>{
 it('links the plan identity and restores its saved location and city',()=>{
  const cid='bafkrei'+'a'.repeat(52),view={at:'45.8,15.96,17',mode:'2d',city:'zagreb',language:'en'};
  const link=NamedPlans.browser({location:new URL('https://app.example/?backend=https%3A%2F%2Fapi.example'),resolveFrontendBaseUrl:()=> 'https://app.example'}).link(cid);
  expect(link).toContain(`/plans/${cid}`);expect(new URL(link).searchParams.get('backend')).toBe('https://api.example');
  const restored=NamedPlans.restoreUrl(link,view,MapShare);
  expect(restored).toContain(`city=zagreb`);expect(restored).toContain(`at=${encodeURIComponent(view.at)}`);
 });
 it('keeps explicit map location and mode overrides ahead of the saved view',()=>{
  const cid='bafkrei'+'b'.repeat(52),view={at:'45.8,15.96,17',mode:'photo',city:'zagreb',language:'hr'};
  const restored=NamedPlans.restoreUrl(`https://app.example/plans/${cid}?at=1,2,16&3d`,view,MapShare),url=new URL(restored);
  expect(url.searchParams.get('at')).toBe('1,2,16');expect(url.searchParams.has('3d')).toBe(true);expect(url.searchParams.get('city')).toBe('zagreb');
 });
});
