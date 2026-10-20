// Bounded OSM context validates geometry and refuses incomplete source responses.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupEstimateContextRoute, overpassContextToGeoJSON } from '../parcels/estimate-context.js';

const box = '0,0,0.001,0.001';
const ring = (id, x, y, dx, dy) => ({ type: 'way', id, tags: { building: 'yes' }, geometry: [
    { lon:x,lat:y }, {lon:x+dx,lat:y}, {lon:x+dx,lat:y+dy}, {lon:x,lat:y+dy}, {lon:x,lat:y}
] });
function appFor(fetchContext) { const app = express(); setupEstimateContextRoute(app, { fetchContext }); return app; }

describe('parcel estimate context route', () => {
    it('rejects malformed and oversized boxes before fetching', async () => {
        const fetchContext = vi.fn(); const app = appFor(fetchContext);
        expect((await request(app).get('/parcel-estimate/context').query({ bbox:'bad',crs:'EPSG:4326' })).status).toBe(400);
        expect((await request(app).get('/parcel-estimate/context').query({ bbox:'0,,0.001,0.001',crs:'EPSG:4326' })).status).toBe(400);
        expect((await request(app).get('/parcel-estimate/context').query({ bbox:'0,0,0.03,0.03',crs:'EPSG:4326' })).status).toBe(400);
        expect((await request(app).get('/parcel-estimate/context').query({ bbox:box,crs:'EPSG:3857' })).status).toBe(400);
        expect(fetchContext).not.toHaveBeenCalled();
    });
    it('accepts bounded landscape and portrait viewports larger than the fixed squares', async () => {
        const fetchContext = vi.fn(async () => ({ features: [] })), app = appFor(fetchContext);
        for (const bbox of ['0,0,0.017,0.009', '0,0,0.009,0.017']) {
            expect((await request(app).get('/parcel-estimate/context').query({ bbox, crs:'EPSG:4326' })).status).toBe(200);
        }
        expect(fetchContext).toHaveBeenCalledTimes(2);
    });
    it('returns standard GeoJSON and rejects partial or failed upstream context', async () => {
        const app = appFor(async () => ({ type:'FeatureCollection', features:[{type:'Feature',id:'w1',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},properties:{kind:'road',source_id:'w1'}}] }));
        const ok = await request(app).get('/parcel-estimate/context').query({ bbox:box,crs:'EPSG:4326' });
        expect(ok.status).toBe(200); expect(ok.body.features[0].properties.kind).toBe('road');
        const partialApp = appFor(async () => ({ features:[],partial:true }));
        expect((await request(partialApp).get('/parcel-estimate/context').query({bbox:box,crs:'EPSG:4326'})).status).toBe(502);
        const failedApp = appFor(async () => { throw new Error('upstream'); });
        expect((await request(failedApp).get('/parcel-estimate/context').query({bbox:box,crs:'EPSG:4326'})).status).toBe(502);
    });
    it('preserves road tags and full building and water relation rings with holes', () => {
        const outer = ring(10,0,0,2,2).geometry, inner = ring(11,.5,.5,.5,.5).geometry;
        const result = overpassContextToGeoJSON([
            {type:'way',id:1,tags:{highway:'primary',width:'8 m',bridge:'yes',tunnel:'no'},geometry:[{lon:0,lat:0},{lon:1,lat:1}]},
            ring(2,0,0,1,1),
            {type:'relation',id:3,tags:{natural:'water',type:'multipolygon'},members:[{type:'way',role:'outer',geometry:outer},{type:'way',role:'inner',geometry:inner}]}
        ]);
        expect(result.features[0].properties).toMatchObject({kind:'road',highway:'primary',width_m:8,bridge:true,tunnel:false});
        expect(result.features[1].geometry.coordinates[0]).toHaveLength(5);
        expect(result.features[2].geometry.coordinates).toHaveLength(2);
        expect(result.features[2].geometry.coordinates[1]).toHaveLength(5);
    });
    it('fails closed for an incomplete multipolygon relation', () => {
        expect(() => overpassContextToGeoJSON([{type:'relation',id:4,tags:{building:'yes'},members:[{type:'way',role:'outer',geometry:[{lon:0,lat:0},{lon:1,lat:1}]}]}])).toThrow(/incomplete ring/);
    });
    it('rejects a successful HTTP response carrying an Overpass timeout or a malformed line', () => {
        expect(() => overpassContextToGeoJSON([], 5000, { remark: 'runtime error: timeout' })).toThrow(/incomplete/);
        expect(() => overpassContextToGeoJSON(undefined)).toThrow(/incomplete/);
        expect(() => overpassContextToGeoJSON([{ type: 'way', id: 1, tags: { highway: 'service' },
            geometry: [{ lon: 0, lat: 0 }, { lat: 1 }, { lon: 2, lat: 2 }] }])).toThrow(/incomplete/);
    });
    it('assigns holes to their containing outer and fails incomplete outer or inner members', () => {
        const outerA=ring(20,0,0,2,2).geometry, outerB=ring(21,10,10,2,2).geometry;
        const holeB=ring(22,10.5,10.5,.5,.5).geometry;
        const relation={type:'relation',id:5,tags:{natural:'water'},members:[
            {type:'way',ref:20,role:'outer',geometry:outerA},{type:'way',ref:21,role:'outer',geometry:outerB},{type:'way',ref:22,role:'inner',geometry:holeB}
        ]};
        const fc=overpassContextToGeoJSON([relation]);
        expect(fc.features[0].geometry.type).toBe('MultiPolygon');
        expect(fc.features[0].geometry.coordinates[0]).toHaveLength(1);
        expect(fc.features[0].geometry.coordinates[1]).toHaveLength(2);
        expect(() => overpassContextToGeoJSON([{...relation,members:[...relation.members,{type:'way',role:'outer',geometry:[{lon:30,lat:30},{lon:31,lat:31}]}]}])).toThrow(/incomplete ring/);
        expect(() => overpassContextToGeoJSON([{...relation,members:[...relation.members,{type:'way',role:'inner',geometry:[{lon:30,lat:30},{lon:31,lat:31}]}]}])).toThrow(/incomplete ring/);
        expect(() => overpassContextToGeoJSON([{...relation,members:[{type:'way',role:'outer',geometry:[{lon:0,lat:0},{lat:1},{lon:1,lat:1}]}]}])).toThrow(/malformed way member/);
    });
    it('emits waterways and suppresses relation member ways and false bridge tags', () => {
        const fc=overpassContextToGeoJSON([
            {type:'way',id:8,tags:{building:'yes'},geometry:ring(8,0,0,1,1).geometry},
            {type:'relation',id:9,tags:{building:'yes'},members:[{type:'way',ref:8,role:'outer',geometry:ring(8,0,0,1,1).geometry}]},
            {type:'way',id:10,tags:{waterway:'stream',width:'3.5',bridge:'false',tunnel:'0'},geometry:[{lon:0,lat:0},{lon:1,lat:1}]}
        ]);
        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].properties.kind).toBe('building');
        expect(fc.features[1].properties).toMatchObject({kind:'waterway',width_m:3.5,bridge:false,tunnel:false});
    });
});
