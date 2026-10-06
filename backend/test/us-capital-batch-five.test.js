// Exercises the configured capital gateway and proposal binding without imported parcel tables.
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import proj4 from 'proj4';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parcelSourceForCity, parcelSourceForIds, clearParcelSourceRuntimeCache } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding } from '../proposals/binding.js';
const samples = [
  {
    "city": "carson_city",
    "sourceId": "us-nv-carson_city-parcels",
    "native": "00311313",
    "center": [
      -119.7674,
      39.1638
    ],
    "attributes": {
      "OBJECTID": 71,
      "PIN": "00311313",
      "County": "Carson City"
    }
  },
  {
    "city": "charleston",
    "sourceId": "us-wv-charleston-parcels",
    "native": "20110013000100000000",
    "center": [
      -81.6326,
      38.3498
    ],
    "attributes": {
      "OBJECTID": 71,
      "CleanParcelID": "20110013000100000000"
    }
  },
  {
    "city": "cheyenne",
    "sourceId": "us-wy-cheyenne-parcels",
    "native": "14663125900400",
    "center": [
      -104.8202,
      41.14
    ],
    "attributes": {
      "objectid": 71,
      "statepidn": "14663125900400",
      "accountno": "synthetic-identified-account"
    }
  },
  {
    "city": "columbia",
    "sourceId": "us-sc-columbia-parcels",
    "native": "08916-10-16",
    "center": [
      -81.0348,
      34.0007
    ],
    "attributes": {
      "objectid": 71,
      "tms": "08916-10-16"
    }
  },
  {
    "city": "harrisburg",
    "sourceId": "us-pa-harrisburg-parcels",
    "native": "06-016-053",
    "center": [
      -76.8867,
      40.2732
    ],
    "attributes": {
      "OBJECTID": 71,
      "PID": "06-016-053"
    }
  },
  {
    "city": "jackson",
    "sourceId": "us-ms-jackson-parcels",
    "native": "001840000001000000",
    "center": [
      -90.1848,
      32.2988
    ],
    "attributes": {
      "OBJECTID": 71,
      "PARNO": "001840000001000000"
    }
  },
  {
    "city": "madison",
    "sourceId": "us-wi-madison-parcels",
    "native": "070922101020",
    "center": [
      -89.4012,
      43.0731
    ],
    "attributes": {
      "OBJECTID": 71,
      "PARCELID": "070922101020",
      "CONAME": "DANE"
    }
  },
  {
    "city": "olympia",
    "sourceId": "us-wa-olympia-parcels",
    "native": "09850005000",
    "center": [
      -122.9007,
      47.0379
    ],
    "attributes": {
      "OBJECTID": 71,
      "PARCEL_NO": "09850005000",
      "STATUS_IND": "A"
    }
  },
  {
    "city": "providence",
    "sourceId": "us-ri-providence-parcels",
    "native": "240405",
    "center": [
      -71.4128,
      41.824
    ],
    "attributes": {
      "FID": 71,
      "CAMA_LINK": "240405"
    }
  },
  {
    "city": "tallahassee",
    "sourceId": "us-fl-tallahassee-parcels",
    "native": "2136252231785",
    "center": [
      -84.2807,
      30.4383
    ],
    "attributes": {
      "OBJECTID": 71,
      "TAXID": "2136252231785"
    }
  },
  {
    "city": "topeka",
    "sourceId": "us-ks-topeka-parcels",
    "native": "1330602013011000",
    "center": [
      -95.6752,
      39.0473
    ],
    "attributes": {
      "OBJECTID": 71,
      "PIN": "1330602013011000"
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
        for(const field of d.attributeNotNull||[])expect(params.get('where')).toContain(field+' IS NOT NULL');
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
describe.each(samples)('$city capital final batch runtime',s=>{
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
        const point=proj4('EPSG:4326',city.projection.metricDefinition,s.center);const restored=proj4(city.projection.metricDefinition,'EPSG:4326',point);
        restored.forEach((coordinate,i)=>expect(coordinate).toBeCloseTo(s.center[i],8));
        for(const locale of ['en','es','hr','sr'])expect(JSON.parse(read('../../frontend/i18n/'+locale+'.json')).city.labels[s.city]).toBeTruthy();
    });
});
