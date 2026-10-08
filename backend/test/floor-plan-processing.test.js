// Exercise source-grounded vectorization, identity, and cost gates without network or browser APIs.
import {describe,it,expect,vi} from 'vitest';
import {parseReading,buildReadingRequest,MAX_OUTPUT_TOKENS} from '../floor-plans/plan-reading.js';
import {addressKey,chooseBinding,chooseAddressedBuilding,prepareBinding} from '../floor-plans/building-resolution.js';
import {taskId,reservationUsd,storeReading} from '../floor-plans/interpret-plans.js';

const context={building:{city:'test-city',source:'survey',ownerId:'',buildingId:'42',name:'Test building'},facts:{floor:'1',sourceId:'7'}};
const task={id:'a'.repeat(64),source_sha256:'b'.repeat(64),source_url:'https://agency.test/plan.png',page:1,context};
const evidence={version:'source-geometry-v1',widthPx:200,heightPx:200,issues:[],
    wallCandidates:[
        {id:'W1',a:[20,20],b:[20,180],widthPx:2},{id:'W2',a:[180,20],b:[180,180],widthPx:2},
        {id:'W3',a:[20,20],b:[60,20],widthPx:2},{id:'W4',a:[80,20],b:[180,20],widthPx:2},
        {id:'W5',a:[20,180],b:[60,180],widthPx:2},{id:'W6',a:[90,180],b:[180,180],widthPx:2}
    ],
    openingCandidates:[{id:'G1',a:[60,20],b:[80,20],widthPx:2},{id:'G2',a:[60,180],b:[90,180],widthPx:2}],
    scaleCandidates:[{id:'S1',a:[20,190],b:[180,190],widthPx:2}],
    outlineCorners:[[19,19],[181,19],[181,181],[19,181]]
};
function drawing() {return {schema:'floor-plan-reading.v3',notPlan:false,issues:[],plans:[{
    id:'A1',label:'A1',scope:'unit',floor:1,floorEvidence:'First floor',
    scale:{candidateId:'S1',lengthM:8,quote:'8 m'},slabs:[{outer:['F0','F1','F2','F3'],holes:[]}],
    wallIds:['W1','W2','W3','W4','W5','W6'],railingIds:[],
    openings:[{candidateId:'G1',kind:'window',hinge:null,swing:null},{candidateId:'G2',kind:'door',hinge:'a',swing:'counterclockwise'}],
    rooms:[{name:'Living room',areaM2:null}],wallHeightM:null,heightEvidence:'',elevationM:null,elevationEvidence:'',northPx:null,northEvidence:'',issues:[]
}]};}
const parse=raw=>parseReading(JSON.stringify(raw),task,{width:200,height:200,evidence});

describe('source reading to vector architecture',()=>{
    it('selects measured geometry, derives its frame, and retains unknown vertical facts',()=>{
        const plan=parse(drawing()).plans[0];
        expect(plan.architecture.dimensionsM).toEqual([8.1,8.1]);
        expect(plan.architecture.walls).toHaveLength(6);
        expect(plan.architecture.openings[0]).toMatchObject({kind:'window',depthM:0.1});
        expect(plan.architecture.openings[1].hinge[0]).toBeCloseTo(41/162);
        expect(plan.source.framePx).toEqual([19,19,162,162]);
        expect(plan.source.wallIds).toEqual(['W1','W2','W3','W4','W5','W6']);
        expect(plan.elevationM).toBeNull();expect(plan.source.northPx).toBeNull();
        expect(plan.verticalDimensionsBasis).toMatch(/Estimated/);
        expect(plan.building.buildingId).toBe('42');
    });
    it.each(['scale','floor','unknown-wall','unknown-scale','invented-slab','unknown-opening','conflicting-opening','duplicate-opening'])('rejects invalid %s evidence',kind=>{
        const raw=drawing(),p=raw.plans[0];
        if(kind==='scale')p.scale.lengthM=null;
        if(kind==='floor')p.floorEvidence='';
        if(kind==='unknown-wall')p.wallIds[0]='W404';
        if(kind==='unknown-scale')p.scale.candidateId='S404';
        if(kind==='invented-slab')p.slabs[0].outer[1]='F404';
        if(kind==='unknown-opening')p.openings[0].candidateId='G404';
        if(kind==='conflicting-opening')p.openings[0].candidateId='W1';
        if(kind==='duplicate-opening')p.openings.push({...p.openings[0]});
        expect(()=>parse(raw)).toThrow();
    });
    it.each(['outside-frame','missing-hinge'])('retains only valid geometry with a mandatory review issue for an %s opening',kind=>{
        const raw=drawing(),opening=raw.plans[0].openings[0];
        Object.assign(opening,{kind:'door',hinge:kind==='missing-hinge'?null:'a',swing:'counterclockwise'});
        const plan=parse(raw).plans[0];
        expect(plan.architecture.walls).toHaveLength(6);
        expect(plan.architecture.openings).toHaveLength(1);
        expect(plan.source.openingIds).toEqual(['G2']);
        expect(plan.source.omittedOpenings).toEqual([expect.objectContaining({candidateId:'G1',reason:expect.any(String)})]);
        expect(plan.quality.issues).toEqual([expect.stringContaining('Opening G1 was omitted from this incomplete preview:')]);
    });
    it('retains floor conflicts and multiple distinct drawings',()=>{
        const raw=drawing();raw.plans.push({...structuredClone(raw.plans[0]),id:'A2',floor:2});
        const read=parse(raw);expect(read.plans).toHaveLength(2);
        expect(read.plans[1].quality.issues).toContain('Drawing and listing floor numbers conflict.');
    });
    it('never accepts an empty successful response or non-plan with geometry',()=>{
        expect(()=>parse({schema:'floor-plan-reading.v3',notPlan:false,issues:[],plans:[]})).toThrow();
        const raw=drawing();raw.notPlan=true;expect(()=>parse(raw)).toThrow();
    });
    it('passes measured evidence and image dimensions without requesting building IDs',()=>{
        const request=buildReadingRequest(task,{data:Buffer.from('png'),annotation:Buffer.from('annotated'),scaleAnnotation:Buffer.from('scales'),width:200,height:200,evidence});
        expect(request.custom_id).toBe(task.id);
        const message=request.params.messages[0].content.find(part=>part.type==='text');
        const payload=JSON.parse(message.text);
        expect(payload.image.widthPx).toBe(200);expect(payload.sourceEvidence).toStrictEqual(evidence);
        expect(request.params.max_tokens).toBe(MAX_OUTPUT_TOKENS);
        expect(request.params.system).toContain('untrusted source data');
        expect(payload).not.toHaveProperty('building');
        expect(payload.listing).not.toHaveProperty('coordinates');
        expect(request.params.tool_choice).toEqual({type:'tool',name:'record_floor_plan'});
        expect(request.params.tools[0]).toMatchObject({input_schema:{additionalProperties:false}});
        expect(request.params.messages[0].content.filter(part=>part.type==='image')).toHaveLength(3);
    });
    it('uses the explicitly bounded output allowance for a small pilot',()=>{
        const image={data:Buffer.from('png'),width:200,height:200,evidence};
        expect(buildReadingRequest(task,image,'test-model',{maxOutputTokens:2800}).params.max_tokens).toBe(2800);
        expect(()=>buildReadingRequest(task,image,'test-model',{maxOutputTokens:0})).toThrow(/token allowance/);
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
        expect(price).toHaveBeenCalledWith('model',{input_tokens:2224,output_tokens:MAX_OUTPUT_TOKENS},{batch:true});
        reservationUsd('model',1000,price,2800);
        expect(price).toHaveBeenLastCalledWith('model',{input_tokens:2224,output_tokens:2800},{batch:true});
        expect(()=>reservationUsd('model',null,price)).toThrow();
        expect(()=>reservationUsd('model',1000,price,-1)).toThrow();
    });
    it('rolls back on a vector artifact read-back mismatch',async()=>{
        const db={query:vi.fn(async sql=>({rows:sql.startsWith('SELECT model_hash')?[{model_hash:'wrong'}]:[],rowCount:1}))};
        await expect(storeReading(db,task,parse(drawing()))).rejects.toThrow(/read-back/);
        expect(db.query).toHaveBeenCalledWith('ROLLBACK');
        expect(db.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
    });
});
