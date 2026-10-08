// Protect current-source filtering and review response shape for interpreted plans.
import { describe, expect, it } from 'vitest';
import {
    currentProcessedPlan, processedBuildingId, processedBuildingView,
    processedPlanView, selectCurrentProcessedRows
} from '../floor-plan-archive/processed-catalogue.js';
import { setupFloorPlanArchiveRoute } from '../routes/floor-plan-archive.js';

const footprint={type:'Polygon',coordinates:[[[15,45],[15.01,45],[15.01,45.01],[15,45.01],[15,45]]]};
function row(overrides={}) {
    const model={schema:'consensus-builder.processed-floor-plan.v1',unitId:'unit-a',label:'Apartment A',scope:'unit',floor:2,
        rooms:[{name:'Living room',areaM2:24}],architecture:{schema:'consensus-builder.floor-architecture.v1',walls:[]},
        building:{city:'zagreb',source:'survey',ownerId:'',buildingId:'b-7',name:'Park House',footprint},
        source:{url:'https://agency.test/plan.pdf',sha256:'a'.repeat(64),page:1},quality:{issues:['North arrow not shown']}};
    return {id:'b'.repeat(64),task_id:'c'.repeat(64),region_id:'unit-a',city:'zagreb',source:'survey',owner_id:'',building_id:'b-7',
        source_sha256:'a'.repeat(64),model,model_hash:'d'.repeat(64),status:'ready',published_version:null,
        source_url:'https://agency.test/plan.pdf',page:1,listing_url:'https://agency.test/listing/1',processor:'vision-v1',
        task_status:'complete',usage:{input_tokens:20,output_tokens:40},cost_usd:'0.004',media_type:'application/pdf; charset=binary',
        target_sha256:'a'.repeat(64),listing_match_status:'verified',listing_city:'zagreb',listing_source:'survey',
        listing_owner_id:'',listing_building_id:'b-7',listing_owns_asset:true,task_city:'zagreb',task_source:'survey',
        task_owner_id:'',task_building_id:'b-7',updated_at:'2026-10-08T10:00:00Z',task_updated_at:'2026-10-08T10:00:00Z',...overrides};
}

describe('processed floor-plan catalogue',()=>{
    it('groups current plans under a stable review building and preserves review evidence',()=>{
        const first=row(),second=row({id:'e'.repeat(64),region_id:'unit-b',model:{...row().model,unitId:'unit-b',label:'Apartment B'}});
        const building=processedBuildingView([first,second]);
        expect(building).toMatchObject({id:processedBuildingId(first),name:'Park House',kind:'units',planCount:2,
            locationAvailable:true,wholeBuildingAvailable:false,footprint,location:{basis:'source-footprint'}});
        expect(building.location.longitude).toBeCloseTo(15.005);
        expect(building.location.latitude).toBeCloseTo(45.005);
        expect(building.plans[0]).toMatchObject({id:first.id,label:'Apartment A',reviewStatus:'ready',level:2,
            archivedSha256:'a'.repeat(64),mediaType:'application/pdf',reviewNotes:['North arrow not shown']});
        expect(building.plans[0].architecture).toEqual(first.model.architecture);
    });

    it('drops stale or changed listing associations and keeps only the newest duplicate page reading',()=>{
        const old=row({id:'e'.repeat(64),updated_at:'2026-10-07T10:00:00Z'});
        const newest=row({id:'f'.repeat(64),updated_at:'2026-10-08T11:00:00Z'});
        const staleSource=row({id:'1'.repeat(64),target_sha256:'9'.repeat(64)});
        const changedMatch=row({id:'2'.repeat(64),listing_match_status:'candidate'});
        const changedBuilding=row({id:'3'.repeat(64),listing_building_id:'other'});
        const noLongerOwned=row({id:'4'.repeat(64),listing_owns_asset:false});
        expect(selectCurrentProcessedRows([old,newest,staleSource,changedMatch,changedBuilding,noLongerOwned])).toEqual([newest]);
    });

    it('loads a single current plan by id and returns null for stale associations',async()=>{
        const current=row(),db={query:async(_sql,params)=>({rows:params ? [current] : []})};
        await expect(currentProcessedPlan(db,current.id)).resolves.toMatchObject({id:current.id});
        const staleDb={query:async()=>({rows:[row({listing_building_id:'changed'})]})};
        await expect(currentProcessedPlan(staleDb,current.id)).resolves.toBeNull();
    });

    it('uses the processed response shape for standalone audit details',()=>{
        const result=processedPlanView(row());
        expect(result).toMatchObject({id:'b'.repeat(64),label:'Apartment A',scope:'unit',level:2,
            rooms:[{name:'Living room',areaM2:24}],source:{url:'https://agency.test/plan.pdf'},reviewNotes:['North arrow not shown']});
    });

    it('serves current processed detail with model quality and task cost evidence',async()=>{
        const current=row(),routes=new Map();
        setupFloorPlanArchiveRoute({get:(path,handler)=>routes.set(path,handler)},{query:async(_sql,params)=>({rows:params?[current]:[]})});
        const response={headers:{},set(name,value){this.headers[name]=value;return this;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
        await routes.get('/floor-plan-archive/processed/:id')({params:{id:current.id},query:{}},response,err=>{throw err;});
        expect(response.statusCode).toBeUndefined();
        expect(response.headers['Cache-Control']).toBe('no-store');
        expect(response.body).toMatchObject({id:current.id,reviewNotes:['North arrow not shown'],task:{
            id:current.task_id,status:'complete',costUsd:0.004,usage:{input_tokens:20,output_tokens:40}}});
    });
});
