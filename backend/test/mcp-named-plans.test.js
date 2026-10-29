// Check immutable named-plan composition, explicit selection and verified dependency publication.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createMcpNamedPlanTools } from '../agents/mcp-named-plans.js';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { appTurf as turf, intentDesign } from '../agents/mcp-geometry.js';
import { designObject, cidOfObject } from '../agents/agreement-objects.js';
const File = createRequire(import.meta.url)('../../frontend/js/plan-file.js');
const box = w => ({type:'Polygon',coordinates:[[[w,51.5],[w+.0005,51.5],[w+.0005,51.5005],[w,51.5005],[w,51.5]]]});
const view = {at:'51.501,-0.099,17',mode:'model',city:'london',language:'en',settings:{existing:'on'}};
function fixture() {
    const store=new Map(), plans=new Map(), refs=new Map(), calls=[];
    const build=(title,west,kind='building')=>{
        const local=intentDesign.build({kind,site:box(west),title,city:'london',floors:6,spaceKind:'park',algorithm:'equal',count:2,authoredAt:'2026-10-25T10:00:00.000Z'},{turf});
        return {...designObject({...local,createdAt:local.authoredAt}),parcelSourceId:`source-${title}`};
    };
    const tower=build('Tower',-.1), park=build('Park',-.099), other=build('Other',-.098), layout=build('Layout',-.097,'parcel-layout');
    const read={siteOfDesign:content=>content.site,
        getDesign:vi.fn(async({designCid})=>{
            if(!store.has(designCid))throw Object.assign(new Error('not found'),{code:'http-404'});
            return structuredClone(store.get(designCid));
        }),
        request:vi.fn(async(path,query,body)=>{
            calls.push(path);
            if(path==='/plans') {const cid=cidOfObject(body.content),row={cid,content:structuredClone(body.content)};plans.set(cid,row);return row;}
            if(path.startsWith('/plans/'))return structuredClone(plans.get(path.split('/').at(-1)));
            throw new Error(`Unexpected ground/agreement request: ${path}`);
        })};
    const resolveDraftReference=async ref=>structuredClone(refs.get(ref));
    const drafts=createMcpDraftTools({read,appOrigin:'https://app.example',resolveDraftReference});
    const publishDesign=vi.fn(async({design,parcelSourceId,confirm})=>{expect(confirm).toBe(true);const cid=cidOfObject(design);store.set(cid,{cid,content:design,parcelSourceId});return {cid};});
    const tools=createMcpNamedPlanTools({read,drafts,appOrigin:'https://app.example',resolveDraftReference,publishDesign});
    return {tools,read,store,plans,refs,calls,publishDesign,tower,park,other,layout};
}
describe('first-class named plans',()=>{
    it('opens, inspects and edits a portable plan with the browser validator and no publication', async () => {
        const { tools, tower, park, calls } = fixture();
        const draft = await tools.draftPlan({ title: 'Portable', designs: [tower, park], view });
        const ordered = [tower, park].sort((a,b) => a.cid.localeCompare(b.cid));
        const file = File.parse(JSON.stringify({ schema: File.SCHEMA, plan: draft.plan,
            designs: ordered.map(row => ({ cid: row.cid, content: row.content })),
            designSources: Object.fromEntries(ordered.map(row => [row.cid, { sourceId: row.parcelSourceId, snapshotId: null }])) }));
        const opened = await tools.getPlan({ plan: file });
        expect(opened.cid).toBe(draft.cid); expect(opened.publication).toBe('private');
        expect(opened.designs.map(row => row.parcelSourceId).sort()).toEqual(ordered.map(row => row.parcelSourceId).sort());
        const inventory = await tools.inspectPlan({ plan: file, filter: { kind: 'design' } });
        expect(inventory.items).toHaveLength(2);
        const revised = await tools.editPlan({ plan: file, expectedCid: draft.cid, title: 'Edited portable plan' });
        expect(revised.plan.title).toBe('Edited portable plan'); expect(file.plan.title).toBe('Portable'); expect(calls).toEqual([]);
        const bad = structuredClone(file); bad.designs[0].content.title = 'Tampered';
        await expect(tools.getPlan({ plan: bad })).rejects.toThrow(/CID/);
    });
    it.each([
        ['hr-cadastre', 'oss-wfs'],
        ['gb-hmlr-city-of-london', 'gb-hmlr-city-of-london']
    ])('retains exported source %s through MCP editing and publishes through %s', async (sourceId, gatewayId) => {
        const { tools, tower, publishDesign, calls } = fixture();
        const file = await File.create([{
            ...tower.content, createdAt: tower.content.authoredAt,
            binding: { parcelSource: { sourceId, snapshotId: 'release-1' } }
        }], { title: 'Portable source', view });
        const original = structuredClone(file);
        const opened = await tools.getPlan({ plan: file });
        expect(opened.designs[0]).toMatchObject({ cid: tower.cid, content: tower.content, parcelSourceId: gatewayId });
        const revised = await tools.editPlan({ plan: opened, expectedCid: opened.cid, title: 'Revised portable source' });
        expect(revised.designs[0].parcelSourceId).toBe(gatewayId);
        expect(calls).toEqual([]);
        const published = await tools.publishPlan({ plan: revised, expectedCid: revised.cid, confirm: true });
        expect(publishDesign).toHaveBeenCalledExactlyOnceWith({
            design: tower.content, parcelSourceId: gatewayId, expectedCid: tower.cid, confirm: true
        });
        expect(published.publication).toBe('published');
        expect(file).toEqual(original);
    });
    it('drafts plan/v1 without ground or agreement terms and preserves source metadata',async()=>{
        const {tools,tower,park,calls}=fixture();
        const result=await tools.draftPlan({title:' Riverside ',designs:[tower,park],view});
        expect(result.plan).toMatchObject({schema:'plan/v1',title:'Riverside',designCids:[tower.cid,park.cid].sort(),view});
        expect(result.plan).not.toHaveProperty('rule');expect(result.publication).toBe('private');expect(calls).toEqual([]);
        expect(result.draftArtifact.designSources).toEqual({[tower.cid]:tower.parcelSourceId,[park.cid]:park.parcelSourceId});
        const defaults=await tools.draftPlan({title:'Auto',designs:[tower]});expect(defaults.plan.view.mode).toBe('2d');
        expect(defaults.plan.view.at.split(',').map(Number)[0]).toBeCloseTo(51.50025);
    });
    it('revises title, membership and view atomically without changing the original snapshot',async()=>{
        const {tools,tower,park,other,calls}=fixture();
        const plan=await tools.draftPlan({title:'Before',designs:[tower,park],view}), before=structuredClone(plan);
        const next=await tools.editPlan({plan,expectedCid:plan.cid,title:'After',view:{...view,mode:'photo'},operations:[
            {type:'remove',ref:`design:${park.cid}`},{type:'replace',ref:`design:${tower.cid}`,design:other},{type:'add',design:park}]});
        expect(next.plan.designCids).toEqual([other.cid,park.cid].sort());expect(next.plan.title).toBe('After');expect(next.plan.view.mode).toBe('photo');
        expect(next.previousCid).toBe(plan.cid);expect(next.cid).not.toBe(plan.cid);expect(plan).toEqual(before);expect(calls).toEqual([]);
    });
    it('inventories explicit refs, text and spatial filters, geometry and pagination',async()=>{
        const {tools,tower,park}=fixture();const plan=await tools.draftPlan({title:'Inspect',designs:[tower,park],view});
        const found=await tools.inspectPlan({plan,filter:{kind:'building',text:'tower'},includeGeometry:true});
        expect(found.items).toHaveLength(1);expect(found.items[0]).toMatchObject({ref:`building:${tower.cid}:0`,path:'/geometry/buildings/0',floors:6});
        expect(found.items[0].geometry.type).toBe('Polygon');
        const east=await tools.inspectPlan({plan,filter:{kind:'design',relativeTo:{ref:`design:${tower.cid}`,direction:'east'}}});
        expect(east.items.map(row=>row.designCid)).toEqual([park.cid]);
        const page=await tools.inspectPlan({plan,limit:1});expect(page.total).toBe(4);expect(page.truncated).toBe(true);expect(page.items[0]).not.toHaveProperty('geometry');
    });
    it('uses canonical JSON edits and typed modifications without cadastral reads',async()=>{
        const {tools,tower,park,calls}=fixture();const plan=await tools.draftPlan({title:'Edit',designs:[tower,park],view});
        const next=await tools.editPlan({plan,expectedCid:plan.cid,operations:[
            {type:'modify',ref:`building:${tower.cid}:0`,changes:[{type:'set_floors',value:3}]},
            {type:'edit',ref:`design:${park.cid}`,edits:[{op:'replace',path:'/title',value:'Garden'}]}]});
        const modified=next.designs.find(row=>row.content.title==='Tower');
        expect(modified.content.geometry.buildings[0].properties).toMatchObject({floors:3,height:9});
        expect(modified.parcelSourceId).toBe(tower.parcelSourceId);expect(modified.content.origin).toEqual({cid:tower.cid});
        expect(next.designs.find(row=>row.content.title==='Garden')).toBeDefined();expect(tower.content.geometry.buildings[0].properties.floors).toBe(6);expect(calls).toEqual([]);
    });
    it('refuses stale revisions, ambiguous references, duplicates and old child references',async()=>{
        const {tools,tower,park,other}=fixture();const plan=await tools.draftPlan({title:'Stable',designs:[tower,park],view});
        await expect(tools.editPlan({plan,expectedCid:tower.cid,title:'Wrong'})).rejects.toMatchObject({code:'plan-revision-mismatch',currentCid:plan.cid,expectedCid:tower.cid,next:{tool:'ugt_inspect_plan',arguments:{plan}}});
        await expect(tools.publishPlan({plan,expectedCid:tower.cid,confirm:true})).rejects.toMatchObject({code:'plan-revision-mismatch',currentCid:plan.cid,next:{tool:'ugt_inspect_plan',arguments:{plan}}});
        await expect(tools.editPlan({plan,expectedCid:plan.cid,operations:[{type:'remove',ref:'Tower'}]})).rejects.toMatchObject({code:'selection-not-found'});
        await expect(tools.editPlan({plan,expectedCid:plan.cid,operations:[{type:'add',design:tower}]})).rejects.toMatchObject({code:'duplicate-design'});
        await expect(tools.editPlan({plan,expectedCid:plan.cid,operations:[{type:'replace',ref:`design:${tower.cid}`,design:other},{type:'modify',ref:`building:${tower.cid}:0`,changes:[{type:'set_floors',value:2}]}]})).rejects.toMatchObject({code:'selection-changed'});
        expect((await tools.inspectPlan({plan,filter:{kind:'design'}})).items).toHaveLength(2);
    });
    it('retrieves published /plans links and private references with CID checks',async()=>{
        const {tools,tower,store,plans,refs}=fixture();const plan=await tools.draftPlan({title:'Stored',designs:[tower],view});
        store.set(tower.cid,tower);plans.set(plan.cid,{cid:plan.cid,content:plan.plan});
        expect(await tools.getPlan({plan:`https://app.example/plans/${plan.cid}`})).toMatchObject({cid:plan.cid,plan:plan.plan,publication:'published',url:`https://app.example/plans/${plan.cid}`});
        expect(await tools.getPlan({plan:{untrusted:{content:plan.plan}}})).toMatchObject({cid:plan.cid,plan:plan.plan,publication:'private'});
        refs.set('https://mcp.example/mcp/previews/private',plan.draftArtifact);
        expect((await tools.getPlan({plan:'https://mcp.example/mcp/previews/private'})).designs[0].parcelSourceId).toBe(tower.parcelSourceId);
        await expect(tools.getPlan({plan:{...plan,cid:tower.cid}})).rejects.toMatchObject({code:'cid-mismatch'});
        plans.set(plan.cid,{cid:plan.cid,content:{...plan.plan,title:'Tampered'}});
        await expect(tools.getPlan({plan:plan.cid})).rejects.toMatchObject({code:'cid-mismatch'});
    });
    it('publishes dependencies with exact source metadata, then confirms plan readback',async()=>{
        const {tools,tower,park,store,publishDesign,calls,read}=fixture();const plan=await tools.draftPlan({title:'Publish',designs:[tower,park],view});store.set(park.cid,park);
        const result=await tools.publishPlan({plan,expectedCid:plan.cid,confirm:true});
        expect(publishDesign).toHaveBeenCalledTimes(1);expect(publishDesign).toHaveBeenCalledWith({design:tower.content,parcelSourceId:tower.parcelSourceId,expectedCid:tower.cid,confirm:true});
        expect(result).toMatchObject({cid:plan.cid,publication:'published',publishedDesignCids:[tower.cid],url:`https://app.example/plans/${plan.cid}`});expect(calls).toEqual([`/plans/${plan.cid}`,'/plans',`/plans/${plan.cid}`]);
        read.request.mockImplementationOnce(async()=>{throw Object.assign(new Error('missing'),{code:'http-404'});}).mockImplementationOnce(async()=>({cid:plan.cid,content:plan.plan})).mockImplementationOnce(async()=>({cid:plan.cid,content:{...plan.plan,title:'Wrong'}}));
        await expect(tools.publishPlan({plan,expectedCid:plan.cid,confirm:true})).rejects.toMatchObject({code:'cid-mismatch'});
    });
    it('requires confirmation and exact revision, and publishes a parcel layout member like any design',async()=>{
        const {tools,tower,layout,publishDesign}=fixture();const plan=await tools.draftPlan({title:'Layout',designs:[tower,layout],view});
        await expect(tools.publishPlan({plan,expectedCid:plan.cid,confirm:false})).rejects.toMatchObject({code:'confirmation-required'});
        await expect(tools.publishPlan({plan,expectedCid:tower.cid,confirm:true})).rejects.toMatchObject({code:'plan-revision-mismatch'});
        expect(publishDesign).not.toHaveBeenCalled();
        await tools.publishPlan({plan,expectedCid:plan.cid,confirm:true}).catch(()=>null);
        expect(publishDesign).toHaveBeenCalledWith({design:layout.content,parcelSourceId:layout.parcelSourceId||null,expectedCid:layout.cid,confirm:true});
    });
    it('schedules construction windows that follow revised designs and open previews at a month',async()=>{
        const {tools,tower,park,other}=fixture();
        const plan=await tools.draftPlan({title:'Phased',designs:[tower,park],view,schedule:{[tower.cid]:{start:'2027-03',end:'2028-10'}},when:'2027-06'});
        expect(plan.plan.schedule).toEqual({[tower.cid]:{start:'2027-03',end:'2028-10'}});
        expect(plan.draftArtifact.when).toBe('2027-06');
        const simulated=await tools.getPlan({plan,buildout:'seed-1',when:'2027-02'});
        expect(simulated.draftArtifact).toMatchObject({when:'2027-02',buildout:'seed-1'});
        const unscheduled=await tools.draftPlan({title:'Phased',designs:[tower,park],view});
        expect(unscheduled.plan).not.toHaveProperty('schedule');expect(unscheduled.cid).not.toBe(plan.cid);
        const inventory=await tools.inspectPlan({plan,filter:{kind:'design'}});
        expect(inventory.schedule).toEqual(plan.plan.schedule);
        expect(inventory.items.find(item=>item.designCid===tower.cid).construction).toEqual({start:'2027-03',end:'2028-10'});
        expect(inventory.items.find(item=>item.designCid===park.cid).construction).toBeNull();
        // The tower's window follows its revision; the park gets one by ref; a removed member's window goes.
        const next=await tools.editPlan({plan,expectedCid:plan.cid,operations:[
            {type:'modify',ref:`building:${tower.cid}:0`,changes:[{type:'set_floors',value:3}]},{type:'add',design:other}],
            schedule:{[`design:${park.cid}`]:{start:'2029-01',end:'2029-06'},[other.cid]:{start:'2030-01',end:'2030-02'}}});
        const revised=next.designs.find(row=>row.content.title==='Tower').cid;
        expect(next.plan.schedule).toEqual({[revised]:{start:'2027-03',end:'2028-10'},[park.cid]:{start:'2029-01',end:'2029-06'},[other.cid]:{start:'2030-01',end:'2030-02'}});
        const cleared=await tools.editPlan({plan:next,expectedCid:next.cid,operations:[{type:'remove',ref:`design:${other.cid}`}],schedule:{[park.cid]:null}});
        expect(cleared.plan.schedule).toEqual({[revised]:{start:'2027-03',end:'2028-10'}});
        await expect(tools.editPlan({plan:cleared,expectedCid:cleared.cid,schedule:{[other.cid]:{start:'2030-01',end:'2030-02'}}})).rejects.toMatchObject({code:'schedule-member-not-found'});
        await expect(tools.editPlan({plan:cleared,expectedCid:cleared.cid,schedule:{[park.cid]:{start:'2030-05',end:'2030-01'}}})).rejects.toMatchObject({code:'invalid-plan'});
    });
});
