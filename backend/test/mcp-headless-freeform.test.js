// Exercise browser-free freeform authoring and edits against the canonical MCP design contract.
import { describe, expect, it } from 'vitest';
import { appTurf as turf, intentDesign } from '../agents/mcp-geometry.js';
import { buildTypedDesign } from '../agents/mcp-constructors.js';
import { deriveWithApp } from '../agents/mcp-ground-runtime.js';
import { cidOfObject } from '../cid.js';
const site={type:'Polygon',coordinates:[[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]]};
const parcel={type:'Feature',id:'A',properties:{parcelId:'A'},geometry:site};
describe('headless Freeform ground after later roads',()=>{
    it.each([false,true])('resolves effective material and reviewed take without changing authored geometry (reviewed take: %s)',async reviewed=>{
        const building=buildTypedDesign({kind:'building',typology:'freeform',site,authoredAt:'2020-01-01T00:00:00.000Z'});
        if(reviewed)building.geometry.landTake={geometry:turf.buffer(building.geometry.buildings[0],3,{units:'meters'}).geometry};
        const road=intentDesign.build({kind:'road',points:[[15.0001,45.0005],[15.0009,45.0005]],authoredAt:'2021-01-01T00:00:00.000Z'},{turf});
        const originals=JSON.stringify([building,road]);
        const rows=[building,road].map(content=>({cid:cidOfObject(content),content,parcelIds:['A']}));
        const ground=await deriveWithApp({designs:rows,parcels:[parcel]});
        const authoredTake=reviewed?building.geometry.landTake.geometry:building.geometry.buildings[0].geometry;
        const formed=ground.outputs.filter(piece=>{
            if(piece.producedBy!==rows[0].cid)return false;
            const outside=turf.difference(turf.feature(piece.geometry),turf.feature(authoredTake));
            return !outside || turf.area(outside)<0.01;
        });
        expect(formed.length).toBeGreaterThan(0);
        expect(formed.reduce((sum,piece)=>sum+piece.areaM2,0)).toBeLessThan(turf.area(turf.feature(authoredTake)));
        for(const piece of formed){const overlap=turf.intersect(turf.feature(piece.geometry),turf.feature(road.roadProposal.definition.polygon));expect(overlap?turf.area(overlap):0).toBeLessThan(0.01);}
        expect(ground.outputs.reduce((sum,piece)=>sum+piece.areaM2,0)).toBeCloseTo(turf.area(parcel),1);
        expect(JSON.stringify([building,road])).toBe(originals);
    });
});
