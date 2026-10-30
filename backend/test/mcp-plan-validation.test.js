// Distinguish authored plan geometry checks from unknown source and statutory assessments.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createMcpNamedPlanTools } from '../agents/mcp-named-plans.js';
import { createMcpValidationTools } from '../agents/mcp-validation.js';
import { createMcpComparison } from '../agents/mcp-compare.js';
import { buildTypedDesign } from '../agents/mcp-constructors.js';
import { appTurf as turf, intentDesign } from '../agents/mcp-geometry.js';
import { cidOfObject } from '../cid.js';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
const site = {type:'Polygon',coordinates:[[[15,45],[15.002,45],[15.002,45.002],[15,45.002],[15,45]]]};
const building = () => buildTypedDesign({kind:'building',typology:'freeform',site,floors:4,authoredAt:'2026-01-01T00:00:00.000Z'});
function fixture(designs, sources = []) {
    const rows = designs.map((content,index) => ({cid:cidOfObject(content),content,parcelSourceId:sources[index] || null}));
    const plan = PlanRecord.create('Review',rows.map(row=>row.cid),{at:'45.001,15.001,17',mode:'2d',city:null});
    const resolved = {cid:cidOfObject(plan),plan,designs:rows,publication:'private'};
    return {resolved,plans:{getPlan:vi.fn(async()=>resolved)}};
}
describe('named plan validation without cadastral reads',()=>{
    it('checks authored shape and metrics while keeping source claims unknown',async()=>{
        const design = building(), {resolved,plans}=fixture([design]);
        const read={request:vi.fn(),parcels:vi.fn()};
        const before=JSON.stringify(resolved);
        const result=await createMcpValidationTools({plans,read}).validatePlan({plan:resolved});
        expect(result).toMatchObject({cid:resolved.cid,valid:true,issues:[],sourceAssessment:{status:'unknown',reason:'not-queried'}});
        expect(result.metrics.floorAreaM2).toBeCloseTo(turf.area(design.geometry.buildings[0])*4);
        expect(read.request).not.toHaveBeenCalled();expect(read.parcels).not.toHaveBeenCalled();
        expect(JSON.stringify(resolved)).toBe(before);
    });
    it('reports exact immutable child references for overlap and outside-site geometry',async()=>{
        const first=building(),second=structuredClone(first);second.title='Second';
        second.site={type:'Polygon',coordinates:[[[15,45],[15.0001,45],[15.0001,45.0001],[15,45.0001],[15,45]]]};
        const {resolved,plans}=fixture([first,second]);
        const result=await createMcpValidationTools({plans}).validatePlan({plan:resolved});
        expect(result.valid).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({code:'building-outside-site',ref:`building:${cidOfObject(second)}:0`}),
            expect.objectContaining({code:'authored-building-overlap',ref:`building:${cidOfObject(first)}:0`,otherRef:`building:${cidOfObject(second)}:0`})
        ]));
    });
    it('reports refs from the new immutable revision after an actual named-plan edit', async()=>{
        const first=building(),second=structuredClone(first);second.title='Neighbour';
        const read={siteOfDesign:content=>content.site,request:vi.fn()};
        const drafts={resolveDesignSource:async input=>({content:input.content || input,parcelSourceId:input.parcelSourceId || null})};
        const plans=createMcpNamedPlanTools({read,drafts,appOrigin:'https://app.example'});
        // ugt_draft_plan refuses overlapping buildings now; a plan saved before that rule can hold them, and
        // validation still reports them.
        const content=PlanRecord.create('Review',[cidOfObject(first),cidOfObject(second)],{at:'45.001,15.001,17',mode:'2d',city:first.city||null});
        const original=await plans.resolvePlan({plan:content,designs:[{content:first,parcelSourceId:'source-a'},{content:second,parcelSourceId:'source-b'}]});
        const revised=await plans.editPlan({plan:original,expectedCid:original.cid,operations:[{type:'modify',ref:`design:${cidOfObject(first)}`,changes:[{type:'retitle',value:'Revised'}]}]});
        const result=await createMcpValidationTools({plans}).validatePlan({plan:revised});
        expect(result.cid).toBe(revised.cid);expect(result.cid).not.toBe(original.cid);
        const overlaps=result.issues.filter(issue=>issue.code==='authored-building-overlap');
        expect(overlaps).toHaveLength(1);
        expect([overlaps[0].ref,overlaps[0].otherRef].sort())
            .toEqual(revised.designs.map(row=>`building:${row.cid}:0`).sort());
        expect([overlaps[0].ref,overlaps[0].otherRef]).not.toContain(`building:${cidOfObject(first)}:0`);
        expect(Object.fromEntries(revised.designs.map(row=>[row.content.title,row.parcelSourceId]))).toEqual({Revised:'source-a',Neighbour:'source-b'});
        expect(read.request).not.toHaveBeenCalled();
    });
    it('reports a station attachment failure without claiming source verification',async()=>{
        const design=intentDesign.build({kind:'space',spaceKind:'square',site},{turf});design.goal='station';design.structureProposal.kind='station';design.structureProposal.stationType='bus';
        const {resolved,plans}=fixture([design]);
        const result=await createMcpValidationTools({plans}).validatePlan({plan:resolved});
        expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'station-attachment-missing',ref:`design:${cidOfObject(design)}`})]));
        expect(result.sourceAssessment.parcelCoverage).toBe('unknown');
    });
});
describe('named plan comparison',()=>{
    it('preserves per-member sources and leaves mixed-source ground and demolition unknown',async()=>{
        const first=building(),second=structuredClone(first);second.title='Second';
        const {resolved,plans}=fixture([first,second],['source-a','source-b']);
        const read={request:vi.fn(),parcels:vi.fn()};
        const compare=createMcpComparison({read,resolveDesign:async d=>d,plans,appOrigin:'https://app.example'});
        const result=await compare({targets:[resolved]});const alternative=result.alternatives[0];
        expect(alternative.floorAreaM2).toBeCloseTo(2*turf.area(first.geometry.buildings[0])*4);
        expect(alternative).toMatchObject({parcelsTaken:null,buildingsRemoved:null,buildingsCut:null,ledger:null,measurementErrors:[{code:'mixed-source-ground-unavailable'}]});
        expect(alternative.draftArtifact.designSources).toEqual({[cidOfObject(first)]:'source-a',[cidOfObject(second)]:'source-b'});
        expect(read.request).not.toHaveBeenCalled();
    });
    it('does not silently assign a known member source to another member with unknown provenance',async()=>{
        const first=building(),second=structuredClone(first);second.title='Unknown source';
        const {resolved,plans}=fixture([first,second],['source-a']);
        const read={request:vi.fn()};
        const result=await createMcpComparison({read,plans,resolveDesign:async d=>d,appOrigin:'https://app.example'})({targets:[resolved]});
        expect(result.alternatives[0]).toMatchObject({parcelsTaken:null,buildingsRemoved:null,measurementErrors:[{code:'parcel-source-required'}]});
        expect(read.request).not.toHaveBeenCalled();
    });
    it('routes a published plans link through the shared resolver and reports the plan preview',async()=>{
        const {resolved,plans}=fixture([building()],['source-a']);resolved.publication='published';
        const read={request:vi.fn(async()=>{throw Object.assign(new Error('Unavailable'),{code:'source-unavailable'});})};
        const compare=createMcpComparison({read,resolveDesign:async d=>d,plans,appOrigin:'https://app.example'});
        const link=`https://app.example/plans/${resolved.cid}`;
        const result=await compare({targets:[link]});
        expect(plans.getPlan).toHaveBeenCalledWith({plan:resolved.cid});
        expect(result.alternatives[0]).toMatchObject({cid:resolved.cid,previewUrl:link,previewStatus:'published',parcelsTaken:null});
    });
});
