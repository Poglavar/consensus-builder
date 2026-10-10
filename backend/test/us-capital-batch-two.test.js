// Exercises the configured capital gateway and proposal binding without imported parcel tables.
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parcelSourceForCity, parcelSourceForIds, clearParcelSourceRuntimeCache } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding } from '../proposals/binding.js';
const samples = [
    {
        "city": "hartford",
        "sourceId": "us-ct-hartford-parcels",
        "native": "247451213",
        "center": [
            -72.6734,
            41.7658
        ],
        "attributes": {
            "OBJECTID": 71,
            "Parcel_ID": "247451213",
            "Town_Name": "Hartford"
        }
    },
    {
        "city": "dover",
        "sourceId": "us-de-kent-dover-parcels",
        "native": "2-05-07709-03-1500-00001",
        "center": [
            -75.5244,
            39.1582
        ],
        "attributes": {
            "OBJECTID": 71,
            "PIN": "2-05-07709-03-1500-00001",
            "COUNTY": "Kent"
        }
    },
    {
        "city": "atlanta",
        "sourceId": "us-ga-fulton-atlanta-parcels",
        "native": "14 007600021238",
        "center": [
            -84.388,
            33.749
        ],
        "attributes": {
            "OBJECTID": 71,
            "ParcelID": "14 007600021238"
        }
    },
    {
        "city": "honolulu",
        "sourceId": "us-hi-honolulu-parcels",
        "native": 121017020,
        "center": [
            -157.8581,
            21.3099
        ],
        "attributes": {
            "objectid": 71,
            "tmk": 121017020,
            "county": "Honolulu"
        }
    },
    {
        "city": "boise",
        "sourceId": "us-id-ada-boise-parcels",
        "native": "R0190710010",
        "center": [
            -116.2023,
            43.615
        ],
        "attributes": {
            "OBJECTID": 71,
            "PARCEL_ID": "R0190710010",
            "County": "Ada"
        }
    },
    {
        "city": "springfield",
        "sourceId": "us-il-springfield-parcels",
        "native": "22040426013",
        "center": [
            -89.6501,
            39.7817
        ],
        "attributes": {
            "OBJECTID": 71,
            "PIN": "22040426013"
        }
    },
    {
        "city": "baton_rouge",
        "sourceId": "us-la-ebr-baton-rouge-parcels",
        "native": "001-0170-2",
        "center": [
            -91.1871,
            30.4515
        ],
        "attributes": {
            "ID": 71,
            "ASSESSMENT_NUM": "001-0170-2"
        }
    },
    {
        "city": "augusta",
        "sourceId": "us-me-augusta-parcels",
        "native": "00026 00001 00000",
        "center": [
            -69.7795,
            44.3106
        ],
        "attributes": {
            "OBJECTID": 71,
            "MAP_BK_LOT": "00026 00001 00000",
            "TOWN": "Augusta"
        }
    },
    {
        "city": "annapolis",
        "sourceId": "us-md-annapolis-parcels",
        "native": 7143,
        "center": [
            -76.4922,
            38.9784
        ],
        "attributes": {
            "OBJECTID": 71,
            "PIN": 7143
        }
    },
    {
        "city": "boston",
        "sourceId": "us-ma-boston-current-parcels",
        "native": "F_775089_2955798",
        "center": [
            -71.0589,
            42.3601
        ],
        "attributes": {
            "OBJECTID": 71,
            "LOC_ID": "F_775089_2955798",
            "POLY_TYPE": "FEE",
            "MAP_PAR_ID": "0302644000"
        }
    }
];
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const context = { URLSearchParams, console }; context.window = context;
runInContext(read('../../frontend/js/city-config.js'), createContext(context));
const cities = context.CityConfigManager;
const require = createRequire(import.meta.url);
const route = require('../../frontend/js/parcels/route.js');
function fixture(s,d) {
    const [x,y] = s.center;
    const geometry={type:'Polygon',coordinates:[[[x,y],[x+.0001,y],[x+.0001,y+.0001],[x,y+.0001],[x,y]]]};
    const attributes={...s.attributes, OWNER_NAME:'Synthetic private attribute'};
    const row={type:'Feature',id:71,properties:attributes,geometry};
    const component={type:'Feature',id:72,properties:{...attributes,[d.objectIdField]:72},geometry:{type:'Polygon',coordinates:[[[x+.0003,y],[x+.0004,y],[x+.0004,y+.0001],[x+.0003,y+.0001],[x+.0003,y]]]}};
    const fetchImpl=vi.fn(async(input,options={})=>{
        const url=new URL(input); const params=options.method==='POST'?new URLSearchParams(options.body):url.searchParams;
        // Fixed scope must constrain geometry, manifest and exact reads alike.
        for(const [field,value] of Object.entries(d.attributeFilters||{})) {
            expect(params.get('where')).toContain(field);
            expect(params.get('where')).toContain("'"+String(value).replaceAll("'","''")+"'");
        }
        for(const [field,values] of Object.entries(d.attributeExclusions||{})) {
            expect(params.get('where')).toContain(field);
            for(const value of Array.isArray(values)?values:[values])expect(params.get('where')).toContain("'"+value+"'");
        }
        // The view sees one component; a native-key query must expand to both.
        const nativeQuery=params.get('where')?.includes(' IN (');
        const rows=d.nativeGeometryMode==='parts'&&nativeQuery?[row,component]:[row];
        if(params.has('returnCountOnly'))return new Response(JSON.stringify({count:rows.length}));
        if(params.has('returnIdsOnly'))return new Response(JSON.stringify({objectIdFieldName:d.objectIdField,objectIds:rows.map(r=>r.properties[d.objectIdField])}));
        if(params.get('where')?.includes(' IN ('))expect(params.get('where')).toContain(String(s.native));
        return new Response(JSON.stringify({type:'FeatureCollection',features:params.has('objectIds')?params.get('objectIds').split(',').map(Number).map(oid=>oid===71?row:component):rows,exceededTransferLimit:false}));
    });
    return {geometry,fetchImpl,bounds:[x-.0001,y-.0001,x+.0002,y+.0002],id:d.idPrefix+s.native};
}
afterEach(()=>{vi.unstubAllGlobals();clearParcelSourceRuntimeCache();});
describe.each(samples)('$city capital batch-two runtime',s=>{
    it('serves canonical viewport, exact-ID and footprint reads through the configured gateway',async()=>{
        const {descriptor:d}=parcelSourceForCity(s.city); const f=fixture(s,d);
        expect(d.id).toBe(s.sourceId);expect(parcelSourceForIds([f.id]).descriptor.id).toBe(s.sourceId);
        const app=express();app.use(express.json());setupParcelSourcesRoute(app,{sources:[d],fetchImpl:f.fetchImpl});
        const url='/parcel-sources/'+d.id;
        const viewport=await request(app).get(url).query({bbox:f.bounds.join(',')});
        const exact=await request(app).get(url).query({ids:f.id});
        const footprint=await request(app).post(url+'/under').send({geometry:f.geometry,srid:4326});
        for(const result of [viewport,exact,footprint]){
            expect(result.status).toBe(200);expect(result.body.complete).toBe(true);expect(result.body.features.map(row=>row.id)).toEqual([f.id]);
            expect(result.body.features[0].properties.sourceParcelId).toBe(String(s.native));
        }
        if(d.nativeGeometryMode==='parts') {
            expect(viewport.body.features[0].properties.sourcePartCount).toBe(2);
            expect(viewport.body.features[0].geometry.type).toBe('MultiPolygon');
        }
        expect(exact.body.absentIds).toEqual([]);expect(exact.body.features).toEqual(viewport.body.features);
        expect(viewport.body.features[0].properties.sourceProperties).not.toHaveProperty('OWNER_NAME');
    });
    it('binds to its source without a parcel-table query and routes the identity to its city',async()=>{
        const {descriptor:d}=parcelSourceForCity(s.city);const f=fixture(s,d);vi.stubGlobal('fetch',f.fetchImpl);
        const db={query:vi.fn(async()=>{throw Error('Unexpected imported parcel read');})};
        const {binding}=await computeBinding(db,{city:s.city,site:f.geometry});
        expect(db.query).not.toHaveBeenCalled();expect(binding).toMatchObject({coverage:'complete',source:'server:'+s.sourceId});
        expect(binding.parcels.map(row=>row.parcelId)).toEqual([f.id]);
        const previous=globalThis.CityConfigManager;globalThis.CityConfigManager=cities;
        try{expect(route.parcelIdToCityId(f.id)).toBe(s.city);}finally{globalThis.CityConfigManager=previous;}
        const city=cities.getCityConfig(s.city);expect(city.parcels.sourceId).toBe(s.sourceId);expect(city.buildings.source).toBe('osm');
        expect(city.projection.metricDefinition).toBeUndefined();
        for(const locale of ['en','es','hr','sr'])expect(JSON.parse(read('../../frontend/i18n/'+locale+'.json')).city.labels[s.city]).toBeTruthy();
    });
});
