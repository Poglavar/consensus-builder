// Public API consumer behavior: plan identity, unknown locations, source provenance and bounded paging.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const { catalogueView, planView, readCatalogue, API_ROOT }=createRequire(import.meta.url)('../../frontend/js/published-floor-plans.js');
const hash='a'.repeat(64);
const plan=(id,extra={})=>({id,label:`Plan ${id}`,scope:'floor',buildingId:null,building:null,location:null,
    source:{sha256:hash,url:'https://example.test/drawing.pdf',mediaType:'application/pdf',page:2,attribution:'Original architect'},...extra});
describe('shared published floor plans in the archive viewer',()=>{
    it('keeps unknown-building plans separate and does not invent a location or whole-building model',()=>{
        const result=catalogueView([plan('one'),plan('two')]);
        expect(result.buildings.map(b=>b.id)).toEqual(['plan:one','plan:two']);
        for(const building of result.buildings){expect(building.location).toBeNull();expect(building.wholeBuilding).toBeNull();expect(building.wholeBuildingAvailable).toBe(false);}
        expect(result.counts).toMatchObject({floors:2,units:0});
    });
    it('groups known publication IDs without inferring apartments from floor drawings or exterior geometry',()=>{
        const building={id:'project',label:'Project',location:{lng:0,lat:0},footprint:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]}};
        const result=catalogueView([plan('typical',{buildingId:'project',building,levels:[1,2,3]}),plan('unit',{buildingId:'project',building,scope:'unit',unitId:'U2'})]);
        expect(result.buildings).toHaveLength(1);expect(result.buildings[0].planCount).toBe(2);
        expect(result.buildings[0].location).toEqual({longitude:0,latitude:0,basis:'published-source'});
        expect(result.buildings[0].wholeBuilding).toBeNull();expect(result.counts).toMatchObject({floors:1,units:1});
        expect(result.buildings[0].plans[0].levels).toEqual([1,2,3]);
    });
    it('uses shared source URLs and room schedules rather than collector bytes, tasks or numeric room count',()=>{
        const result=planView(plan('unit',{scope:'unit',rooms:3,physicalNetAreaM2:0,marketedAreaM2:45,roomSchedule:[{label:'Kitchen',areaM2:12},{name:'Hall',areaM2:null}],
            source:{sha256:hash,url:'https://example.test/plan.pdf',urls:['https://example.test/project','javascript:bad'],page:2,label:'Sheet 2',attribution:'Architect'}}));
        expect(result.rooms).toEqual([{name:'Kitchen',areaM2:12},{name:'Hall',areaM2:null}]);
        expect(result.sourceAssetUrl).toBe(`${API_ROOT}/floor-plans/sources/${hash}`);expect(result.source.attribution).toBe('Architect');
        expect(result.source.urls).toEqual(['https://example.test/project']);expect(result.areaM2).toBe(45);expect(result.physicalNetAreaM2).toBe(0);
        expect(result).not.toHaveProperty('processing');expect(result).not.toHaveProperty('archivedSha256');
    });
    it('retains public identity and review warnings when location changes',()=>{
        const original=plan('stable',{quality:{status:'needs_review',issues:['Scale estimated']}});
        const before=planView(original),after=planView({...original,location:{lng:1,lat:2}});
        expect(after.id).toBe(before.id);expect(after.reviewNotes).toEqual(['Scale estimated']);expect(after.reviewStatus).toBe('needs_review');
        expect(catalogueView([plan('bad',{location:{lng:null,lat:0}})]).buildings[0].location).toBeNull();
    });
    it('loads ordered pages through the shared endpoint without using a private building catalogue',async()=>{
        const calls=[];
        const result=await readCatalogue(async url=>{calls.push(url);const offset=Number(new URL(url).searchParams.get('offset'));return {plans:offset===0?Array.from({length:100},(_,i)=>plan(`p${i}`)):[plan('last')],limit:100,offset,hasMore:offset===0};});
        expect(calls).toEqual([`${API_ROOT}/floor-plans?limit=100&offset=0`,`${API_ROOT}/floor-plans?limit=100&offset=100`]);
        expect(result.buildings).toHaveLength(101);
    });
    it('fails on incomplete pagination, duplicate identities and limits instead of showing a partial catalogue',async()=>{
        await expect(readCatalogue(async()=>({plans:[],limit:100,offset:0,hasMore:true}))).rejects.toThrow('Invalid');
        await expect(readCatalogue(async()=>({plans:Array.from({length:100},(_,i)=>plan(`p${i}`)),limit:100,offset:0,hasMore:true}),{maxPages:1})).rejects.toThrow('page limit');
        expect(()=>catalogueView([plan('duplicate'),plan('duplicate')])).toThrow('Duplicate');
        await expect(readCatalogue(async()=>{throw new Error('HTTP 503');})).rejects.toThrow('HTTP 503');
    });
});
