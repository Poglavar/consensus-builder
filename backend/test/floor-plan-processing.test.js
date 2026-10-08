// Exercise metric geometry, source identity, and cost gates without network or browser APIs.
import {describe,it,expect,vi} from 'vitest';
import {parseReading,buildReadingRequest} from '../floor-plans/plan-reading.js';
import {addressKey,chooseBinding,chooseAddressedBuilding,prepareBinding} from '../floor-plans/building-resolution.js';
import {taskId,reservationUsd,storeReading} from '../floor-plans/interpret-plans.js';

const context={building:{city:'test-city',source:'survey',ownerId:'',buildingId:'42',name:'Test building'},facts:{floor:'1',sourceId:'7'}};
const task={id:'a'.repeat(64),source_sha256:'b'.repeat(64),source_url:'https://agency.test/plan.png',page:1,context};
function drawing() {return {schema:'floor-plan-reading.v1',notPlan:false,issues:[],plans:[{
    id:'A1',label:'A1',scope:'unit',floor:1,floorEvidence:'First floor',framePx:[19,19,162,162],
    scale:{a:[20,190],b:[180,190],lengthM:8,quote:'8 m'},slabsPx:[[[[20,20],[180,20],[180,180],[20,180]]]],
    wallsPx:[{a:[20,20],b:[20,180],widthPx:2},{a:[180,20],b:[180,180],widthPx:2},
        {a:[20,20],b:[60,20],widthPx:2},{a:[80,20],b:[180,20],widthPx:2},
        {a:[20,180],b:[60,180],widthPx:2},{a:[90,180],b:[180,180],widthPx:2}],
    openingsPx:[{kind:'window',a:[60,20],b:[80,20],depthPx:2},
        {kind:'door',a:[60,180],b:[90,180],depthPx:2,hinge:[60,180],openTip:[60,150]}],
    rooms:[{name:'Living room',areaM2:null}],wallHeightM:null,heightEvidence:'',elevationM:null,elevationEvidence:'',northPx:null,northEvidence:'',issues:[]
}]};}
const parse=raw=>parseReading(JSON.stringify(raw),task,{width:200,height:200});

describe('source reading to vector architecture',()=>{
    it('converts pixels using a measured scale and retains unknown vertical facts',()=>{
        const plan=parse(drawing()).plans[0];
        expect(plan.architecture.dimensionsM).toEqual([8.1,8.1]);
        expect(plan.architecture.walls).toHaveLength(6);
        expect(plan.architecture.openings[0]).toMatchObject({kind:'window',depthM:0.1});
        expect(plan.architecture.openings[1].hinge[0]).toBeCloseTo(41/162);
        expect(plan.elevationM).toBeNull();expect(plan.source.northPx).toBeNull();
        expect(plan.verticalDimensionsBasis).toMatch(/Estimated/);
        expect(plan.building.buildingId).toBe('42');
    });
    it.each(['scale','door','frame','floor'])('rejects invalid %s evidence',kind=>{
        const raw=drawing(),p=raw.plans[0];
        if(kind==='scale')p.scale.lengthM=null;
        if(kind==='door')p.openingsPx[1].hinge=null;
        if(kind==='frame')p.framePx=[0,0,400,400];
        if(kind==='floor')p.floorEvidence='';
        expect(()=>parse(raw)).toThrow();
    });
    it('retains floor conflicts and multiple distinct drawings',()=>{
        const raw=drawing();raw.plans.push({...structuredClone(raw.plans[0]),id:'A2',floor:2});
        const read=parse(raw);expect(read.plans).toHaveLength(2);
        expect(read.plans[1].quality.issues).toContain('Drawing and listing floor numbers conflict.');
    });
    it('never accepts an empty successful response or non-plan with geometry',()=>{
        expect(()=>parse({schema:'floor-plan-reading.v1',notPlan:false,issues:[],plans:[]})).toThrow();
        const raw=drawing();raw.notPlan=true;expect(()=>parse(raw)).toThrow();
    });
    it('passes image dimensions and treats the source as data without requesting building IDs',()=>{
        const request=buildReadingRequest(task,{data:Buffer.from('png'),width:200,height:200});
        expect(request.custom_id).toBe(task.id);
        expect(JSON.parse(request.params.messages[0].content[1].text).image.widthPx).toBe(200);
        expect(request.params.system).toContain('untrusted source data');
        const payload=JSON.parse(request.params.messages[0].content[1].text);
        expect(payload).not.toHaveProperty('building');
        expect(payload.listing).not.toHaveProperty('coordinates');
        expect(request.params.output_config.format).toMatchObject({type:'json_schema',schema:{additionalProperties:false}});
    });
});

describe('confirmed building evidence',()=>{
    const binding={city:'test-city',source:'survey',owner_id:'',building_id:'42',match_kind:'listing',match_value:'https://agency.test/a'};
    it('does not promote proximity or ambiguous project membership',()=>{
        expect(chooseBinding({url:'https://agency.test/a',facts:{}},[binding])?.building_id).toBe('42');
        expect(chooseBinding({url:'https://agency.test/a',facts:{}},[binding,{...binding,building_id:'43'}])).toBeNull();
        expect(chooseBinding({url:'https://agency.test/b',facts:{coordinates:{lat:1,lng:2}}},[binding])).toBeNull();
    });
    it('requires house number and corroborating property coordinates for inventory matching',()=>{
        expect(addressKey('Example Street')).toBeNull();
        const row={address:'Example Street 12',building_id:'42',lat:45,lng:15};
        expect(chooseAddressedBuilding({facts:{address:row.address}},[row])).toBeNull();
        expect(chooseAddressedBuilding({facts:{address:row.address,coordinates:{lat:45,lng:15}}},[row])?.building_id).toBe('42');
        expect(chooseAddressedBuilding({facts:{address:row.address,coordinates:{lat:45,lng:15}}},[row,{...row,building_id:'43'}])).toBeNull();
    });
    it('refuses a binding without independent source evidence',()=>{
        expect(()=>prepareBinding({city:'test-city',source:'survey',buildingId:'42',name:'A',match:{kind:'listing',value:'https://agency.test/a'}})).toThrow();
    });
});

describe('durable tasks and spend accounting',()=>{
    it('changes task identity for source content, page, building, floor and processor inputs',()=>{
        const id=taskId(task.source_sha256,1,context);
        expect(taskId(task.source_sha256,1,structuredClone(context))).toBe(id);
        expect(taskId('c'.repeat(64),1,context)).not.toBe(id);
        expect(taskId(task.source_sha256,2,context)).not.toBe(id);
        expect(taskId(task.source_sha256,1,{...context,facts:{...context.facts,floor:'2'}})).not.toBe(id);
        expect(taskId(task.source_sha256,1,{...context,building:{...context.building,buildingId:'43'}})).not.toBe(id);
    });
    it('reserves maximum output and input headroom, using batch pricing',()=>{
        const price=vi.fn(()=>0.15);expect(reservationUsd('model',1000,price)).toBe(0.15);
        expect(price).toHaveBeenCalledWith('model',{input_tokens:2224,output_tokens:12000},{batch:true});
        expect(()=>reservationUsd('model',null,price)).toThrow();
    });
    it('rolls back on a vector artifact read-back mismatch',async()=>{
        const db={query:vi.fn(async sql=>({rows:sql.startsWith('SELECT model_hash')?[{model_hash:'wrong'}]:[],rowCount:1}))};
        await expect(storeReading(db,task,parse(drawing()))).rejects.toThrow(/read-back/);
        expect(db.query).toHaveBeenCalledWith('ROLLBACK');
        expect(db.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
    });
});
