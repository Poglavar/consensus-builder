// Review gates and local metre geometry are independent of map registration.
import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { validateUnitModel } from '../floor-plans/unit-models.js';
const require=createRequire(import.meta.url);
const geometry=require('../../frontend/js/building-floor-plans.js');
const manifest=JSON.parse(readFileSync(new URL('../../rekonstrukcije/avenue-v/unit-models.json',import.meta.url)));
describe('Avenue V unit model review gates',()=>{
 it('retains five distinct source-backed models without inventing whole-floor coverage',()=>{
  expect(new Set(manifest.units.map(x=>x.source.sha256)).size).toBe(5);
  expect(manifest.coverage).toMatchObject({knownUnits:5,reportedTotalUnits:74,wholeFloors:0});
  for(const unit of manifest.units)expect(validateUnitModel(unit)).toBe(unit);
  const conflicted=manifest.units.find(x=>x.unitId==='B-5-6');
  expect(conflicted.floor).toBeNull();expect(conflicted.status).toBe('needs_review');
 });
 it('cannot accept an invalid wall or an unreviewed source conflict',()=>{
  const unit=structuredClone(manifest.units[0]);unit.architecture.walls[0][0][0]=[-1,0];
  expect(()=>validateUnitModel(unit)).toThrow();
  const conflict=structuredClone(manifest.units.find(x=>x.sourceFloorConflict));conflict.status='reviewed-local-geometry';
  expect(()=>validateUnitModel(conflict)).toThrow(/conflict/);
 });
 it('constructs local parts in metres while retaining doors and windows',()=>{
  for(const unit of manifest.units){
   const parts=geometry.buildLocalUnitParts(unit.architecture),[width,depth]=unit.architecture.dimensionsM;
   expect(parts.some(p=>p.kind==='wall')).toBe(true);expect(parts.some(p=>p.kind==='glass')).toBe(true);expect(parts.some(p=>p.kind==='door')).toBe(true);
   const points=parts.filter(p=>p.kind==='slab').flatMap(p=>p.rings.flat());
   expect(Math.max(...points.map(p=>p[0]))).toBeCloseTo(width,2);
   expect(Math.max(...points.map(p=>p[1]))).toBeCloseTo(depth,2);
  }
 });
});
