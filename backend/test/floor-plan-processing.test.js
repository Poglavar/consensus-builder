// Exercise source-grounded vectorization, identity, and cost gates without network or browser APIs.
import {describe,it,expect,vi} from 'vitest';
import {parseReading,buildReadingRequest,PROCESSOR,MAX_OUTPUT_TOKENS} from '../floor-plans/plan-reading.js';
import {addressKey,chooseBinding,chooseAddressedBuilding,prepareBinding} from '../floor-plans/building-resolution.js';
import {taskId,taskContext,enqueuePlanTasks,currentTaskContext,reservationUsd,storeReading} from '../floor-plans/interpret-plans.js';
import {createLlm,DEFAULTS} from '../../../agents/lib/llm-cost/llm.mjs';
import {processAssets} from '../floor-plans/process-assets.js';
import {reparseListings} from '../floor-plans/reparse.js';
vi.mock('../floor-plans/blob-store.js',async importOriginal=>({
    ...await importOriginal(),readBlobRow:vi.fn(async row=>row?.sourceBytes??Buffer.from('fixture'))
}));

// The real shared layer over a client that must never be called: building a request is offline.
const never=vi.fn(async()=>{throw new Error('building a request makes no API call');});
const llm=createLlm({client:{messages:{create:never,batches:{create:never}}},repo:'consensus-builder',script:'floor-plan-vision-test'});
const LAYER_MODEL=DEFAULTS.providers.anthropic.model;

const context={listingUrl:'https://agency.test/listing/1',facts:{floor:'1',unitId:null,areaM2:null}};
const task={id:'a'.repeat(64),source_sha256:'b'.repeat(64),source_url:'https://agency.test/plan.png',listing_url:context.listingUrl,page:1,context};
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
function drawing() {return {schema:'floor-plan-reading.v4',notPlan:false,issues:[],plans:[{
    id:'A1',label:'A1',scope:'unit',floor:1,floorEvidence:'First floor',
    scale:{candidateId:'S1',lengthM:8,quote:'8 m'},dimensionHints:[],slabs:[{outer:['F0','F1','F2','F3'],holes:[]}],
    wallIds:['W1','W2','W3','W4','W5','W6'],railingIds:[],
    openings:[{candidateId:'G1',kind:'window',hinge:null,swing:null},{candidateId:'G2',kind:'door',hinge:'a',swing:'counterclockwise'}],
    rooms:[{name:'Living room',areaM2:null}],wallHeightM:null,heightEvidence:'',elevationM:null,elevationEvidence:'',northPx:null,northEvidence:'',issues:[]
}]};}
const parse=raw=>parseReading(JSON.stringify(raw),task,{width:200,height:200,evidence,model:'answering-model'});

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
        expect(plan.building).toBeNull();
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
    it('records a printed scale bar as a measurement',()=>{
        expect(parse(drawing()).plans[0].source).toMatchObject({scaleBasis:'printed-scale-bar',scaleEstimated:false,metersPerPixel:0.05});
    });
    it('reads a drawing without a scale bar from printed dimensions on measured strokes',()=>{
        const raw=drawing();raw.plans[0].scale=null;
        raw.plans[0].dimensionHints=[{candidateId:'W1',lengthM:8,quote:'8.00'},{candidateId:'W4',lengthM:5,quote:'500'}];
        const plan=parse(raw).plans[0];
        expect(plan.source).toMatchObject({scale:null,scaleBasis:'printed-dimensions',scaleEstimated:false,metersPerPixel:0.05});
        expect(plan.architecture.dimensionsM).toEqual([8.1,8.1]);
    });
    it('falls back to door widths, then to the listing area, labelled as estimates',()=>{
        const raw=drawing();raw.plans[0].scale=null;
        raw.plans[0].openings=[{candidateId:'G1',kind:'door',hinge:'a',swing:'clockwise'},{candidateId:'G2',kind:'door',hinge:'a',swing:'counterclockwise'}];
        const doors=parse(raw).plans[0].source;
        expect(doors).toMatchObject({scaleBasis:'door-width',scaleEstimated:true});
        expect(doors.metersPerPixel).toBeCloseTo(0.9/25,6);
        const area=drawing();area.plans[0].scale=null;area.plans[0].openings=[];
        const plan=parseReading(JSON.stringify(area),{...task,context:{...task.context,facts:{...task.context.facts,areaM2:59.6}}},
            {width:200,height:200,evidence,model:'answering-model'}).plans[0];
        expect(plan.source).toMatchObject({scaleBasis:'listing-area',scaleEstimated:true});
        expect(plan.architecture.dimensionsM[0]).toBeCloseTo(162*Math.sqrt(59.6*1.1/(162*162)),3);
    });
    it('keeps a drawing with no metric evidence at a provisional scale, marked unknown',()=>{
        const raw=drawing();raw.plans[0].scale=null;raw.plans[0].openings=[];
        const plan=parse(raw).plans[0];
        expect(plan.source).toMatchObject({scaleBasis:'unknown',scaleEstimated:true,metersPerPixel:0.02});
        expect(plan.quality.issues.join(' ')).toMatch(/provisional/);
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
    it('records the answering model as provenance and refuses a reading without one',()=>{
        expect(parse(drawing()).plans[0].quality.model).toBe('answering-model');
        expect(()=>parseReading(JSON.stringify(drawing()),task,{width:200,height:200,evidence})).toThrow(/answering model/);
    });
    it('never accepts an empty successful response or non-plan with geometry',()=>{
        expect(()=>parse({schema:'floor-plan-reading.v4',notPlan:false,issues:[],plans:[]})).toThrow();
        const raw=drawing();raw.notPlan=true;expect(()=>parse(raw)).toThrow();
    });
    it('passes measured evidence and image dimensions without requesting building IDs',()=>{
        const request=buildReadingRequest(llm,task,{data:Buffer.from('png'),annotation:Buffer.from('annotated'),scaleAnnotation:Buffer.from('scales'),width:200,height:200,evidence});
        expect(request.custom_id).toBe(task.id);
        const message=request.params.messages[0].content.find(part=>part.type==='text');
        const payload=JSON.parse(message.text);
        expect(payload.image.widthPx).toBe(200);expect(payload.sourceEvidence).toStrictEqual(evidence);
        expect(request.params.max_tokens).toBe(MAX_OUTPUT_TOKENS);
        expect(request.params.system).toContain('untrusted source data');
        expect(payload).not.toHaveProperty('building');
        expect(payload.listing).not.toHaveProperty('coordinates');
        // Model and effort come from the shared default; Opus 5.5 rejects forced tools and sampling knobs.
        expect(request.params.model).toBe(LAYER_MODEL);
        expect(request.params.output_config).toMatchObject({effort:DEFAULTS.providers.anthropic.effort,
            format:{type:'json_schema',schema:{additionalProperties:false}}});
        for(const rejected of ['tool_choice','tools','temperature','top_p','thinking']) expect(request.params).not.toHaveProperty(rejected);
        const images=request.params.messages[0].content.filter(part=>part.type==='image');
        expect(images).toHaveLength(3);
        expect(images[0].source).toEqual({type:'base64',media_type:'image/png',data:Buffer.from('png').toString('base64')});
        expect(never).not.toHaveBeenCalled();
    });
    it('uses the explicitly bounded output allowance for a small pilot',()=>{
        const image={data:Buffer.from('png'),width:200,height:200,evidence};
        expect(buildReadingRequest(llm,task,image,{maxOutputTokens:2800}).params.max_tokens).toBe(2800);
        expect(()=>buildReadingRequest(llm,task,image,{maxOutputTokens:0})).toThrow(/token allowance/);
    });
});

describe('confirmed building evidence',()=>{
    const facts={explicitLocation:{schema:'explicit-listing-location.v1',street:'Example Street',houseNumber:'12'},locality:'Test City'};
    const zagrebFacts={...facts,locality:'Zagreb'};
    const binding={city:'test-city',source:'survey',owner_id:'',building_id:'42',match_kind:'address',match_value:'example street 12'};
    it('requires the explicit listing address for a reviewed exact-address binding',()=>{
        expect(chooseBinding({url:'https://agency.test/a',facts:{}},[binding])).toBeNull();
        expect(chooseBinding({url:'https://agency.test/a',facts},[binding])?.building_id).toBe('42');
        expect(chooseBinding({url:'https://agency.test/a',facts},[binding,{...binding,building_id:'43'}])).toBeNull();
        expect(chooseBinding({url:'https://agency.test/a',facts:{...facts,explicitLocation:{...facts.explicitLocation,houseNumber:'13'}}},[binding])).toBeNull();
    });
    it('resolves a unique exact inventory address and leaves ambiguous matches unresolved',()=>{
        expect(addressKey('Example Street')).toBeNull();
        const row={address:'Example Street 12',building_id:'42'};
        expect(chooseAddressedBuilding({facts:{address:row.address}},[row])).toBeNull();
        expect(chooseAddressedBuilding({facts:zagrebFacts},[row])?.building_id).toBe('42');
        expect(chooseAddressedBuilding({facts:zagrebFacts},[row,{...row,building_id:'43'}])).toBeNull();
        expect(chooseAddressedBuilding({facts:{...zagrebFacts,locality:'Split'}},[row])).toBeNull();
        expect(chooseAddressedBuilding({facts:{...zagrebFacts,locality:undefined,title:'Apartment, Zagreb'}},[row])).toBeNull();
        expect(chooseAddressedBuilding({facts:{...zagrebFacts,coordinates:{lat:1,lng:2}}},[{...row,address:'Nearby Street 12'}])).toBeNull();
    });
    it('refuses a binding without independent source evidence',()=>{
        expect(()=>prepareBinding({city:'test-city',source:'survey',buildingId:'42',name:'A',match:{kind:'listing',value:'https://agency.test/a'}})).toThrow();
    });
});

it('tombstones and purges a formerly eligible listing when fresh archived HTML loses its address',async()=>{
    const listingUrl='https://opereta.hr/nekretnina/stan/4812-oglas',sourceHash='c'.repeat(64);
    const row={url:listingUrl,agency_id:9,source_id:'I4812',facts:{explicitLocation:{schema:'explicit-listing-location.v1',street:'Ilica',houseNumber:'1'}},
        asset_urls:[{url:'https://cdn.test/old-photo.jpg',listingOwned:true}],match_status:'verified',building_city:'zagreb',building_source:'zagreb-3d',
        building_owner_id:'',building_id:'42',building_evidence:{basis:'previous'},match_checked_at:new Date(),media_type:'text/html',
        current_sha256:sourceHash,source_kind:'agency',sourceBytes:Buffer.from(`<script type="application/ld+json">{"@type":"Apartment","identifier":"I4812"}</script>
            <main><h1>Listing without an advertised address</h1><p>Details with no street or house number.</p><img src="https://cdn.test/new-photo.jpg"></main>`)};
    const calls=[];let delivered=false;
    const db={query:vi.fn(async(sql,args=[])=>{
        calls.push({sql,args});
        if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
        if(sql.startsWith('SELECT count(*)'))return {rows:[{n:1}]};
        if(sql.includes('SELECT model FROM floor_plan.extraction'))return {rows:[]};
        if(sql.startsWith('SELECT l.*'))return {rows:delivered?[]:(delivered=true,[row])};
        if(sql.includes('SELECT DISTINCT sha256'))return {rows:[{sha256:sourceHash}]};
        if(sql.includes('SELECT b.sha256 FROM floor_plan.blob'))return {rows:[]};
        if(sql.includes('to_regclass'))return {rows:[{relation:null}]};
        if(sql.startsWith('UPDATE floor_plan.listing l SET facts=jsonb_build_object'))return {rows:[],rowCount:1};
        if(sql.startsWith('WITH removed AS'))return {rows:[{blobs:1,bytes:'1200'}]};
        return {rows:[],rowCount:1};
    })};
    const result=await reparseListings(db,{log:()=>{}});
    expect(result).toMatchObject({processed:1,changed:1,notListing:0,excluded:1,buildingLinksWithdrawn:1,enqueued:0});
    expect(calls.some(({sql,args})=>sql.startsWith('INSERT INTO floor_plan.exclusion')&&args[0]==='opereta:4812')).toBe(true);
    expect(calls.some(({sql})=>sql.startsWith('UPDATE floor_plan.listing l SET facts=jsonb_build_object'))).toBe(true);
    expect(calls.some(({sql})=>sql.startsWith('WITH removed AS')&&sql.includes('bytes_available=false'))).toBe(true);
    expect(calls.some(({sql})=>sql.startsWith('DELETE FROM floor_plan.observation'))).toBe(true);
    expect(calls.some(({sql})=>sql.startsWith('INSERT INTO floor_plan.target'))).toBe(false);
    expect(calls.some(({sql})=>sql.startsWith('UPDATE floor_plan.listing SET source_id='))).toBe(false);
});

describe('durable tasks and spend accounting',()=>{
    it('changes task identity for source content, page and consumed facts, not for the URL variant or building',()=>{
        const id=taskId(task.source_sha256,1,context);
        expect(taskId(task.source_sha256,1,structuredClone(context))).toBe(id);
        expect(taskId('c'.repeat(64),1,context)).not.toBe(id);
        expect(taskId(task.source_sha256,2,context)).not.toBe(id);
        expect(taskId(task.source_sha256,1,{...context,facts:{...context.facts,floor:'2'}})).not.toBe(id);
        // The same project under another host or language states the same facts: one reading.
        expect(taskId(task.source_sha256,1,{...context,listingUrl:'https://www.agency.test/en/listing/1'})).toBe(id);
        expect(taskId(task.source_sha256,1,{...context,building:{buildingId:'43'}})).toBe(id);
    });
    it('supplies the explicit listing URL unit to the reader without mistaking marketed area for a unit',()=>{
        expect(taskContext({url:'https://agency.test/stan-s2-80-58-m2/',facts:{title:'Stan 80,58 m²'}}).facts.unitId).toBe('S2');
        expect(taskContext({url:'https://agency.test/stan-80-58-m2/',facts:{title:'Stan 80,58 m²'}}).facts.unitId).toBeNull();
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
    it('enqueues an owned screened source with a located building candidate, even without a verified link',async()=>{
        const source={sha256:task.source_sha256,model:{totalPages:1},source_url:task.source_url,
            listing_url:context.listingUrl,listing_owns_asset:true,
            facts:{floor:'1',unitId:null,areaM2:null,title:'Unrelated title'},match_status:'candidate',building_located:true};
        const calls=[];
        const db={query:vi.fn(async(sql,args=[])=>{
            calls.push({sql,args});
            if(sql.includes('FROM floor_plan.extraction e'))return {rows:[source]};
            return {rows:[],rowCount:1};
        })};
        expect(await enqueuePlanTasks(db,{sourceHash:task.source_sha256})).toMatchObject({enqueued:1,ambiguous:0});
        const inserted=calls.find(call=>call.sql.includes('INSERT INTO floor_plan.plan_task'));
        expect(JSON.parse(inserted.args[5])).toEqual(context);
        expect(inserted.args[6]).toBe(PROCESSOR);
        expect(calls[0].sql).toContain("location_task.status='candidate'");
        expect(calls[0].sql).toContain('AS building_located');
        expect(calls[0].sql).toContain('OR EXISTS');
    });
    it('creates separate source-only contexts for two listing owners and deduplicates source URL aliases',async()=>{
        const rows=[
            {sha256:task.source_sha256,model:{totalPages:1},source_url:'https://agency.test/a.pdf',
                listing_url:'https://agency.test/listing/1',listing_owns_asset:true,building_located:true,facts:{floor:'1',unitId:'A',areaM2:60}},
            {sha256:task.source_sha256,model:{totalPages:1},source_url:'https://agency.test/alias.pdf',
                listing_url:'https://agency.test/listing/1',listing_owns_asset:true,building_located:true,facts:{floor:'1',unitId:'A',areaM2:60}},
            {sha256:task.source_sha256,model:{totalPages:1},source_url:'https://agency.test/alias.pdf',
                listing_url:'https://agency.test/listing/2',listing_owns_asset:true,building_located:true,facts:{floor:'2',unitId:'B',areaM2:80}},
            {sha256:task.source_sha256,model:{totalPages:1},source_url:'https://agency.test/not-owned.pdf',
                listing_url:'https://agency.test/listing/3',listing_owns_asset:false,facts:{}}
        ];
        const inserts=[];
        const db={query:vi.fn(async(sql,args=[])=>{
            if(sql.includes('FROM floor_plan.extraction e'))return {rows};
            if(sql.includes('INSERT INTO floor_plan.plan_task'))inserts.push(args);
            return {rows:[],rowCount:1};
        })};
        expect(await enqueuePlanTasks(db,{sourceHash:task.source_sha256})).toMatchObject({sources:1,enqueued:2,sharedSources:1,ambiguous:1});
        expect(new Set(inserts.map(args=>args[0])).size).toBe(2);
        expect(inserts.map(args=>JSON.parse(args[5]).listingUrl)).toEqual(['https://agency.test/listing/1','https://agency.test/listing/2']);
        expect(inserts.every(args=>JSON.parse(args[5]).building===undefined)).toBe(true);
    });
    it.each([[],[1,1],[0],[1001],[1.5],['4'],'4',{}])('rejects invalid selected pages before reading or changing sources: %j',async pages=>{
        const db={query:vi.fn()};
        await expect(enqueuePlanTasks(db,{pages})).rejects.toThrow(/nonempty unique array/);
        expect(db.query).not.toHaveBeenCalled();
    });
    it('rejects a selected page beyond the declared page count before mutating that source',async()=>{
        const row={sha256:task.source_sha256,model:{totalPages:14},source_url:task.source_url,
            listing_url:context.listingUrl,listing_owns_asset:true,building_located:true,facts:context.facts};
        const db={query:vi.fn(async()=>({rows:[row]}))};
        await expect(enqueuePlanTasks(db,{pages:[4,15]})).rejects.toThrow(/exceeds source page count \(14\)/);
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query.mock.calls[0][0]).toContain('SELECT e.sha256');
    });
    it.each([0,-1,1001,'14'])('rejects invalid declared page count %j before a source mutation',async totalPages=>{
        const row={sha256:task.source_sha256,model:{totalPages},source_url:task.source_url,
            listing_url:context.listingUrl,listing_owns_asset:true,building_located:true,facts:context.facts};
        const db={query:vi.fn(async()=>({rows:[row]}))};
        await expect(enqueuePlanTasks(db,{pages:[1]})).rejects.toThrow(/Invalid or oversized source page count/);
        expect(db.query).toHaveBeenCalledTimes(1);
    });
    it('queues only selected brochure pages with existing stable IDs and deduplicates on another pass',async()=>{
        const row={sha256:task.source_sha256,model:{totalPages:14},source_url:task.source_url,
            listing_url:context.listingUrl,listing_owns_asset:true,building_located:true,facts:context.facts};
        const inserts=[],ids=new Set();
        const db={query:vi.fn(async(sql,args=[])=>{
            if(sql.includes('FROM floor_plan.extraction e'))return {rows:[row]};
            if(sql.includes('INSERT INTO floor_plan.plan_task')){
                inserts.push(args);const existed=ids.has(args[0]);ids.add(args[0]);return {rows:[],rowCount:existed?0:1};
            }
            return {rows:[],rowCount:1};
        })};
        expect(await enqueuePlanTasks(db,{pages:[7,4]})).toMatchObject({sources:1,enqueued:2});
        expect(inserts.map(args=>args[3])).toEqual([4,7]);
        expect(inserts.map(args=>args[0])).toEqual([taskId(row.sha256,4,context),taskId(row.sha256,7,context)]);
        expect(await enqueuePlanTasks(db,{pages:[4,7]})).toMatchObject({enqueued:0});
        expect(ids.size).toBe(2);
        inserts.length=0;
        expect(await enqueuePlanTasks(db)).toMatchObject({enqueued:12});
        expect(inserts.map(args=>args[3])).toEqual(Array.from({length:14},(_,i)=>i+1));
        expect(ids.size).toBe(14);
    });
    it('maps eleven owners of one fourteen-page brochure to eleven individual page tasks',async()=>{
        const inserts=[];
        const db={query:vi.fn(async(sql,args=[])=>{
            if(sql.includes('FROM floor_plan.extraction e'))return {rows:[{sha256:task.source_sha256,model:{totalPages:14},
                source_url:'https://agency.test/brochure.pdf',listing_url:args[2][0],listing_owns_asset:true,building_located:true,
                facts:{unitId:new URL(args[2][0]).pathname.split('/').at(-1)}}]};
            if(sql.includes('INSERT INTO floor_plan.plan_task'))inserts.push(args);
            return {rows:[],rowCount:1};
        })};
        for(let unit=1;unit<=11;unit++){
            const page=unit<=3?4:unit<=6?5:unit<=9?6:7;
            expect(await enqueuePlanTasks(db,{sourceHash:task.source_sha256,urls:[`https://agency.test/S${unit}`],pages:[page]}))
                .toMatchObject({enqueued:1});
        }
        expect(inserts).toHaveLength(11);
        expect(new Set(inserts.map(args=>args[0])).size).toBe(11);
        expect(inserts.map(args=>args[3])).toEqual([4,4,4,5,5,5,6,6,6,7,7]);
    });
    it('does not let an explicit source hash enqueue an unlocated listing',async()=>{
        const source={sha256:task.source_sha256,model:{totalPages:1},source_url:task.source_url,
            listing_url:context.listingUrl,listing_owns_asset:true,building_located:false,facts:context.facts};
        const db={query:vi.fn(async sql=>sql.includes('FROM floor_plan.extraction e')?{rows:[source]}:{rows:[],rowCount:1})};
        expect(await enqueuePlanTasks(db,{sourceHash:task.source_sha256})).toMatchObject({enqueued:0,deferredLocation:1});
        expect(db.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO floor_plan.plan_task'))).toBe(false);
        expect(db.query.mock.calls[0][0]).toContain("location_task.status='candidate'");
    });
    it('checks current source and consumed facts without requiring a building match',async()=>{
        const row={url:context.listingUrl,facts:{floor:'1',unitId:null,areaM2:null},match_status:'candidate',building_located:true};
        const db={query:vi.fn(async()=>({rows:[row]}))};
        expect(await currentTaskContext(db,task)).toBe(true);
        expect(await currentTaskContext(db,task,{requireLocation:true})).toBe(true);
        row.building_located=false;
        expect(await currentTaskContext(db,task)).toBe(true);
        expect(await currentTaskContext(db,task,{requireLocation:true})).toBe(false);
        row.building_located=true;
        row.match_status='verified';row.building_id='changed';
        expect(await currentTaskContext(db,task)).toBe(true);
        expect(await currentTaskContext(db,{...task,context:{facts:context.facts}})).toBe(false);
        row.facts.floor='2';
        expect(await currentTaskContext(db,task)).toBe(false);
        expect(db.query.mock.calls[0][0]).toContain('t.current_sha256=$3');
        expect(db.query.mock.calls[0][0]).toContain("'listingOwned',true");
        row.facts.floor='1';row.facts.sourceEvidenceStatus='not-a-listing';
        expect(await currentTaskContext(db,task)).toBe(false);
    });
    it('stores source-only geometry with nullable canonical columns and an immutable hash',async()=>{
        const reading=parse(drawing());let inserted;
        const db={query:vi.fn(async(sql,args=[])=>{
            if(sql.includes('INSERT INTO floor_plan.processed_plan')){inserted=args;return {rows:[],rowCount:1};}
            if(sql.startsWith('SELECT model_hash,status'))return {rows:[{model_hash:inserted[9],status:'needs_review'}]};
            return {rows:[],rowCount:1};
        })};
        expect(await storeReading(db,task,reading)).toMatchObject({needsReview:1});
        expect(inserted.slice(3,7)).toEqual([null,null,'',null]);
        expect(JSON.parse(inserted[8]).building).toBeNull();
    });
});

describe('image extraction gate',()=>{
    it('keeps untriaged images pending and counts them separately from ready documents and plans',async()=>{
        const queries=[];
        const extractor=vi.fn(async()=>{throw new Error('No image should be extracted.');});
        const db={query:vi.fn(async(sql,args=[])=>{
            queries.push({sql,args});
            if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
            if(sql.includes('SELECT e.sha256,b.media_type,b.storage_path'))return {rows:[]};
            if(sql.includes('SELECT count(*) AS n'))return {rows:[{n:sql.includes('AND NOT (lower(b.media_type)')?2:0}]};
            return {rows:[]};
        })};
        const result=await processAssets(db,{extractor,log:()=>{}});
        expect(result).toMatchObject({selected:0,pending:0,awaitingImageClassification:2,status:'partial'});
        expect(extractor).not.toHaveBeenCalled();
        const selection=queries.find(({sql})=>sql.includes('SELECT e.sha256,b.media_type,b.storage_path')).sql;
        const readyCount=queries.find(({sql})=>sql.includes('SELECT count(*) AS n')&&!sql.includes('AND NOT (lower(b.media_type)')).sql;
        const awaitingCount=queries.find(({sql})=>sql.includes('AND NOT (lower(b.media_type)')).sql;
        for(const sql of [selection,readyCount,awaitingCount]) {
            expect(sql).toContain("image_target.image_classified_sha256=e.sha256");
            expect(sql).toContain("image_target.image_kind IN ('floor_plan','uncertain')");
            expect(sql).toContain("'listingOwned',true,'kind','floor-plan'");
        }
        expect(selection).toContain("lower(b.media_type) NOT LIKE 'image/%'");
        expect(awaitingCount).toContain('AND NOT (lower(b.media_type)');
    });
});
