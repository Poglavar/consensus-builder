import { consumerParcelSourceId } from './helpers/frontend-source-selection.js';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parcelSourceCatalog, clearParcelSourceRuntimeCache } from '../parcels/sources.js';
import { parcelSourceForCity } from './helpers/frontend-source-selection.js';
import { computeBinding } from '../proposals/binding.js';
const context = { URLSearchParams, console }; context.window = context;
runInNewContext(readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url),'utf8'),context);
const manager = context.CityConfigManager;
const box=(x,y)=>({type:'Polygon',coordinates:[[[x,y],[x+.0001,y],[x+.0001,y+.0001],[x,y+.0001],[x,y]]]});

describe('official defaults for formerly imported cities',()=>{
    it('every supported cadastral city selects a configured source for both map and server binding',()=>{
        for(const city of manager.getAvailableCities()) {
            const p=manager.getCityConfig(city.id).parcels;
            if(p.source==='none') continue;
            if(p.source==='oss-wfs'||p.source==='parcel-nyc') continue;
            expect(p.source,city.id).toBe('parcel-source');
            const descriptor=parcelSourceCatalog.sources.find(s=>s.id===p.sourceId);
            expect(descriptor?.cityIds,city.id).toContain(city.id);
            expect(parcelSourceForCity(city.id,p.sourceId).descriptor.id).toBe(p.sourceId);
        }
    });
    it.each([
        ['belgrade','rs-rgz-dkp-parcels','SR-RGZ-DKP-',12345,'source_parcel_id',20.4388,44.8109],
        ['buenos_aires','ar-caba-idecaba-wfs-parcelas','AR-CABA-WFS-NAM-','02-012-003','nam',-58.3775,-34.6135]
    ])('uses %s official parcels for map lookup and save without imported tables',async(city,sourceId,prefix,native,idField,x,y)=>{
        clearParcelSourceRuntimeCache();
        const geometry=box(x,y);
        const descriptor=parcelSourceCatalog.sources.find(s=>s.id===sourceId);
        const feature={type:'Feature',id:'parcel.1',properties:{[idField]:native,parcel_num:'123/4',owner:'excluded'},geometry};
        const calls=[];
        vi.stubGlobal('fetch',vi.fn(async url=>{
            calls.push(new URL(url));
            return {ok:true,json:async()=>({type:'FeatureCollection',features:[feature],numberMatched:1,numberReturned:1,totalFeatures:1})};
        }));
        try {
            expect(manager.getCityConfig(city).parcels).toMatchObject({source:'parcel-source',sourceId,idPrefix:prefix,ownership:false});
            const provider=parcelSourceForCity(city);
            const result=await provider.adapter.queryIds([prefix+native]);
            expect(result.features[0].properties.sourceProperties).not.toHaveProperty('owner');
            const db={query:vi.fn(()=>{throw Error('Imported table must not be queried');})};
            const {binding}=await computeBinding(db,{ parcelSourceId: consumerParcelSourceId(city),city,site:geometry});
            expect(binding).toMatchObject({coverage:'complete',source:'server:'+sourceId,parcels:[{parcelId:prefix+native}]});
            expect(db.query).not.toHaveBeenCalled();
            if(city==='belgrade') {
                expect(calls[0].origin+calls[0].pathname).toBe(descriptor.proxyEndpoint);
                const upstream=new URL(calls[0].searchParams.get('url'));
                expect(upstream.origin+upstream.pathname).toBe(descriptor.endpoint);
                expect(upstream.searchParams.get('cql_filter')).toBe('source_parcel_id IN (12345)');
            }
        } finally {vi.unstubAllGlobals();clearParcelSourceRuntimeCache();}
    });
});
