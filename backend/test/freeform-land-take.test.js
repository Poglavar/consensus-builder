import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const land = require('../../frontend/js/freeform-land-take.js');
const { splitDemolitionFootprint } = require('../../frontend/js/corridor-tunnel.js');
const { footprintParts } = require('../../frontend/js/proposals/footprint-parts.js');
const { buildingDemolitionGeometry, demolitionRegionOf } = require('../../frontend/js/proposals/demolition-prefetch.js');
const rect = (x, y, w, h, id = '') => turf.polygon([[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]], { parcelId: id });
const A = rect(0,0,.002,.002,'A'), B = rect(.002,0,.002,.002,'B');
const body = rect(.001,.0005,.002,.001);
const plan = (args = {}) => land.plan({ buildings:[body], parcels:[A,B], turf, ...args });
const sameArea = (a,b) => expect(turf.area(a)).toBeCloseTo(turf.area(b), 4);
describe('Freeform reviewed land take', () => {
 it('defaults to the exact footprint and ignores shared edges', () => {
  const p = plan({ parcels:[A,B,rect(.003,.0005,.001,.001,'edge')] });
  expect(p.rows.map(r=>r.id)).toEqual(['A','B']);
  expect(p.rows.every(r=>r.mode==='footprint')).toBe(true);
  sameArea(p.take,body);
 });
 it('mixes whole parcels with footprint cuts and conserves the remainder', () => {
  const before=JSON.stringify(body), first=plan();
  const p=plan({whole:new Set([first.rows[0].key])});
  sameArea(p.take,turf.union(A,body));
  expect(p.rows[0].remainder).toBeNull();
  sameArea(turf.union(p.rows[1].take,p.rows[1].remainder),B);
  expect(JSON.stringify(body)).toBe(before);
 });
 it('lets a narrow tower take several whole parcels', () => {
  const first=plan(), p=plan({whole:new Set(first.rows.map(r=>r.key))});
  sameArea(p.take,turf.union(A,B));
  expect(land.contains(p.take,[body],turf)).toBe(true);
 });
 it('keeps chosen whole ground after a building moves away, until the footprint-only choice clears it', () => {
  const first=plan(), whole=new Set([first.rows[0].key]);
  const moved=rect(.005,.0005,.001,.001);
  const retained=plan({buildings:[moved],whole});
  expect(retained.rows.map(row=>[row.id,row.mode,row.overlapM2])).toEqual([['A','whole',0]]);
  sameArea(retained.take,turf.union(A,moved));
  const footprintOnly=plan({buildings:[moved],whole:new Set()});
  sameArea(footprintOnly.take,moved);
  expect(footprintOnly.rows).toHaveLength(0);
 });
 it('recovers mixed choices from saved geometry without durable live IDs', () => {
  const savedTake=turf.union(A,body), p=plan({savedTake});
  expect(p.rows.map(r=>r.mode)).toEqual(['whole','footprint']);
  sameArea(p.take,savedTake);
 });
 it('does not transfer a whole choice to changed geometry sharing the same ID', () => {
  const p=plan({parcels:[rect(0,0,.0015,.002,'A')],whole:new Set([plan().rows[0].key])});
  expect(p.rows[0].mode).toBe('footprint');
 });
 it('preserves courtyard holes and takes only the footprint on open ground', () => {
  const courtyard=turf.polygon([A.geometry.coordinates[0],rect(.0004,.0004,.0002,.0002).geometry.coordinates[0]]);
  const p=plan({buildings:[courtyard],parcels:[]});
  expect(p.take.geometry.coordinates).toEqual(courtyard.geometry.coordinates);
  expect(land.contains(courtyard,[rect(.00045,.00045,.0001,.0001)],turf)).toBe(false);
 });
 it('uses the reviewed take for binding, demolition prefetch and replay', () => {
  const take=turf.union(A,body), proposal={goal:'single',geometry:{buildings:[body],landTake:take},buildingProposal:{}};
  expect(footprintParts(proposal).sources).toContain('geometry.landTake');
  expect(buildingDemolitionGeometry(proposal,[A,B])).toEqual(take.geometry);
  expect(demolitionRegionOf(proposal)).toEqual(take.geometry);
 });
 it('previews full removals, partial cuts and retained buildings using the actual demolition rules', () => {
  const removed=rect(.0001,.0001,.0001,.0001), partial=rect(.0019,.0001,.0002,.0002), retained=rect(.003,.0001,.0001,.0001);
  const p=land.demolitionPreview(A,[removed,partial,retained],splitDemolitionFootprint,turf);
  expect(p.removed).toEqual([removed]); expect(p.partial).toHaveLength(1);
  expect(p.partial[0].remainder).toBeTruthy(); expect(p.retained).toEqual([retained]);
 });
});

describe('land-take source completeness', () => {
 const { loadBuildingStock } = require('../../frontend/js/proposals/demolition-prefetch.js');
 it('accepts an authoritative empty answer', async () => {
  await expect(loadBuildingStock(A.geometry, async()=>({supported:true,truncated:false,regions:{'land-take':[]}}))).resolves.toEqual([]);
 });
 it('refuses truncated, unsupported and missing answers instead of treating them as empty', async () => {
  for(const payload of [{supported:true,truncated:true,regions:{'land-take':[]}}, {supported:false,regions:{'land-take':[]}}, {supported:true,regions:{}}]) {
   await expect(loadBuildingStock(A.geometry,async()=>payload)).rejects.toThrow(/incomplete/);
  }
 });
 it('preserves source identity alongside building geometry', async () => {
  const [building]=await loadBuildingStock(A.geometry,async()=>({supported:true,source:'survey',regions:{'land-take':[{id:'one',geometry:A.geometry}]}}));
  expect(building.properties).toMatchObject({id:'one',source:'survey'});
 });
});
