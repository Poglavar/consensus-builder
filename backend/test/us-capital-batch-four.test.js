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
    "city": "albany",
    "sourceId": "us-ny-albany-parcels",
    "native": "01010007600700010010000000",
    "center": [
      -73.7562,
      42.6526
    ],
    "attributes": {
      "OBJECTID": 71,
      "SWIS_SBL_ID": "01010007600700010010000000",
      "COUNTY_NAME": "Albany"
    }
  },
  {
    "city": "raleigh",
    "sourceId": "us-nc-wake-raleigh-parcels",
    "native": "1703678831",
    "center": [
      -78.6382,
      35.7796
    ],
    "attributes": {
      "objectid": 71,
      "parno": "1703678831",
      "stcntyfips": "37183"
    }
  },
  {
    "city": "bismarck",
    "sourceId": "us-nd-burleigh-bismarck-parcels",
    "native": "1-064-005",
    "center": [
      -100.7837,
      46.8083
    ],
    "attributes": {
      "OBJECTID": 71,
      "GISID": "1-064-005",
      "CountyName": "Burleigh"
    }
  },
  {
    "city": "columbus",
    "sourceId": "us-oh-franklin-columbus-parcels",
    "native": "010-007484",
    "center": [
      -82.9988,
      39.9612
    ],
    "attributes": {
      "OBJECTID": 71,
      "PARCELID": "010-007484"
    }
  },
  {
    "city": "salem",
    "sourceId": "us-or-marion-salem-parcels",
    "native": "073W22DC04500",
    "center": [
      -123.0351,
      44.9429
    ],
    "attributes": {
      "OBJECTID": 71,
      "TAXLOT": "073W22DC04500"
    }
  },
  {
    "city": "nashville",
    "sourceId": "us-tn-nashville-parcels",
    "native": "09306100100",
    "center": [
      -86.7816,
      36.1627
    ],
    "attributes": {
      "OBJECTID": 71,
      "APN": "09306100100"
    }
  },
  {
    "city": "austin",
    "sourceId": "us-tx-austin-parcels",
    "native": "0205011101",
    "center": [
      -97.7431,
      30.2672
    ],
    "attributes": {
      "OBJECTID_1": 71,
      "PID_10": "0205011101"
    }
  },
  {
    "city": "salt_lake_city",
    "sourceId": "us-ut-salt-lake-city-parcels",
    "native": "15014290110000",
    "center": [
      -111.891,
      40.7608
    ],
    "attributes": {
      "OBJECTID": 71,
      "PARCEL_ID": "15014290110000",
      "County": "SaltLake"
    }
  },
  {
    "city": "montpelier",
    "sourceId": "us-vt-montpelier-parcels",
    "native": "405-126-11382",
    "center": [
      -72.5754,
      44.2601
    ],
    "attributes": {
      "OBJECTID": 71,
      "SPAN": "405-126-11382"
    }
  },
  {
    "city": "richmond",
    "sourceId": "us-va-richmond-parcels",
    "native": 5176000050747,
    "center": [
      -77.436,
      37.5407
    ],
    "attributes": {
      "OBJECTID": 71,
      "VGIN_QPID": 5176000050747
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
describe.each(samples)('$city capital batch-four runtime',s=>{
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
