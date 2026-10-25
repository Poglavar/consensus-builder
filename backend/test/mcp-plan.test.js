import { describe, expect, it } from 'vitest';
import { appTurf as turf } from '../agents/mcp-geometry.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { createTestPreviewLinks as createPreviewLinks } from './helpers/mcp-preview-store.js';
import { cidOfObject } from '../cid.js';
import { validateAgreementContent } from '../routes/agreements.js';
const box=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
const site=box(-.1,51.5,-.098,51.502), paths=[];
const consultation={organiser:'did:web:community.example',participationUrl:'https://community.example/participate'};
async function fixture() {
    paths.length=0;
    const store=createPreviewLinks({origin:'https://mcp.example',appOrigin:'https://app.example'});
    const tools=createUrbanGameTheoryTools({mode:'hosted',env:{UGT_APP_ORIGIN:'https://app.example'},resolveDraftReference:store.resolve,fetchImpl:async(url)=>{
        const path=new URL(url).pathname;paths.push(path);
        if(path==='/designs/binding')return Response.json({parcelSourceId:'plan-test',binding:{coverage:'complete',parcels:[{parcelId:'A'}],unsurveyedM2:0,unknownM2:0}});
        if(path==='/parcel-sources/plan-test')return Response.json({complete:true,features:[{type:'Feature',id:'A',properties:{parcelId:'A'},geometry:site}]});
        throw new Error(`Unexpected publication or data read: ${path}`);
    }});
    const common={city:'london',parcelSourceId:'plan-test'};
    const tower=await tools.draftBuilding({...common,title:'Eastern tower',outline:box(-.0989,51.5012,-.0981,51.5019),floors:12,coverage:.2});
    const lake=await tools.draftSpace({...common,title:'Lake',outline:box(-.0998,51.5001,-.0992,51.5007),spaceKind:'lake'});
    const park=await tools.draftSpace({...common,title:'Park',outline:box(-.0998,51.5012,-.0992,51.5019),spaceKind:'park',treeCount:5});
    const road=await tools.draftRoad({...common,title:'Central road',points:[[-.0999,51.501],[-.0981,51.501]],preset:'1+1'});
    const plan=store.decorate(await tools.draftAgreement({currency:'GBP',designs:[tower.design,lake.design,park.design,road.design],title:'Test plan',consultation,...common}));
    return {tools,store,plan,tower,lake,park,road,common};
}
describe('granular plan revisions',()=>{
    it('inventories exact building paths and selects land north of a referenced road',async()=>{
        const {tools,plan,road,tower}=await fixture();
        const inspected=await tools.inspectAgreement({plan:plan.draftRef,filter:{kind:'building'}});
        expect(inspected.cid).toBe(plan.cid);
        expect(inspected.items).toMatchObject([{designCid:tower.cid,path:'/geometry/buildings/0',floors:12,heightM:36}]);
        const north=await tools.inspectAgreement({plan:plan.draftRef,filter:{kind:'piece',relativeTo:{ref:`design:${road.cid}`,direction:'north'}},includeGeometry:true});
        expect(north.items.length).toBeGreaterThan(0);expect(north.items.every(p=>p.bbox[1]>51.501)).toBe(true);
        const beyondPiece=await tools.inspectAgreement({plan:plan.draftRef,filter:{kind:'building',relativeTo:{ref:north.items[0].ref,direction:'east'}}});
        expect(beyondPiece.items.every(item=>item.kind==='building'&&item.bbox[0]>north.items[0].bbox[2])).toBe(true);
        const slice=await tools.inspectAgreement({plan:plan.draftRef,limit:1});expect(slice.truncated).toBe(true);expect(slice.total).toBeGreaterThan(1);
    });
    it('lowers and rotates one building, removes a lake, and adds trees in one private revision',async()=>{
        const {tools,store,plan,tower,lake,park}=await fixture();
        const next=store.decorate(await tools.editAgreement({plan:plan.draftRef,expectedCid:plan.cid,operations:[
            {type:'modify',ref:`building:${tower.cid}:0`,changes:[{type:'set_floors',value:6},{type:'rotate',degrees:-15}]},
            {type:'remove',ref:`design:${lake.cid}`},
            {type:'modify',ref:`design:${park.cid}`,changes:[{type:'add_trees',count:20}]}
        ]}));
        expect(next.previousCid).toBe(plan.cid);expect(next.cid).not.toBe(plan.cid);expect(next.plan.content.designCids).toHaveLength(3);
        expect(next.designs.find(d=>d.content.buildingProposal).content.geometry.buildings[0].properties).toMatchObject({floors:6,height:18});
        expect(next.designs.find(d=>d.content.goal==='park').content.structureProposal.decorationDesign.trees).toHaveLength(25);
        expect(next.plan.content.designCids).not.toContain(lake.cid);expect(validateAgreementContent(next.agreement).ok).toBe(true);
        expect(next.agreement.consultation).toEqual(consultation);
        expect(next.agreement.outputs.reduce((sum,p)=>sum+p.areaM2,0)).toBeCloseTo(turf.area(turf.feature(site)),1);
        const original=await tools.inspectAgreement({plan:plan.draftRef,filter:{kind:'design'}});expect(original.items).toHaveLength(4);
        expect(paths.some(p=>p==='/pins'||p==='/agreements'||p==='/designs')).toBe(false);
        const artifact=await store.resolve(next.draftRef);expect(artifact.agreement).toEqual(next.agreement);
    });
    it('composes row-house changes from inspection, drafting and replace/add primitives',async()=>{
        const {tools,plan,tower,lake,common}=await fixture();
        const row=await tools.draftUrbanRule({...common,outline:tower.design.site,title:'Three-storey terrace',rule:{typology:'row',floors:3}});
        const smallPark=await tools.draftSpace({...common,outline:lake.design.site,spaceKind:'park',treeCount:8});
        const next=await tools.editAgreement({plan,expectedCid:plan.cid,operations:[{type:'replace',ref:`design:${tower.cid}`,design:row.design},{type:'remove',ref:`design:${lake.cid}`},{type:'add',design:smallPark.design}]});
        expect(next.plan.content.designCids).toEqual(next.designs.map(d => d.cid).sort());
        expect(next.plan.content.designCids).toEqual(expect.arrayContaining([row.cid, smallPark.cid]));
        expect(row.design.geometry.buildings[0].properties).toMatchObject({height:9,floors:3});
        expect(next.agreement.outputs.reduce((sum,p)=>sum+p.areaM2,0)).toBeCloseTo(turf.area(turf.feature(site)),1);
    });
    it('inspects exact private values and applies generic property edits inside a plan',async()=>{
        const {tools,plan,park}=await fixture();
        const read=await tools.inspectDesign({design:park.design,paths:['/structureProposal/decorationDesign/trees/0']});
        expect(read.values[0].untrustedValue).toEqual(park.design.structureProposal.decorationDesign.trees[0]);
        const next=await tools.editAgreement({plan,expectedCid:plan.cid,operations:[{type:'edit',ref:`design:${park.cid}`,edits:[
            {op:'replace',path:'/title',value:'Garden'}, {op:'replace',path:'/structureProposal/decorationDesign/trees/0/kind',value:'conifer'}
        ]}]});
        expect(next.designs.find(d=>d.content.title==='Garden').content.structureProposal.decorationDesign.trees[0].kind).toBe('conifer');
    });
    it('rejects stale selection and invalid late edits without altering the original draft',async()=>{
        const {tools,plan,tower,park}=await fixture();
        await expect(tools.editAgreement({plan,expectedCid:tower.cid,operations:[{type:'remove',ref:`design:${park.cid}`}]})).rejects.toMatchObject({code:'plan-revision-mismatch'});
        await expect(tools.editAgreement({plan,expectedCid:plan.cid,operations:[{type:'remove',ref:`design:${park.cid}`},{type:'remove',ref:'design:unknown'}]})).rejects.toMatchObject({code:'selection-not-found'});
        expect((await tools.inspectAgreement({plan,filter:{kind:'design'}})).items).toHaveLength(4);
    });
    it('rejects old child refs after replacement and explains derived land-piece edits',async()=>{
        const {tools,plan,tower,common}=await fixture();
        const row=await tools.draftUrbanRule({...common,outline:tower.design.site,rule:{typology:'row',floors:3}});
        await expect(tools.editAgreement({plan,expectedCid:plan.cid,operations:[{type:'replace',ref:`design:${tower.cid}`,design:row.design},
            {type:'modify',ref:`building:${tower.cid}:0`,changes:[{type:'set_floors',value:2}]}]})).rejects.toMatchObject({code:'selection-changed'});
        await expect(tools.editAgreement({plan,expectedCid:plan.cid,operations:[{type:'remove',ref:`piece:${plan.agreement.outputs[0].hash}`}]})).rejects.toMatchObject({code:'piece-operation-invalid'});
    });
    it('labels carried holders as unverified and accepts an explicit replacement snapshot',async()=>{
        const {tools,plan}=await fixture();
        const held=structuredClone(plan); delete held.cid;delete held.draftRef;
        held.agreement.inputs.parcels[0].holders=[{ownerKey:'party-a',displayName:'Party A',share:1}];
        const next=await tools.editAgreement({plan:held,expectedCid:cidOfObject(held.agreement),terms:{title:'Same ground revision'}});
        expect(next.agreement.inputs.parcels[0].holders).toEqual(held.agreement.inputs.parcels[0].holders);
        expect(next.rightsStatus).toBe('carried-unverified');expect(next.warnings.join(' ')).toMatch(/without refreshing/);
        const supplied=await tools.editAgreement({plan:held,expectedCid:cidOfObject(held.agreement),terms:{rights:{parcels:[{parcelId:'A',owners:[{ownerId:'party-b',share:'1/1'}]}]}}});
        expect(supplied.agreement.inputs.parcels[0].holders[0].ownerKey).toBe('party-b');expect(supplied.rightsStatus).toBe('caller-supplied-unverified');
    });
    it('preserves terms and refuses to silently drop allocations for changed land pieces',async()=>{
        const {tools,plan,lake}=await fixture();
        const titleOnly=await tools.editAgreement({plan,expectedCid:plan.cid,terms:{title:'Revised title'}});
        expect(titleOnly.agreement.title).toBe('Revised title');expect(titleOnly.agreement.rule).toEqual(plan.agreement.rule);expect(titleOnly.agreement.money).toEqual(plan.agreement.money);
        expect(titleOnly.agreement.consultation).toEqual(consultation);
        const allocated=structuredClone(plan);
        delete allocated.draftRef;delete allocated.cid;
        const piece=allocated.agreement.outputs.find(p=>p.producedBy===lake.cid);
        allocated.agreement.allocations=[{output:piece.hash,to:{kind:'public'}}];
        allocated.agreement.rule={electorate:'owners',binding:false,approvalConfig:null,lens:[]};
        allocated.agreement.consultation=null;
        await expect(tools.editAgreement({plan:allocated,expectedCid:cidOfObject(allocated.agreement),operations:[{type:'remove',ref:`design:${lake.cid}`}]})).rejects.toMatchObject({code:'allocations-review-required'});
        const next=await tools.editAgreement({plan:allocated,expectedCid:cidOfObject(allocated.agreement),operations:[{type:'remove',ref:`design:${lake.cid}`}],terms:{allocations:[]}});
        expect(next.agreement.allocations).toEqual([]);
    });
    it('changes participation metadata through an explicit override and gives the revision another CID',async()=>{
        const {tools,plan}=await fixture();
        const updated={...consultation,organiser:'did:web:another.example'};
        const next=await tools.editAgreement({plan,expectedCid:plan.cid,terms:{consultation:updated}});
        expect(next.agreement.consultation).toEqual(updated);expect(next.cid).not.toBe(plan.cid);
        expect(plan.agreement.consultation).toEqual(consultation);
        const cleared=await tools.editAgreement({plan:next,expectedCid:next.cid,terms:{consultation:null}});
        expect(cleared.agreement.consultation).toEqual({organiser:null,participationUrl:null});
    });
});
