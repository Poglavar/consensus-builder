// Check source ownership, location validity and floor/layout joins in the review catalogue.
import { describe, expect, it } from 'vitest';
import { buildingView, catalogueCounts, centroid, planViews, sourceView } from '../floor-plan-archive/review-catalogue.js';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {projectAt,trianglePositions,locationValid}=require('../../frontend/js/floor-plan-review-geometry.js');

describe('floor-plan review catalogue', () => {
 it('joins each floor to its own layout and keeps its floor-specific source page', () => {
  const plans={floors:[{id:'F3-floor-2',level:2,layoutId:'two',source:{url:'https://example.test/p.pdf',page:3}},{id:'F3-floor-3',level:3,layoutId:'three'}],layouts:[{id:'three',source:{url:'https://example.test/q.pdf'},architecture:{walls:['third']}},{id:'two',source:{url:'https://example.test/p.pdf',page:1},architecture:{walls:['second']}}]};
  const result=planViews(plans);
  expect(result[0]).toMatchObject({id:'F3-floor-2',label:'F3 · 2',architecture:{walls:['second']},source:{page:3}});
  expect(result[1]).toMatchObject({architecture:{walls:['third']},source:{url:'https://example.test/q.pdf'}});
 });
 it('names buildings from the processed floor prefix and keeps missing locations missing', () => {
  const row={id:3,owner_id:'pionir-borongajska-caviceva-location-permit-2022',building_id:'eDozvola_building_polygon.7187',floor_plans:{floors:[{id:'B3-floor-0',level:0}],layouts:[]}};
  expect(buildingView(row)).toMatchObject({id:'registered-3',name:'Borongajska – Čavićeva · B3',location:null});
  expect(centroid({type:'Polygon',coordinates:[[[null,null],[NaN,Infinity]]]})).toBeNull();
  expect(centroid({type:'Polygon',coordinates:[[[15,45],[16,45],[16,46],[15,46],[15,45]]]})).toEqual({longitude:15.5,latitude:45.5});
 });
 it('shows readable source filenames without fabricating a building association', () => {
  const source=sourceView({sha256:'a'.repeat(64),status:'needs_review',media_type:'application/pdf; charset=binary',source_url:'https://example.test/plans/B1%20floor.pdf'});
  expect(source).toMatchObject({label:'plans / B1 floor.pdf · example.test',mediaType:'application/pdf',status:'needs_review'});
  expect(source).not.toHaveProperty('building');
  expect(catalogueCounts([{planCount:2}],[{architectureAvailable:true},{architectureAvailable:false}])).toEqual({buildings:1,sources:2,plans:2,architecture:1});
 });
 it('projects exterior triangles in metres and subtracts the supplied ground datum', () => {
  const project=projectAt({longitude:16,latitude:45});
  const positions=trianglePositions({type:'MultiPolygon',coordinates:[[[[16,45,114],[16.001,45,115],[16,45.001,117],[16,45,114]]]]},project,114);
  expect(positions).toHaveLength(9);expect(positions.slice(0,3)).toEqual([0,0,0]);
  expect(positions[3]).toBeCloseTo(78.715,2);expect(positions[5]).toBe(1);expect(positions[7]).toBeCloseTo(111.32);expect(positions[8]).toBe(3);
  expect(locationValid({longitude:null,latitude:0})).toBe(false);
  expect(()=>trianglePositions({type:'Polygon',coordinates:[[[16,45,114],[16.001,45,115],[16,45.001,117],[16.001,45.001,117]]]},project,114)).toThrow('triangulated');
 });
});
