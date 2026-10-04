// Configured batch-seven sources exercise real factories, gateway routes and authoritative binding.
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseGmlParcels } from '../parcels/gml-parcel-reader.js';
import { createParcelSource, parcelSourceForCity, parcelSourceForIds, clearParcelSourceRuntimeCache } from '../parcels/sources.js';
import { setupParcelSourcesRoute } from '../routes/parcel-sources.js';
import { computeBinding } from '../proposals/binding.js';

afterEach(() => { clearParcelSourceRuntimeCache(); vi.unstubAllGlobals(); });
const cases = [
    { city: 'london', source: 'gb-hmlr-city-of-london', metric: 32630, crs: 27700, origin: [531000, 180500], native: '123', prefix: 'GB-HMLR-LONDON-' },
    { city: 'manchester', source: 'gb-hmlr-manchester', metric: 32630, crs: 27700, origin: [384000, 398000], native: '456', prefix: 'GB-HMLR-MANCHESTER-' },
    { city: 'madrid', source: 'es-dgc-inspire-cp-wfs', metric: 25830, crs: 25830, origin: [440000, 4474000], native: '1234567VK4713A', prefix: 'ES-DGC-' },
    { city: 'barcelona', source: 'es-dgc-inspire-cp-wfs', metric: 25831, crs: 25831, origin: [430000, 4582000], native: '1234567DF3813A', prefix: 'ES-DGC-' },
    { city: 'savar', source: 'bd-dlrs-dhamsona-bds-sheet-001', metric: 32646, native: '1', prefix: 'BD-DLRS-201901-4105-010510026-001-' }
];
async function fixture(sample, descriptor) {
    let bytes, geometry, bounds;
    if (sample.crs) {
        const [x,y] = sample.origin;
        const coordinates = `${x} ${y} ${x+10} ${y} ${x+10} ${y+10} ${x} ${y+10} ${x} ${y}`;
        const gb = sample.crs === 27700;
        const namespace = gb ? 'www.landregistry.gov.uk' : 'http://inspire.ec.europa.eu/schemas/cp/4.0';
        const name = gb ? 'PREDEFINED' : 'CadastralParcel', field = descriptor.idField;
        const xml = `<w:FeatureCollection xmlns:w="http://www.opengis.net/wfs/2.0" xmlns:p="${namespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><w:member><p:${name} g:id="transport-row"><p:${field}>${sample.native}</p:${field}><p:${gb?'GEOMETRY':'geometry'}><g:Polygon srsName="urn:ogc:def:crs:EPSG::${sample.crs}" srsDimension="2"><g:exterior><g:LinearRing><g:posList>${coordinates}</g:posList></g:LinearRing></g:exterior></g:Polygon></p:${gb?'GEOMETRY':'geometry'}></p:${name}></w:member></w:FeatureCollection>`;
        const parsed = await parseGmlParcels(xml,{idField:field});
        geometry = parsed.features[0].geometry;
        bounds = parsed.extent.map((v,i) => v+(i<2?-.00001:.00001));
        bytes = gb ? zipSync({'parcels.gml':strToU8(xml)}) : strToU8(xml);
    } else {
        const features = Array.from({length:108},(_,i) => {
            const x=90.224+(i%12)*.0002,y=23.966+Math.floor(i/12)*.0002;
            return {type:'Feature',properties:{Dag_No:String(i+1)},geometry:{type:'Polygon',coordinates:[[[x,y],[x+.00008,y],[x+.00008,y+.00008],[x,y+.00008],[x,y]]]}};
        });
        geometry=features[0].geometry;bounds=[90.22399,23.96599,90.22409,23.96609];
        bytes=strToU8(JSON.stringify({type:'FeatureCollection',features}));
    }
    const fetchImpl=vi.fn(async (value,options={}) => {
        const url=new URL(value);
        if (sample.crs===27700 && url.pathname==='/datasets/inspire/download') return new Response('official anonymous catalogue',{headers:{'Set-Cookie':'anonymous=fixture; Path=/; HttpOnly'}});
        if (sample.crs===27700 && url.hostname==='use-land-property-data.service.gov.uk' && options.redirect==='manual') return new Response(null,{status:302,headers:{Location:'https://datapub-prd-s3-bucket.s3.amazonaws.com/fixture.zip'}});
        return new Response(bytes,{headers:{'Content-Type':sample.crs===27700?'application/zip':sample.crs?'application/gml+xml':'application/json'}});
    });
    return {bytes,geometry,bounds,fetchImpl,id:sample.prefix+sample.native};
}

describe.each(cases)('$city batch-seven configured runtime',sample => {
    it('selects its published source and resolves exact native IDs through the longest prefix',async()=>{
        const {descriptor}=parcelSourceForCity(sample.city);
        expect(descriptor.id).toBe(sample.source);expect(descriptor.metricSrid).toBe(sample.metric);
        expect(parcelSourceForIds([sample.prefix+sample.native]).descriptor.id).toBe(sample.source);
        const f=await fixture(sample,descriptor),adapter=createParcelSource(descriptor,{fetchImpl:f.fetchImpl});
        const bounds=await adapter.queryBounds(f.bounds),exact=await adapter.queryIds([f.id]);
        expect(bounds).toMatchObject({complete:true,sourceId:sample.source});
        expect(bounds.features.map(v=>v.id)).toEqual([f.id]);expect(exact.absentIds).toEqual([]);expect(exact.features).toEqual(bounds.features);
        expect(exact.features[0].properties).toMatchObject({sourceParcelId:sample.native,sourceProperties:{[descriptor.idField]:sample.native}});
        if (sample.city==='savar') {
            expect(f.fetchImpl.mock.calls[0][1]).toMatchObject({method:'POST',body:'rsnum=201901&comcod=4105&unitcod=010510026&sheetno=001'});
            expect(descriptor.expectedSnapshotFeatures).toBe(108);
        }
        if (sample.crs===25830||sample.crs===25831) {
            expect(new URL(f.fetchImpl.mock.calls[0][0]).searchParams.get('srsName')).toBe('EPSG::'+sample.crs);
            expect(new URL(f.fetchImpl.mock.calls[0][0]).searchParams.has('count')).toBe(false);
        }
    });
    it('serves complete bbox, exact IDs and footprint through the gateway',async()=>{
        const {descriptor}=parcelSourceForCity(sample.city),f=await fixture(sample,descriptor);
        const app=express();app.use(express.json());setupParcelSourcesRoute(app,{sources:[descriptor],fetchImpl:f.fetchImpl});
        const path='/parcel-sources/'+sample.source;
        const bounds=await request(app).get(path).query({bbox:f.bounds.join(',')});
        const exact=await request(app).get(path).query({ids:f.id});
        const under=await request(app).post(path+'/under').send({geometry:f.geometry,srid:4326});
        for(const result of [bounds,exact,under]) {expect(result.status).toBe(200);expect(result.body.complete).toBe(true);expect(result.body.features.map(v=>v.id)).toEqual([f.id]);}
        expect(exact.body.absentIds).toEqual([]);
    });
    it('binds through the actual runtime transport without reading imported parcel tables',async()=>{
        const {descriptor}=parcelSourceForCity(sample.city),f=await fixture(sample,descriptor);
        vi.stubGlobal('fetch',f.fetchImpl);
        const db={query:vi.fn(async()=>{throw Error('Unexpected parcel database read');})};
        const {binding}=await computeBinding(db,{city:sample.city,site:f.geometry});
        expect(db.query).not.toHaveBeenCalled();expect(binding).toMatchObject({coverage:'complete',source:'server:'+sample.source});
        expect(binding.parcels.map(v=>v.parcelId)).toEqual([f.id]);
        if(sample.crs===27700) {
            expect(f.fetchImpl.mock.calls[0][0].toString()).toBe('https://use-land-property-data.service.gov.uk/datasets/inspire/download');
            expect(f.fetchImpl.mock.calls[1][1].headers.Cookie).toBe('anonymous=fixture');
            expect(f.fetchImpl.mock.calls[2][0].hostname).toBe('datapub-prd-s3-bucket.s3.amazonaws.com');
            expect(f.fetchImpl.mock.calls[2][1].headers).not.toHaveProperty('Cookie');
        }
    });
});
it('shares the Spanish runtime while resolving the binding projection per city',()=>{
    const madrid=parcelSourceForCity('madrid'),barcelona=parcelSourceForCity('barcelona');
    expect(madrid.adapter).toBe(barcelona.adapter);expect(madrid.descriptor.metricSrid).toBe(25830);expect(barcelona.descriptor.metricSrid).toBe(25831);
    expect(madrid.descriptor.metricSridByCity).toEqual({madrid:25830,barcelona:25831});
});
