import { describe, expect, it } from 'vitest';
import { createTestPreviewLinks as createPreviewLinks } from './helpers/mcp-preview-store.js';
import { appTurf as turf, intentDesign } from '../agents/mcp-geometry.js';
import { editedDesign, patchDocument } from '../agents/mcp-edit.js';
import { cidOfObject } from '../cid.js';
import { validateDesignContent } from '../routes/designs.js';
const site = { type:'Polygon', coordinates:[[[-0.1,51.5],[-0.098,51.5],[-0.098,51.502],[-0.1,51.502],[-0.1,51.5]]] };
const common = { site, city:'london', title:'Test design', authoredAt:'2026-10-24T00:00:00.000Z' };
const make = (kind, extra={}) => intentDesign.build({ ...common, kind, ...extra }, { turf });
const edit = (design, edits) => editedDesign(design, cidOfObject(design), edits);

describe('granular authored editing', () => {
    it('changes one height, keeps floor count consistent, preserves the source and round-trips the exact private artifact', async () => {
        const design=make('building',{floors:12,coverage:.2}), before=structuredClone(design);
        design.geometry.buildings.push(structuredClone(design.geometry.buildings[0]));
        const next=edit(design,[{op:'replace',path:'/geometry/buildings/0/properties/height',value:18}]);
        expect(next.geometry.buildings[0].properties).toMatchObject({height:18,floors:6});
        expect(next.geometry.buildings[1]).toEqual(before.geometry.buildings[0]);
        expect(design.geometry.buildings[0].properties.height).toBe(36);
        expect(next.origin.cid).toBe(cidOfObject(design));
        const store=createPreviewLinks({origin:'https://mcp.example',appOrigin:'https://app.example'});
        const preview=store.create({design:next});
        expect((await store.resolve(preview.draftRef)).design).toEqual(next);
        expect(validateDesignContent(next).ok).toBe(true);
    });
    it('copies, transforms and removes individual buildings without copying the whole record through the client', () => {
        const design=make('building',{floors:4,coverage:.05});
        const next=edit(design,[{op:'copy',from:'/geometry/buildings/0',path:'/geometry/buildings/-'},
            {op:'transform',path:'/geometry/buildings/1/geometry',eastM:30,degrees:30},
            {op:'replace',path:'/geometry/buildings/1/properties/floors',value:3}]);
        expect(next.geometry.buildings).toHaveLength(2);
        expect(next.geometry.buildings[0]).toEqual(design.geometry.buildings[0]);
        expect(turf.centroid(next.geometry.buildings[1]).geometry.coordinates[0]).toBeGreaterThan(turf.centroid(design.geometry.buildings[0]).geometry.coordinates[0]);
        expect(next.geometry.buildings[1].properties).toMatchObject({floors:3,height:9});
        expect(turf.area(next.geometry.buildings[1])).toBeCloseTo(turf.area(design.geometry.buildings[0]),1);
        expect(edit(next,[{op:'remove',path:'/geometry/buildings/0'}]).geometry.buildings).toHaveLength(1);
    });
    it('moves only a freeform footprint while retaining ground and furniture, and edits land take independently', () => {
        const design=make('building',{floors:4,coverage:.05});
        const body=design.geometry.buildings[0];
        design.geometry.groundBoundary=turf.feature(structuredClone(site));
        design.geometry.groundSurface={treatment:'green',polygon:turf.difference(turf.feature(site),body).geometry,
            decorationDesign:{trees:[{coordinate:[-.099,51.501],kind:'broadleaf',heightM:8}]}};
        design.geometry.landTake={geometry:structuredClone(body.geometry)};
        const before=structuredClone(design);
        const next=edit(design,[{op:'transform',path:'/geometry/buildings/0/geometry',eastM:5},
            {op:'replace',path:'/geometry/landTake/geometry',value:structuredClone(site)}]);
        expect(next.geometry.buildings[0].geometry).not.toEqual(body.geometry);
        expect(next.geometry.groundBoundary).toEqual(design.geometry.groundBoundary);
        expect(next.geometry.groundSurface.decorationDesign).toEqual(design.geometry.groundSurface.decorationDesign);
        expect(turf.bbox(next.geometry.groundSurface.polygon)).toEqual(turf.bbox(site));
        expect(next.geometry.landTake.geometry).toEqual(site);
        expect(design).toEqual(before);
    });
    it('a footprint-only land-take edit removes surrounding ground and furniture', () => {
        const design=make('building',{floors:4,coverage:.05});
        const body=design.geometry.buildings[0];
        design.geometry.landTake=turf.feature(structuredClone(site));
        design.geometry.groundBoundary=turf.feature(structuredClone(site));
        design.geometry.groundSurface={treatment:'green',polygon:turf.difference(turf.feature(site),body).geometry,
            decorationDesign:{trees:[{coordinate:[-.099,51.501],kind:'broadleaf',heightM:8}]}};
        const before=structuredClone(design);
        const next=edit(design,[{op:'replace',path:'/geometry/landTake',value:body}]);
        expect(next.geometry.groundSurface).toBeNull();
        expect(next.geometry.buildings).toEqual(design.geometry.buildings);
        expect(next.geometry.landTake).toEqual(body);
        expect(design).toEqual(before);
        expect(validateDesignContent(next).ok).toBe(true);
    });
    it('rejects stale revisions, failed tests, invalid pointers and prototype pollution atomically', () => {
        const design=make('building',{floors:4}), before=structuredClone(design);
        expect(()=>editedDesign(design,cidOfObject({wrong:true}),[{op:'replace',path:'/title',value:'Changed'}])).toThrow(/revision/);
        expect(()=>edit(design,[{op:'replace',path:'/title',value:'Changed'},{op:'test',path:'/title',value:'Other'}])).toThrow(/test/);
        for(const path of ['/__proto__/polluted','/geometry/constructor/prototype','/schema','/origin','/authoredAt']) expect(()=>edit(design,[{op:'add',path,value:'bad'}])).toThrow();
        expect(()=>edit(design,[{op:'remove',path:'/geometry/buildings/4'}])).toThrow(/index/i);
        expect(design).toEqual(before); expect({}.polluted).toBeUndefined();
        expect(patchDocument({ value:{ a:1,b:2 } },[{op:'test',path:'/value',value:{b:2,a:1}}])).toEqual({value:{a:1,b:2}});
    });
    it('edits arbitrary authored properties and names containing JSON Pointer escapes', () => {
        const design=make('building',{floors:4});
        const next=edit(design,[{op:'add',path:'/geometry/buildings/0/properties/facade~1finish',value:'brick'},
            {op:'add',path:'/geometry/buildings/0/properties/roof',value:{material:'tile',color:'#995544'}},
            {op:'replace',path:'/title',value:'Courtyard homes'}]);
        expect(next.geometry.buildings[0].properties['facade/finish']).toBe('brick');
        expect(next.geometry.buildings[0].properties.roof.material).toBe('tile'); expect(next.title).toBe('Courtyard homes');
    });
    it('updates canonical road nodes and rebuilds their footprint/site', () => {
        const design=make('road',{points:[[-.1,51.5],[-.099,51.5]],preset:'1+1'});
        const next=edit(design,[{op:'replace',path:'/roadProposal/definition/osm/elements/1/lat',value:51.5002}]);
        expect(next.site).not.toEqual(design.site);
        expect(next.site).toEqual(next.roadProposal.definition.polygon);
        expect(next.roadProposal.definition.osm.elements.find(e=>e.type==='node'&&e.id===-2).lat).toBe(51.5002);
        expect(()=>edit(design,[{op:'remove',path:'/roadProposal/definition/osm/elements/0'}])).toThrow(/nodes/);
        expect(()=>edit(design,[{op:'transform',path:'/roadProposal/definition/polygon',eastM:1}])).toThrow(/derived/);
    });
    it('prepares a new construction frame when canonical road nodes move to another city', () => {
        const design=make('road',{points:[[-.1,51.5],[-.099,51.5]],preset:'1+1'}), before=structuredClone(design);
        const next=edit(design,[
            {op:'replace',path:'/roadProposal/definition/osm/elements/0/lon',value:78.474},
            {op:'replace',path:'/roadProposal/definition/osm/elements/0/lat',value:17.36},
            {op:'replace',path:'/roadProposal/definition/osm/elements/1/lon',value:78.475},
            {op:'replace',path:'/roadProposal/definition/osm/elements/1/lat',value:17.361}
        ]);
        expect(next.roadProposal.definition.constructionFrame.anchor).toEqual([78.4745,17.3605]);
        expect(next.site).toEqual(next.roadProposal.definition.polygon);
        expect(validateDesignContent(next).ok).toBe(true);
        expect(next.origin.cid).toBe(cidOfObject(design));
        expect(design).toEqual(before);
    });
    it('patches park trees, paths and furniture while preserving other authored decorations', () => {
        const design=make('space',{spaceKind:'park',treeCount:5}), saved=structuredClone(design.structureProposal.decorationDesign);
        const next=edit(design,[{op:'copy',from:'/structureProposal/decorationDesign/trees/0',path:'/structureProposal/decorationDesign/trees/-'},
            {op:'transform',path:'/structureProposal/decorationDesign/trees/5/coordinate',eastM:5},
            {op:'add',path:'/structureProposal/decorationDesign/benches/-',value:{coordinate:[-.099,51.501],bearing:90}},
            {op:'add',path:'/structureProposal/decorationDesign/paths/-',value:[[-.0995,51.5005],[-.0985,51.5015]]}]);
        expect(next.structureProposal.decorationDesign.trees.slice(0,5)).toEqual(saved.trees);
        expect(next.structureProposal.decorationDesign.trees).toHaveLength(6);
        expect(next.structureProposal.decorationDesign.benches).toHaveLength(1);
        expect(next.structureProposal.decorationDesign.paths).toHaveLength(1);
        expect(()=>edit(design,[{op:'add',path:'/structureProposal/decorations',value:{trees:[]}}])).toThrow(/runtime|noncanonical/);
    });
    it('moves a shared plot boundary with granular vertex edits and rejects gaps or overlap', () => {
        const design=make('parcel-layout',{algorithm:'equal',count:2});
        const shifted=structuredClone(design.parcelLayout.plots);
        // Move a shared interior longitude on both plots, leaving the outer site boundary intact.
        const all=shifted.flatMap(p=>p.geometry.coordinates.flat());
        const interior=all.find(p=>p[0]>-.1+1e-7&&p[0]<-.098-1e-7);
        expect(interior).toBeDefined();
        const x=interior[0];for(const p of all)if(Math.abs(p[0]-x)<1e-10)p[0]+=0.00005;
        const next=edit(design,[{op:'replace',path:'/parcelLayout/plots',value:shifted}]);
        expect(next.parcelLayout.plots).toEqual(shifted);
        expect(()=>edit(design,[{op:'remove',path:'/parcelLayout/plots/0'}])).toThrow(/uncovered|cover|pool/i);
    });
    it('refuses malformed polygons and silently stale coupled geometry', () => {
        const design=make('building',{floors:4});
        expect(()=>edit(design,[{op:'replace',path:'/geometry/buildings/0/geometry/coordinates/0/1',value:[NaN,51]}])).toThrow();
        expect(()=>edit(design,[{op:'add',path:'/geometry/buildings/0/properties/minFootprint',value:{type:'Polygon',coordinates:[]}}])).toThrow();
        expect(()=>edit(design,[{op:'add',path:'/buildingProposal/parameters/width',value:30}])).toThrow(/geometry/);
        design.geometry.blockMassing={...structuredClone(design.geometry.buildings[0]),properties:{massing:true}};
        expect(()=>edit(design,[{op:'transform',path:'/geometry/buildings/0/geometry',degrees:10}])).toThrow(/blockMassing/);
    });
    it('cuts and buffers polygons using existing geometry rather than invented coordinates', () => {
        const design=make('building',{floors:4,coverage:.1});
        const next=edit(design,[{op:'copy',from:'/site',path:'/geometry/landTake'},{op:'difference',path:'/geometry/landTake',from:'/geometry/buildings/0/geometry'}]);
        expect(turf.area(turf.feature(next.geometry.landTake))).toBeCloseTo(turf.area(turf.feature(site))-turf.area(design.geometry.buildings[0]),2);
        expect(edit(design,[{op:'buffer',path:'/geometry/buildings/0/geometry',metres:1}]).geometry.buildings[0].geometry).not.toEqual(design.geometry.buildings[0].geometry);
    });
    it('refuses missing drawings and mismatched goals instead of returning an invisible design', () => {
        const road=make('road',{points:[[-.1,51.5],[-.099,51.5]],preset:'1+1'});
        for (const path of ['/roadProposal/definition','/roadProposal/definition/osm']) expect(()=>edit(road,[{op:'remove',path}])).toThrow(/canonical/);
        const park=make('space',{spaceKind:'park'});
        expect(()=>edit(park,[{op:'remove',path:'/structureProposal/geometry'}])).toThrow(/geometry/);
        expect(()=>edit(park,[{op:'replace',path:'/goal',value:'single'}])).toThrow(/buildingProposal/);
        expect(()=>edit(park,[{op:'replace',path:'/goal',value:'unknown'}])).toThrow(/supported/);
    });
    it('keeps rule edits, rendered dimensions and provenance in agreement', () => {
        const row=make('urban-rule',{rule:{typology:'row',floors:3}});
        const next=edit(row,[{op:'replace',path:'/buildingProposal/parameters/rule/maxHeightM',value:15}]);
        const p=next.geometry.buildings[0].properties;
        expect(p).toMatchObject({height:15,floors:5,urbanRule:{maxHeightM:15,minHeightM:15}});
        expect(p.ruleProvenance.definition).toEqual(p.urbanRule);
        expect(next.buildingProposal.parameters.rule).toEqual(p.urbanRule);
        const shorter=edit(next,[{op:'replace',path:'/geometry/buildings/0/properties/urbanRule/maxHeightM',value:6}]);
        expect(shorter.geometry.buildings[0].properties).toMatchObject({height:6,floors:2});
        expect(shorter.buildingProposal.parameters.rule.maxHeightM).toBe(6);
        expect(()=>edit(row,[{op:'replace',path:'/buildingProposal/parameters/rule/minPlotAreaM2',value:500}])).toThrow(/geometry/);
    });
    it('refuses tree looks the renderer would silently replace or clamp', () => {
        const park=make('space',{spaceKind:'park',treeCount:2});
        expect(()=>edit(park,[{op:'replace',path:'/structureProposal/decorationDesign/trees/0/kind',value:'unknown'}])).toThrow(/tree/);
        expect(()=>edit(park,[{op:'replace',path:'/structureProposal/decorationDesign/trees/0/heightM',value:500}])).toThrow(/heightM/);
        const next=edit(park,[{op:'replace',path:'/structureProposal/decorationDesign/trees/0/kind',value:'conifer'}, {op:'replace',path:'/structureProposal/decorationDesign/trees/0/heightM',value:12}]);
        expect(next.structureProposal.decorationDesign.trees[0]).toMatchObject({kind:'conifer',heightM:12});
    });
});

describe('small authoring conveniences use real stored geometry',()=>{
    it('keeps floors and height synchronized and rotates one footprint',()=>{
        const design=make('building',{floors:12,coverage:.1});
        const next=intentDesign.modify(design,[{type:'set_floors',value:3},{type:'rotate',degrees:20}],{turf});
        expect(next.geometry.buildings[0].properties).toMatchObject({floors:3,height:9});
        expect(next.geometry.buildings[0].geometry).not.toEqual(design.geometry.buildings[0].geometry);
    });
    it('adds exactly the requested trees while retaining existing planting',()=>{
        const design=make('space',{spaceKind:'park',treeCount:5});
        const next=intentDesign.modify(design,[{type:'add_trees',count:20}],{turf});
        expect(next.structureProposal.decorationDesign.trees).toHaveLength(25);
        expect(next.structureProposal.decorationDesign.trees.slice(0,5)).toEqual(design.structureProposal.decorationDesign.trees);
    });
    it('drafts visible three-storey row envelopes through the shared rule renderer',()=>{
        const design=make('urban-rule',{rule:{typology:'row',floors:3}});
        expect(design.goal).toBe('row'); expect(design.geometry.buildings).toHaveLength(1);
        expect(design.geometry.buildings[0].properties).toMatchObject({floors:3,height:9,urbanRule:{kind:'exact',typology:'row',maxHeightM:9}});
        expect(validateDesignContent(design).ok).toBe(true);
    });
});
