// Housing policy regression: no street parcels, invented legal claims, rent defaults or ownership transfer.
import {describe,it,expect} from 'vitest';
import * as turf from '@turf/turf';
import {planHousingCandidates,housingPick,housingOutreach,chooseHousingArea} from '../agents/housing-policy.js';
import {housingFeatures,screenHousingParcels} from '../agents/housing-screen.js';
import {selectAlgorithmicPicks} from '../agents/algorithmic-picker.js';
import {buildProposalRecord} from '../agents/record-builder.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), chainRecord=require('../../frontend/js/proposals/chain-record.js');
const area={city:'test',label:'Test City',medianMultiple:14.1,rankingUrl:'https://example.org/report',authority:{name:'Planning',url:'https://example.org/planning',email:'planning@example.org'}};
const ground=turf.bboxPolygon([0,0,.001,.001]);
const parcel={parcelId:'test-1',geometry:ground.geometry,areaM2:turf.area(ground),housingArea:area,housingScreen:{complete:true,excluded:false,transitDistanceM:300}};
const persona={name:'affordabot',housingResearch:true,dailyProposals:1};
const planned=()=>planHousingCandidates([parcel],persona,{turf})[0];
describe('Affordabot housing research',()=>{
 it('measures the actual courtyard and keeps its hole inside the parcel',()=>{
   const c=planned(); expect(c.housing.form).toBe('courtyard');expect(c.massing.geometry.coordinates.length).toBe(2);
   expect(c.proposedGfaM2).toBeCloseTo(turf.area(c.massing)*6,4);
   expect(turf.difference(c.massing,ground)).toBeNull();
   expect(c.housing.homes).toBe(Math.floor(c.proposedGfaM2*.8/50));
 });
 it.each([{complete:false},{excluded:true},{transitDistanceM:null},{transitDistanceM:801}])('refuses absent screening or distant transit: %j',patch=>{
   expect(planHousingCandidates([{...parcel,housingScreen:{...parcel.housingScreen,...patch}}],persona,{turf})).toEqual([]);
 });
 it('excludes a street parcel using the mapped corridor even with no buildings',()=>{
   const road=turf.lineString([[-.001,.0005],[.002,.0005]],{screen:'corridor'});
   const screened=screenHousingParcels([parcel],{features:[road]},{turf,area});
   expect(screened[0].housingScreen.excluded).toBe(true);expect(planHousingCandidates(screened,persona,{turf})).toEqual([]);
 });
 it('keeps off-street lots when a sidewalk merely touches the boundary',()=>{
   const sidewalk=turf.lineString([[-.001,0],[.002,0]],{screen:'corridor',highway_type:'footway',width_meters:1});
   expect(screenHousingParcels([parcel],{features:[sidewalk]},{turf,area})[0].housingScreen.excluded).toBe(false);
 });
 it('does not mistake a parking aisle for a public street parcel',()=>{
   const aisle=turf.lineString([[-.001,.0005],[.002,.0005]],{screen:'corridor',tags:{service:'parking_aisle'}});
   expect(screenHousingParcels([parcel],{features:[aisle]},{turf,area})[0].housingScreen.excluded).toBe(false);
 });
 it('fails closed on partial and truncated replies, including HTTP-200 Overpass errors',()=>{
   expect(()=>screenHousingParcels([parcel],{features:[],partial:true},{turf,area})).toThrow();
   expect(()=>screenHousingParcels([parcel],{features:[],truncated:true},{turf,area})).toThrow();
   expect(()=>housingFeatures([],100,{remark:'runtime timeout'})).toThrow();
   expect(()=>housingFeatures(undefined)).toThrow();
 });
 it('rejects tagged point buildings and public uses conservatively',()=>{
   const e=housingFeatures([{type:'node',id:1,lon:.0005,lat:.0005,tags:{building:'yes'}}]);
   expect(screenHousingParcels([parcel],e,{turf,area})[0].housingScreen.excluded).toBe(true);
 });
 it('rejects building and sensitive/public-use overlap',()=>{
   for(const screen of ['building','protected']) expect(screenHousingParcels([parcel],{features:[{...ground,properties:{screen}}]},{turf,area})[0].housingScreen.excluded).toBe(true);
 });
 it('skips distant obstacles before buffering without hiding nearby corridors',()=>{
   const far=turf.lineString([[10,10],[10.001,10.001]],{screen:'corridor'});
   const screened=screenHousingParcels([parcel],{features:[far]},{turf,area});
   expect(screened[0].housingScreen.excluded).toBe(false);
 });
 it('converts mapped stops and roads with unique identities',()=>{
   const data=housingFeatures([{type:'node',id:1,lat:0,lon:0,tags:{highway:'bus_stop'}},{type:'way',id:2,tags:{highway:'residential'},geometry:[{lat:0,lon:0},{lat:0,lon:.001}]}]);
   expect(new Set(data.features.map(f=>f.id)).size).toBe(data.features.length);
   expect(data.features.map(f=>f.properties.screen)).toEqual(['corridor','transit']);
 });
 it('picks a research proposal without a fabricated land-value gain',()=>{
   const c=planned(), result=selectAlgorithmicPicks({day:'2026-10-20',persona,candidates:[c]});
   expect(result.picks).toHaveLength(1);expect(c.gainEur).toBe(0);
   expect(result.picks[0].rationale).toContain('not permitted zoning limits');expect(result.picks[0].rationale).toContain('No local rent');
 });
 it('persists evidence under agent metadata with neutral ownership',()=>{
   const c=planned(),pick={...housingPick(c),proposalId:'test-proposal'};
   const r=buildProposalRecord({candidate:c,pick,persona,runId:'test',city:'test',turf});
   expect(r.facets.ownership).toBe('no-change');expect(r.offer).toBe(0);expect(r.agent.housing.rent).toBeNull();
   expect(r.agent.housing.requiredZoningChanges).toBeNull();expect(r.geometry.buildings[0].geometry.coordinates).toHaveLength(2);
 });
 it('queues published proposals with official role contacts and disabled X automation',()=>{
   const q=housingOutreach({candidate:planned(),post:{proposalId:'chain_123',id:5},publicBase:'https://example.org'});
   expect(q.status).toBe('pending-review');expect(q.authority.email).toBe('planning@example.org');expect(q.x.status).toBe('disabled');
   expect(q.proposalUrl).toBe('https://example.org/proposals/5?city=test');expect(q.body).toContain(q.proposalUrl);expect(()=>housingOutreach({candidate:planned(),post:{},publicBase:'http://localhost'})).toThrow();
 });
 it('rotates all enabled cities deterministically with additional turns for the least affordable',()=>{
   const areas=Array.from({length:6},(_,i)=>({...area,city:String(i),medianMultiple:14-i}));
   const visits=Array.from({length:8},(_,i)=>chooseHousingArea(areas,`2026-10-${String(20+i).padStart(2,'0')}`).city);
   expect(new Set(visits).size).toBe(6);expect(visits.filter(x=>x==='0')).toHaveLength(2);
 });
});
