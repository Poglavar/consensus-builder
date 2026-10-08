import {describe,it,expect,vi} from 'vitest';
import {registerFullFloor,mergeRegisteredFloor,publishProcessedPlans} from '../floor-plans/publish-plans.js';
import {geometryIssues} from '../floor-plans/geometry-quality.js';
import {currentTaskContext} from '../floor-plans/interpret-plans.js';
import {createRequire} from 'node:module';
const {validateFloorPlans}=createRequire(import.meta.url)('../../frontend/js/building-floor-plans.js');
const rect=(x,y,w,h)=>[[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]];
function model() {return {scope:'floor',floor:1,elevationM:null,rooms:[],quality:{issues:[],processor:'test',rasterEvidence:{checked:true,passed:true}},
    verticalDimensionsBasis:'Estimated heights',source:{url:'https://agency.test/plan.png',sha256:'a'.repeat(64),page:1,
        scale:{id:'S1',a:[0,0],b:[100,0],lengthM:10,quote:'10m'},northPx:[[100,100],[100,50]],northEvidence:'N',
        registrationEvidence:{schema:'floor-plan-registration-evidence.v1',sourceSha256:'a'.repeat(64),page:1,
            scale:{candidateId:'S1',a:[0,0],b:[100,0],lengthM:10,quote:'10m',status:'verified',basis:'Printed endpoints checked against archived source.'},
            orientation:{northPx:[[100,100],[100,50]],status:'verified',basis:'Arrow checked on the floor drawing.'}}},
    architecture:{schema:'consensus-builder.floor-architecture.v1',dimensionsM:[10,10],wallHeightM:2.7,slabThicknessM:.2,
        slabs:[rect(0,0,1,1)],walls:[rect(0,0,1,.02),rect(0,.98,1,.02),rect(0,.02,.02,.96),rect(.98,.02,.02,.96)],
        openings:[],landings:[],stairs:[],railings:[]}};}
const origin=[16,45],lngScale=111320*Math.cos(Math.PI/4);
const footprint=size=>({type:'Polygon',coordinates:[[[0,0],[size,0],[size,size],[0,size],[0,0]].map(([x,y])=>[origin[0]+x/lngScale,origin[1]+y/111320])]});
const row={id:'a'.repeat(64),region_id:'F1',city:'zagreb',source:'zagreb-3d',owner_id:'',building_id:'42'};

describe('whole-floor geographic registration',()=>{
    it('preserves measured scale and printed north while fitting the actual footprint',()=>{
        const plan=model(),r=registerFullFloor(plan,footprint(10));
        expect(r.planOverlap).toBeCloseTo(1,4);expect(r.buildingOverlap).toBeCloseTo(1,4);
        expect(r.corners[0][1]).toBeGreaterThan(r.corners[3][1]);
        const saved=mergeRegisteredFloor(null,{...row,model:plan},r);
        expect(validateFloorPlans(saved)).toEqual([]);
        expect(saved.floors[0]).toMatchObject({level:1,elevationM:3,elevationBasis:'estimated'});
    });
    it.each(['unit','north','floor','review','raster','small','large'])('rejects unsafe %s registration',kind=>{
        const plan=model();let shape=footprint(10);
        if(kind==='unit')plan.scope='unit';if(kind==='north')plan.source.northPx=null;
        if(kind==='floor')plan.floor=null;if(kind==='review')plan.quality.issues=['uncertain'];
        if(kind==='raster')delete plan.quality.rasterEvidence;
        if(kind==='small')shape=footprint(5);if(kind==='large')shape=footprint(20);
        expect(()=>registerFullFloor(plan,shape)).toThrow();
    });
    it('preserves authored floors and rejects incompatible registrations',()=>{
        const plan=model(),r=registerFullFloor(plan,footprint(10));
        const existing=mergeRegisteredFloor(null,{...row,model:plan},r);
        existing.layouts[0].source.automatic=false;
        expect(()=>mergeRegisteredFloor(existing,{...row,id:'b'.repeat(64),model:plan},r)).toThrow(/manually/);
        expect(()=>mergeRegisteredFloor(existing,{...row,model:{...plan,floor:2}},{...r,corners:r.corners.map(p=>[p[0]+.00001,p[1]])})).toThrow(/registration/);
        const next=mergeRegisteredFloor(existing,{...row,id:'c'.repeat(64),model:{...plan,floor:2}},r);
        expect(next.floors.map(f=>f.level)).toEqual([1,2]);expect(next.layouts).toHaveLength(2);
        expect(next.layouts[0]).toEqual(existing.layouts[0]);
    });
    it.each(['absent','source','page','scale','candidate','north','unverified'])('rejects %s independent registration evidence even on a matching square footprint',kind=>{
        const plan=model(),evidence=plan.source.registrationEvidence;
        if(kind==='absent')delete plan.source.registrationEvidence;
        if(kind==='source')evidence.sourceSha256='b'.repeat(64);
        if(kind==='page')evidence.page=2;
        if(kind==='scale')evidence.scale.lengthM=20;
        if(kind==='candidate')evidence.scale.candidateId='S2';
        if(kind==='north')evidence.orientation.northPx=[[100,100],[150,100]];
        if(kind==='unverified')evidence.scale.status='model-read';
        expect(()=>registerFullFloor(plan,footprint(10))).toThrow(/independent source verification/);
    });
});

describe('geometry and publishing evidence',()=>{
    it('flags continuous walls across openings, detached openings and invalid door leaves',()=>{
        const a=model().architecture;
        a.openings=[{kind:'door',a:[.4,.01],b:[.6,.01],depthM:.2,hinge:[.4,.1],openTip:[.4,.8]}];
        expect(geometryIssues(a)).toEqual(expect.arrayContaining([
            'An opening overlaps a solid wall; its wall gap needs review.',
            'Door hinge or leaf length does not match its opening.'
        ]));
        a.openings[0]={kind:'window',a:[.4,.5],b:[.6,.5],depthM:.2};
        expect(geometryIssues(a)).toContain('An opening is disconnected from its adjoining walls.');
    });
    it('locks the source and listing inside the publication transaction',async()=>{
        const db={query:vi.fn(async()=>({rows:[]}))};
        await currentTaskContext(db,{listing_url:'l',source_url:'s',source_sha256:'h'},{lock:true});
        expect(db.query.mock.calls[0][0]).toContain('FOR SHARE OF l,t');
    });
    it('withdraws a ready status when the current source association no longer supports publication',async()=>{
        const db={query:vi.fn(async sql=>({rows:sql.startsWith('SELECT p.')?[{...row,model:model()}]:[],rowCount:1}))};
        const result=await publishProcessedPlans(db,{log:()=>{}});
        expect(result).toMatchObject({published:0,needsReview:1});
        expect(db.query).toHaveBeenCalledWith('ROLLBACK');
        const saved=db.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE floor_plan.processed_plan'));
        expect(saved[0]).toContain("status='needs_review'");
        expect(JSON.parse(saved[1][1]).needsReview).toMatch(/association changed/);
    });
    it('does not start publication work beyond the job deadline',async()=>{
        const db={query:vi.fn(async()=>({rows:[{...row,model:model()}]}))};
        expect(await publishProcessedPlans(db,{deadline:0})).toMatchObject({published:0,deferred:1});
        expect(db.query.mock.calls).toHaveLength(1);
    });
});
