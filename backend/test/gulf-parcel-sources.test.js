// Exercises Gulf and Jordan gateways and binding without imported parcel tables.
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
    "city": "doha",
    "sourceId": "qa-cgis-approved-cadastre",
    "native": "4290013",
    "center": [
      51.531,
      25.2854
    ],
    "attributes": {
      "OBJECTID": 71,
      "PIN": 4290013,
      "ENDDATE": null
    }
  },
  {
    "city": "dubai",
    "sourceId": "ae-dubai-dda-public-plots",
    "native": "JLT-PH2-A1",
    "center": [
      55.157,
      25.095
    ],
    "attributes": {
      "OBJECTID": 71,
      "PLOT_NUMBER": "JLT-PH2-A1"
    }
  },
  {
    "city": "amman",
    "sourceId": "jo-dls-cassini-mapserver",
    "native": "001001001000001",
    "center": [
      35.9602148481902,
      31.9836227976918
    ],
    "attributes": {
      "OBJECTID": 71,
      "DLS_KEY": "001001001000001",
      "PARCEL_ID": "1"
    }
  },
  {
    "city": "muscat",
    "sourceId": "om-muscat-mutrah-plots",
    "native": "153136~143",
    "center": [
      58.55548,
      23.59706
    ],
    "attributes": {
      "OBJECTID": 71,
      "PLOTUID": 153136,
      "NEWPLOTNO": "143",
      "PLOTNO": 332,
      "NEWHOUSINGAREACD": 101003,
      "NEWPHASECD": 17
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
        if(input==='https://gis.dda.gov.ae/dis/')return new Response('var AppSettings = '+JSON.stringify({PLOT_LAYER_URL:d.endpoint,AGSToken:'fixture-public-session'})+';');
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
            : where.includes(' IN (');
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
describe.each(samples)('$city Gulf and Jordan runtime',s=>{
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
