// Exercises recovered U.S. capital gateways and binding without imported parcel tables.
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
    "city": "frankfort",
    "sourceId": "us-ky-frankfort-parcels",
    "native": "061-00-00-103.00~103.18",
    "center": [
      -84.8733,
      38.2009
    ],
    "attributes": {
      "OBJECTID": 71,
      "PARCEL_ID": "061-00-00-103.00",
      "PARCEL": "103.18",
      "MAPNUM": "061-00-00-103.00",
      "MAP": "061",
      "BLOCK": null,
      "SOURCE_TYP": "DEED",
      "v_SY": 2017
    }
  },
  {
    "city": "oklahoma_city",
    "sourceId": "us-ok-oklahoma_city-parcels",
    "native": "R133563000",
    "center": [
      -97.5164,
      35.4676
    ],
    "attributes": {
      "OBJECTID": 71,
      "accountno": "R133563000",
      "pin": "synthetic-pin",
      "propertyid": 123
    }
  },
  {
    "city": "pierre",
    "sourceId": "us-sd-pierre-parcels",
    "native": "5000",
    "center": [
      -100.351,
      44.3683
    ],
    "attributes": {
      "FID": 71,
      "PARCEL_ID": "5000",
      "RECORD_": "5000"
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
        for(const field of d.attributeNull||[])expect(params.get('where')).toContain(field+' IS NULL');
        // The view sees one component; a native-key query must expand to both.
        const where=params.get('where')||'';
        const nativeQuery=d.idFields
            ? d.idFields.every(field=>where.includes(`${field} =`))
            : where.includes(`${d.idField} IN (`);
        const rows=d.nativeGeometryMode==='parts'&&nativeQuery?[row,component]:[row];
        if(params.has('returnCountOnly'))return new Response(JSON.stringify({count:rows.length}));
        if(params.has('returnIdsOnly'))return new Response(JSON.stringify({objectIdFieldName:d.objectIdField,objectIds:rows.map(r=>r.properties[d.objectIdField])}));
        if(nativeQuery) {
            if(d.idFields) {
                const values=String(s.native).split('~');
                expect(values).toHaveLength(d.idFields.length);
                d.idFields.forEach((field,index)=>{
                    const type=d.idFieldTypes[field];
                    const literal=type==='integer'?`${field} = ${values[index]}`:`${field} = '${values[index]}'`;
                    expect(where).toContain(literal);
                });
            } else expect(where).toContain(String(s.native));
        }
        return new Response(JSON.stringify({type:'FeatureCollection',features:params.has('objectIds')?params.get('objectIds').split(',').map(Number).map(oid=>oid===71?row:component):rows,exceededTransferLimit:false}));
    });
    return {geometry,fetchImpl,bounds:[x-.0001,y-.0001,x+.0002,y+.0002],id:d.idPrefix+s.native};
}
afterEach(()=>{vi.unstubAllGlobals();clearParcelSourceRuntimeCache();});
describe.each(samples)('$city recovered capital runtime',s=>{
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
